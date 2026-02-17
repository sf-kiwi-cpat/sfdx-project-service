# Review (Round 3) — SF Project Service

Review of `u/mtriantafelow/oauth-flow` at commit `fb4af18`.

---

## Checks

| Check | Result |
|:---|:---|
| `npx tsc --noEmit` | Clean |
| `npx eslint .` | Clean |
| `npm run build` | Clean |
| `npm test` | 130 pass, 0 fail (7 files, 1.07s) |

## Status of Round 2 Findings

### 1. validateTokenResponse allows refresh responses to silently skip instance_url/id validation — RESOLVED

Split into `validateExchangeTokenResponse()` (`src/oauth.ts:95-116`) requiring all four fields (access_token, token_type, instance_url, id), and `validateRefreshTokenResponse()` (`src/oauth.ts:123-142`) requiring only access_token and token_type. The heuristic is gone. Exchange responses missing `instance_url`/`id` now fail immediately. A new test ("rejects exchange response missing both instance_url and id") directly covers the previously-broken case. +5 new tests for refresh validation edge cases.

**Evidence:** `src/oauth.ts:95-142` — two separate functions. `src/oauth.test.ts` — new `validateRefreshTokenResponse` describe block with 5 tests.

### 2. Flaky test: chokidar ignored-path event filtering — RESOLVED

Test now waits for chokidar's `ready` event before writing files (`src/events.test.ts:73`). The `ignored` option in `src/events.ts:21-32` was also changed from glob arrays to a function-based approach, which is more deterministic. All 130 tests pass with zero flaky failures.

**Evidence:** `src/events.test.ts:73` — `await new Promise<void>((resolve) => watcher.on('ready', resolve))` before writes. `src/events.ts:21-32` — function-based ignore logic.

### 3. Redundant variable assignment after validateTokenResponse in refreshAccessToken — RESOLVED

The `tokenResponse` alias is removed. `refreshAccessToken()` now uses `data` directly after `validateRefreshTokenResponse(data)` (`src/oauth.ts:358-363`).

**Evidence:** `src/oauth.ts:358-363` — `data.access_token` and `data.expires_in` used directly.

### Carried-Forward Issues from Earlier Rounds

| Issue | Round | Status | Notes |
|:---|:---|:---|:---|
| POST /project/init returns 201 instead of spec's 200 | R1 #6 | UNRESOLVED | `src/routes.ts:144` still returns 201 |
| escapeHtml uses loose typing | R1 #9 | UNRESOLVED (Low) | `src/routes.ts:294-303` unchanged |
| Missing integration tests (some gaps) | R1 #10 | PARTIALLY RESOLVED | +5 tests (125→130). Remaining: GET /project/file for directories, lock API error paths |
| Module-level mutable state in oauth.ts | R1 #8 | ACKNOWLEDGED | Acceptable for steel thread |

---

## Findings

### 1. Duplicated validation logic between validateExchangeTokenResponse and validateRefreshTokenResponse

**Source:** Code Review
**Category:** Maintainability
**Severity:** Low
**File:** `src/oauth.ts:95-142`

The two validation functions share identical structure: null check, `Record<string, unknown>` cast, field iteration with presence and type checks. The only difference is the list of required field names. This is 48 lines where a shared helper could reduce it to ~25.

**Evidence:**

```typescript
// Lines 95-116: validateExchangeTokenResponse
function validateExchangeTokenResponse(data: unknown): asserts data is TokenResponse {
  if (!data || typeof data !== 'object') {
    throw new OAuthError('Invalid token response: expected an object');
  }
  const response = data as Record<string, unknown>;
  const requiredFields = [ /* 4 fields */ ];
  for (const { name, type } of requiredFields) { /* check logic */ }
}

// Lines 123-142: validateRefreshTokenResponse — identical structure, 2 fields
function validateRefreshTokenResponse(data: unknown): asserts data is Pick<...> {
  if (!data || typeof data !== 'object') {
    throw new OAuthError('Invalid token response: expected an object');
  }
  const response = data as Record<string, unknown>;
  const requiredFields = [ /* 2 fields */ ];
  for (const { name, type } of requiredFields) { /* same check logic */ }
}
```

