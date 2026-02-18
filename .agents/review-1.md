# Review (Round 1) — SF Project Service

Review of `u/mtriantafelow/I-6/sf-home-auth-isolation` at commit `2029d61`.

---

## Checks

| Check | Result |
|:---|:---|
| `npx tsc --noEmit` | Pass — no type errors |
| `npx eslint .` | Pass — no warnings or errors |
| `npm run build` | Not applicable (no build script) |
| `npm test` | **Pass — 132/132 tests, 8 files** |

---

## Does the Fix Address Issue #6?

**Yes — the core fix is mechanically correct.** Issue #6 identified that `connectOrg()` was setting `process.env.SF_HOME`, which `@salesforce/core` never reads. The library resolves its global state directory via `os.homedir()`, which on POSIX reads `HOME`. The fix correctly replaces `SF_HOME` with `HOME`, guarded by `try/finally` and serialized by a promise-chaining mutex.

Supporting evidence from `@salesforce/core` internals:
- `global.js:99`: `path.join(os.homedir(), Global.SFDX_STATE_FOLDER)` — reads `HOME`, not `SF_HOME`
- `configFile.js:96`: calls `homedir()` directly
- `StateAggregator.clearInstance()` before `AuthInfo.create()` is the correct mechanism to force re-evaluation of `Global.DIR` under the new `HOME`

The fix is a real improvement. However, it does not fully resolve the architectural risk the issue flagged ("mutating HOME in a concurrent HTTP server is risky"). See Finding 1.

---

## Findings

### 1. HOME mutation is not process-safe — the mutex only serializes `connectOrg` calls against each other

**Source:** QA
**Category:** Bug
**Severity:** High
**File:** `src/project.ts:57–79`

`process.env.HOME` is a process-global variable. The mutex ensures that two concurrent `POST /project/init` requests do not overlap inside `_connectOrg`. But during the window between `process.env.HOME = sfHome` and the `finally` restoration, the event loop can yield to any other concurrent request handler. Any code running in those yield points that calls `os.homedir()` — including `@salesforce/core` internals triggered by other endpoints — will read the tampered `HOME`.

In the current codebase this is low-risk (only `connectOrg` reaches `@salesforce/core`), but the architectural issue flagged by issue #6 is unresolved. The mutex narrows the race window; it does not close it.

**Evidence:**
```typescript
process.env.HOME = sfHome;        // line 58 — process-global mutation
try {
  StateAggregator.clearInstance();
  const authInfo = await AuthInfo.create(...);   // yields here
  await authInfo.save();                          // yields here
  await authInfo.setAsDefault(...);               // yields here
} finally {
  // HOME restored only after all three awaits complete
  process.env.HOME = priorHome;
}
```

Other concurrent request handlers (`GET /project/tree`, `PUT /project/file`, `GET /oauth/callback`) can execute during any of those yields.