A private `validateFields(data: unknown, fields: ...)` helper could deduplicate the logic while each public function preserves its distinct `asserts` return type.

### 2. Chokidar ignored function has redundant checks subsumed by dotfile regex

**Source:** Code Review
**Category:** Code Smell
**Severity:** Low
**File:** `src/events.ts:21-31`

The explicit `/.git/`, `/.sf/` checks are all subsumed by the dotfile regex `/\/\.[^/]+(\/|$)/` on line 30, which matches any path segment starting with a dot. Only the `node_modules` checks add distinct behavior.

**Evidence:**

```typescript
ignored: (filePath: string) => {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized.includes('/node_modules/') ||
    normalized.includes('/.git/') ||       // matched by regex on line 30
    normalized.includes('/.sf/') ||        // matched by regex on line 30
    normalized.endsWith('/node_modules') ||
    normalized.endsWith('/.git') ||        // matched by regex on line 30
    normalized.endsWith('/.sf') ||         // matched by regex on line 30
    /\/\.[^/]+(\/|$)/.test(normalized)
  );
},
```

The redundant checks may serve as documentation of intent but could mislead maintainers. Consider adding a comment or simplifying to just regex + node_modules.

---

## Test Results

### Automated Tests

| Check | Result |
|:---|:---|
| `npm test` | 130 pass, 0 fail (7 files, 1.07s) |
| Test failures | None |
| Test output quality | Clean — no log noise |
| `npm run build` | Clean |
| Test count change | +5 tests from Round 2 (125 → 130), all in oauth.test.ts |

### Manual Test Results

Manual curl testing was not possible due to sandbox restrictions. Verification is based on the 130 automated tests (including 43 supertest integration tests in routes.test.ts and 34 OAuth tests) which exercise the full Express stack.

---

## Security Verification

| Check | Status | Evidence |
|:---|:---|:---|
| Path traversal blocked | PASS | Existing tests cover `../../../etc/passwd` variants |
| Restricted paths at all depths | PASS | Tests cover `.sf/auth.json` and `force-app/.git/config` |
| Credentials not exposed | PASS | `/oauth/status` returns no accessToken; `.sf/` blocked from tree/file |
| Error message safety | PASS | `errorToProblem()` maps to safe messages; `escapeHtml()` prevents XSS |
| RFC 9457 compliance | PASS | All errors use `application/problem+json` with status/title/detail |
| OAuth PKCE | PASS | SHA-256 + base64url, `code_challenge_method=S256` |
| OAuth state single-use | PASS | `pendingStates.delete(state)` before token exchange |
| OAuth loginUrl validation | PASS | Restricts to known SF domains, HTTPS required for non-localhost |
| Token response validation | PASS | Exchange requires all 4 fields; refresh requires only 2; malformed responses rejected |
| Chokidar ignore patterns | PASS | Function-based approach; test now stable |

---

## Implementation Notes

- **Finding #1** (duplicated validation): Extract a shared `validateFields` helper. Both public functions become one-liners delegating to the helper with their field lists. Preserves distinct `asserts` return types. Minor change — only two call sites today.
- **Finding #2** (redundant ignore checks): Either add a comment explaining the explicit checks exist for readability, or simplify to just `node_modules` + dotfile regex. No behavioral change either way.
- **No interactions** between the two findings — they can be addressed independently.

---

## Summary

All 3 Round 2 findings are resolved. The token validation split is clean and well-tested (+5 new tests, 130 total, 0 flaky). Static analysis is fully clean. Two new low-severity findings: duplicated validation logic and redundant chokidar ignore checks. Security posture remains strong across all checks. The codebase has improved steadily across three review rounds.