**Recommendation:** This branch should merge with an issue filed (or the existing issue #6 updated) to track the long-term resolution: option 2 from issue #6 (`StateAggregator` v8 per-directory API) or option 3 (container-level HOME mount). Add a code comment acknowledging the remaining concurrency scope:

```typescript
// NOTE: HOME is a process-global. The mutex above serializes _connectOrg calls
// against each other, but other concurrent request handlers may observe the
// mutated HOME during the awaits below. Safe for the current codebase because
// only connectOrg calls @salesforce/core. Track follow-up: <issue link>.
```

**Second-order effects:** Comment-only until the architectural fix is pursued. The architectural fix (StateAggregator per-call API) would eliminate the need for the mutex entirely.

---

### 2. `clearInstance()` ordering is load-bearing but undocumented

**Source:** Code Review
**Category:** Maintainability
**Severity:** Medium
**File:** `src/project.ts:61`

`StateAggregator.clearInstance()` is called with no arguments. Its signature uses a default parameter:

```typescript
static clearInstance(path = global_1.Global.DIR): void
```

`Global.DIR` is a getter that calls `os.homedir()` at evaluation time. Because `HOME` is already set to `sfHome` on line 58 before `clearInstance()` is called on line 61, the default argument resolves to `<project>/.sf/.sfdx` — the correct key to evict. This is the right behavior.

However, the correctness relies on an ordering that is not obvious: `HOME` must be set **before** calling `clearInstance()`. A future reader might move `clearInstance()` above the `HOME` assignment (plausibly reasoning "clear the old instance before changing HOME") and silently break isolation — the code would still compile and tests would still pass.

**Evidence:**
```typescript
process.env.HOME = sfHome;        // line 58 — must come FIRST
try {
  StateAggregator.clearInstance();  // line 61 — default arg reads HOME here
```

**Recommendation:** Add an inline comment making the ordering constraint explicit:

```typescript
// HOME is already set to sfHome above, so Global.DIR now resolves to
// <sfHome>/.sfdx. clearInstance() must come after the HOME assignment.
StateAggregator.clearInstance();
```

**Second-order effects:** None — documentation only.

---

### 3. `connectMutex` module-level state is not reset between tests

**Source:** Both (Code Review Finding 2, QA Finding 4)
**Category:** Maintainability
**Severity:** Medium
**File:** `src/project.ts:7`, `src/project.test.ts:afterEach`

`connectMutex` is a module-level variable that persists across all tests in the same vitest worker. The `afterEach` hook correctly restores `process.env.HOME` and `process.env.PROJECT_ROOT`, but does not reset the mutex chain. If a test leaves the mutex in an unusual state (e.g., from a mid-chain mock error), subsequent tests are silently queued behind it.

The `.catch(() => {})` guard prevents permanent blocking, but creates hidden coupling between tests that will become harder to debug as the test suite grows.

**Evidence:**
```typescript
// project.ts — module-level, outlives each test
let connectMutex: Promise<void> = Promise.resolve();

// project.test.ts — afterEach does not reset connectMutex
afterEach(async () => {
  process.env.PROJECT_ROOT = originalProjectRoot;
  // HOME restored ✓
  // connectMutex not reset ✗
  await fs.rm(tmpDir, { recursive: true, force: true });
});
```

**Recommendation:** The idiomatic vitest approach is `vi.resetModules()` in `beforeEach` to get a fresh module instance per test. A simpler alternative is to export a `resetConnectMutex()` test-seam function. Either option should be applied before adding more tests against `connectOrg`.

**Second-order effects:** `vi.resetModules()` would require re-applying `vi.mock('@salesforce/core', ...)` inside each test or in a `beforeEach`, which requires minor test restructuring.

---

### 4. Tests verify the mechanism (HOME is set) but not the behavioral outcome (auth files land in project directory)

**Source:** QA
**Category:** Spec Violation
**Severity:** Medium
**File:** `src/project.test.ts`

The test `'sets HOME to project .sf so auth files land in project-scoped directory'` embeds an assertion inside the `AuthInfo.create` mock to confirm that `HOME` equals `expectedSfHome` at call time, and verifies `HOME` is restored afterward. This is correct.

However, because `@salesforce/core` is fully mocked, no files are ever written. The test cannot verify the behavioral claim: that auth credentials land in `<project>/.sf/.sfdx/` rather than in the real `~/.sfdx/`. A reader cannot reverse-engineer the intended behavior from the test — only that `HOME` is temporarily set.

**Evidence:**
```typescript
vi.mock('@salesforce/core', () => ({
  AuthInfo: {
    create: vi.fn().mockImplementation(async () => {
      expect(process.env.HOME).toBe(expectedSfHome);  // verifies mechanism ✓
      return {
        save: vi.fn().mockResolvedValue(undefined),   // no file write ✗
        setAsDefault: vi.fn().mockResolvedValue(undefined),
      };
    }),
  },
  StateAggregator: { clearInstance: vi.fn() },
}));
```

**Recommendation:** Add a test comment documenting why a full integration test is not feasible (no real org, `@salesforce/core` spin-up complexity). Alternatively, add a `.skip`-annotated integration test stub showing what the behavioral test *would* verify:

```typescript
// Integration test (requires real @salesforce/core, no mock):
// Verify that after connectOrg(), auth file exists at <tmpDir>/.sf/.sfdx/<username>.json
// and NOT at ~/.sfdx/<username>.json.
```

**Second-order effects:** No code change required if the comment approach is taken.

---

### 5. `clearInstance()` (non-async) used where `clearInstanceAsync()` exists — rationale undocumented

**Source:** Code Review
**Category:** Maintainability
**Severity:** Low
**File:** `src/project.ts:61`

`@salesforce/core`'s `StateAggregator` includes the following note on `clearInstance()`:

```
NOTE: This call is NOT thread-safe, so it should only be called when no other threads are using the StateAggregator.
```

A thread-safe alternative (`clearInstanceAsync()`, which acquires `StateAggregator`'s own internal mutex) exists. Using `clearInstance()` is acceptable here because `_connectOrg` is already serialized by `connectMutex` — no concurrent `StateAggregator.getInstance()` calls can be in flight. But this rationale is not documented, and a future reviewer might question whether the non-async variant should be replaced.

**Recommendation:** Add a comment:

```typescript
// clearInstance() (not clearInstanceAsync()) is safe here: connectMutex ensures
// no concurrent getInstance() calls are in flight during _connectOrg.
StateAggregator.clearInstance();
```

**Second-order effects:** None if kept as-is. Switching to `clearInstanceAsync()` would require one `await` and is also acceptable.

---

### 6. Concurrency test doesn't prove serialization

**Source:** QA
**Category:** Maintainability
**Severity:** Low
**File:** `src/project.test.ts:59–72`

The test `'serializes concurrent connectOrg calls via mutex'` asserts `AuthInfo.create` was called twice. A broken implementation that called `_connectOrg` in parallel would pass the same assertion. The test does not verify that call 2 waited for call 1 to complete.

**Evidence:**
```typescript
await Promise.all([
  connectOrg({ accessToken: 'token-1', instanceUrl: 'https://org1.salesforce.com' }),
  connectOrg({ accessToken: 'token-2', instanceUrl: 'https://org2.salesforce.com' }),
]);
expect(AuthInfo.create).toHaveBeenCalledTimes(2);  // does not prove ordering
```

The mutex implementation itself is correct. The test gap means a regression that removed the mutex would not be caught by this test.

**Recommendation:** Strengthen the test to verify ordering, e.g., by using a mock that stalls and tracking call order, or by asserting `HOME` never has two simultaneous values. At minimum, add a comment: "This test asserts both calls complete but does not assert they were sequential. The mutex implementation is verified structurally."

**Second-order effects:** None until the test is strengthened.

---

### 7. `routes.test.ts` doesn't assert `clearInstance()` is called before `AuthInfo.create()`

**Source:** QA
**Category:** Spec Violation
**Severity:** Low
**File:** `src/routes.test.ts:14–19`

`StateAggregator: { clearInstance: vi.fn() }` was correctly added to the route-level mock. But no test asserts that `clearInstance()` is called, let alone that it precedes `AuthInfo.create()`. If `clearInstance()` were accidentally removed from `project.ts`, all tests would still pass.

**Recommendation:** Add an assertion in `project.test.ts` (where `connectOrg` is directly tested):

```typescript
expect(StateAggregator.clearInstance).toHaveBeenCalledBefore(AuthInfo.create as vi.Mock);
```

**Second-order effects:** Requires vitest's `toHaveBeenCalledBefore` or a manual call-order check. Minor test change.

---

### 8. `expect(process.env.HOME).toBe(originalHome ?? undefined)` is a no-op expression

**Source:** Code Review
**Category:** Readability
**Severity:** Low
**File:** `src/project.test.ts:56`

`originalHome` is typed `string | undefined`. The expression `originalHome ?? undefined` always evaluates to `originalHome` (the `?? undefined` fallback is unreachable for this type). The assertion is correct but unnecessarily noisy.

**Recommendation:**
```typescript
// Before
expect(process.env.HOME).toBe(originalHome ?? undefined);
// After
expect(process.env.HOME).toBe(originalHome);
```

**Second-order effects:** None.

---

### 9. `sfHome` variable name implies it is the `.sf` directory, but it is used as a synthetic HOME

**Source:** Code Review
**Category:** Readability
**Severity:** Low
**File:** `src/project.ts:53`

The variable is named `sfHome` and points to `path.join(projectPath, '.sf')`. It is used as the `HOME` override, so `@salesforce/core` writes auth files to `<projectPath>/.sf/.sfdx/<username>.json` — one level deeper than the name suggests. The existing comment "Uses project's .sf directory for config" reinforces the misleading framing.

**Recommendation:** Rename to `projectHome` or `syntheticHome` and update the comment:

```typescript
// Use the project's .sf directory as a synthetic HOME so @salesforce/core
// writes auth files to .sf/.sfdx/<username>.json (project-scoped, not ~/.sfdx/).
const projectHome = path.join(projectPath, '.sf');
```

**Second-order effects:** Internal rename — no behavior change.

---

## Test Results

### Automated Tests
| Check | Result |
|:---|:---|
| `npm test` | 132/132 passed across 8 test files |
| `npx tsc --noEmit` | Pass |
| `npx eslint .` | Pass (no output) |
| New tests in `project.test.ts` | 2/2 passed |
| `routes.test.ts` regression | 43/43 passed |

### Manual Test Results

No server was started for manual curl testing. The change is isolated to `connectOrg()` and `_connectOrg()` — the request-handling surface (routes, input validation, error format) is unchanged. Manual testing of auth file placement would require a real Salesforce org credential, which is not available in this environment.

---

## Security Verification

| Check | Status | Evidence |
|:---|:---|:---|
| Path traversal blocked | Pass (unchanged) | `resolveProjectPath` unchanged; no new path handling in diff |
| Credentials not exposed in logs | Pass | No new logging of `accessToken`, `refreshToken`, or `HOME` value |
| Error message safety | Pass | Error handling unchanged |
| RFC 9457 compliance | Pass | No changes to error format |
| HOME value leaked in error response | Pass | `try/finally` ensures `HOME` is restored even on error; error message does not include `HOME` value |
| Concurrent HOME mutation | **Partial** — see Finding 1 | Mutex narrows window; process-global risk remains |

---

## Implementation Notes

- **Finding 1** (process-safe HOME): The recommended immediate action is a code comment acknowledging the scope. The architectural fix (StateAggregator v8 API) should be a separate tracked issue. If pursued, it would eliminate the mutex entirely — coordinate with Finding 3.
- **Finding 2** and **Finding 5** (clearInstance ordering/safety): Both are comment-only changes. They can be done in a single pass.
- **Finding 3** (mutex not reset between tests): If `vi.resetModules()` is used, the `vi.mock('@salesforce/core', ...)` call must move inside `beforeEach` or a setup function. This is a meaningful test restructure — do it before adding more tests, not urgently before merge.
- **Finding 4** (tests don't verify file placement): A comment explaining the limitation is the practical fix. A full integration test is a separate undertaking.
- **Findings 6, 7, 8, 9**: Small, independent — can be batched in a single cleanup commit.
- **Interaction between Findings 1 and 6**: If Finding 1's architectural fix (StateAggregator v8 API) is implemented, the mutex becomes unnecessary and the test for it (Finding 6) is moot. Address Finding 1 architecturally before investing in strengthening the mutex test.

---

## Summary

The fix correctly solves the core bug from issue #6: switching `SF_HOME` to `HOME` and adding `StateAggregator.clearInstance()` are the right mechanical changes, all tests pass, and no type or lint errors exist. **The branch can merge.**

The most important pre-merge action is filing a follow-up issue for Finding 1 (the mutex does not make `HOME` mutation truly process-safe) with a code comment acknowledging the scope. Findings 2–3 (undocumented ordering constraints) are low-effort comment additions worth doing before merge. The remaining findings are cleanup that can ship in a follow-up.

**Priority before merge:** File follow-up issue for Finding 1 and add the comment. Add comments for Findings 2 and 5. Everything else is post-merge cleanup.
