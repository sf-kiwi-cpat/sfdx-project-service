# Review (Round 1) — SF Project Service

Review of `feat/oauth-flow` at commit `df39ebe`.

---

## Checks

| Check | Result |
|:---|:---|
| `npx tsc --noEmit` | Clean |
| `npx eslint .` | 1 error (`no-useless-catch` in oauth.ts:278) |
| `npm run build` | Clean |
| `npm test` | 117 tests pass across 7 files, zero failures (1.07s) |

---

## Findings

### 1. ESLint error: unnecessary try/catch in refreshAccessToken

**Source:** Code Review
**Category:** Code Smell
**Severity:** High
**File:** `src/oauth.ts:278-315` — `refreshAccessToken()`

ESLint reports `no-useless-catch` at line 278. The outer try/catch catches errors only to re-throw them. The comment says "clearSession already called in error path above, just re-throw" but the catch block adds no value.

**Evidence:**

```typescript
try {
    // ... fetch logic with its own error handling ...
  } catch (err) {
    // clearSession already called in error path above, just re-throw
    throw err;
  }
```

**Suggested approach:** Remove the outer try/catch entirely. The `clearSession()` call before `throw new OAuthError(...)` on line 300 already handles cleanup. If the intent is to ensure cleanup on *any* error, move `clearSession()` into a finally block.

---

### 2. TokenResponse type assertion on unvalidated fetch response

**Source:** Code Review
**Category:** Type Safety
**Severity:** Medium
**File:** `src/oauth.ts:146, 303` — `exchangeCodeForTokens()`, `refreshAccessToken()`

The token response from Salesforce is cast directly to `TokenResponse` with `as TokenResponse` without runtime validation. If the response shape is unexpected, the code will silently produce undefined values that propagate.

**Evidence:**

```typescript
return (await response.json()) as TokenResponse;
// Also at line 303:
const tokenResponse = (await response.json()) as TokenResponse;
```

**Suggested approach:** Add a lightweight validation function that checks required fields (`access_token`, `instance_url`, `id`) exist and are strings. Throw an `OAuthError` if validation fails.

---

### 3. Duplicated write-lock guard pattern across route handlers

**Source:** Code Review
**Category:** Maintainability
**Severity:** Medium
**File:** `src/routes.ts:100-106, 165-171, 199-205` — POST /project/init, PUT /project/file, DELETE /project/file

The write-lock check is copy-pasted across three route handlers (and the OAuth callback). Each instance has identical logic. The OAuth callback already has a slightly different message ("Server is busy") showing drift has begun.

**Evidence:**

```typescript
if (writeLock.isHeld()) {
  logger.warn({ path: req.path }, 'Write rejected: agent lock active');
  res.status(409).contentType(PROBLEM_JSON).json(
    problemDetail(409, 'Agent Active', 'Write operations are locked...')
  );
  return;
}
```

**Suggested approach:** Extract an Express middleware function (`requireWriteUnlocked`) that checks the lock and short-circuits with 409. Apply it to the relevant routes.

---

### 4. Hardcoded Salesforce API version string in multiple files

**Source:** Code Review
**Category:** Maintainability
**Severity:** Medium
**File:** `src/project.ts:10` and `src/oauth.ts:95`

The Salesforce API version `62.0` appears as a magic string in two files with no shared constant.

**Evidence:**

```typescript
// project.ts:10
sourceApiVersion: '62.0',
// oauth.ts:95
const url = `${instanceUrl}/services/data/v62.0/sobjects/Organization/${orgId}`;
```

**Suggested approach:** Define a `SF_API_VERSION` constant in `config.ts` and import it in both files.

---

### 5. OAuth callback returns HTTP 200 for all outcomes including errors

**Source:** Both
**Category:** Pattern Violation
**Severity:** Medium
**File:** `src/routes.ts:39-75` — `GET /oauth/callback`

The callback handler returns `200` for success, Salesforce errors, missing parameters, lock held, and token exchange failure. This is inconsistent with the RFC 9457 error pattern used by every other endpoint.

**Evidence:**

```typescript
// All error paths:
res.status(200).type('text/html').send(renderCallbackPage('Authentication Failed', ...));
```

**Suggested approach:** This is an acceptable tradeoff for a browser-redirect endpoint. Add a comment explaining why 200 is used for errors (browser UX) so future maintainers understand it is intentional.

---

### 6. POST /project/init returns 201 instead of spec's 200

**Source:** QA
**Category:** Spec Violation
**Severity:** Low
**File:** `src/routes.ts:128`

The spec says init returns "200, `{ ok: true }`" but implementation returns 201 with `{ ok: true, message: "..." }`.

**Suggested approach:** Decide whether to follow the spec exactly (200) or update the spec to reflect 201. Either way, align them.

---

### 7. Chokidar watcher ignore pattern may not cover nested dotfile directories

**Source:** QA
**Category:** Security Risk
**Severity:** Low
**File:** `src/events.ts:25`

The chokidar watcher uses `'**/.*'` to ignore dotfiles, but this glob may not recursively ignore files *inside* dotfile directories (e.g., `force-app/.hidden/secret.txt`). SSE events might leak the existence of files within nested dotfile directories.

**Suggested approach:** Verify chokidar behavior with nested dotfile directories. If events leak, add `'**/.*/**'` to the ignore list.

---

### 8. Module-level mutable state in oauth.ts makes testing fragile

**Source:** Code Review
**Category:** Maintainability
**Severity:** Low
**File:** `src/oauth.ts:40-58`

OAuth module uses module-level mutable state (`pendingStates` Map, `currentSession`). The `resetOAuthState()` export exists solely for testing — a code smell.

**Suggested approach:** Acceptable for the steel thread. If the service grows, consider an `OAuthService` class that encapsulates state, similar to `WriteLock`.

---

### 9. escapeHtml uses loose typing

**Source:** Code Review
**Category:** Type Safety
**Severity:** Low
**File:** `src/routes.ts:294-303` — `escapeHtml()`

The `map` object is typed as `{ [key: string]: string }` which is wider than necessary. The function works correctly but won't catch mismatches between regex and map keys.

**Suggested approach:** Use a well-tested library for HTML escaping, or tighten the typing.

---

### 10. Missing integration tests for several test plan scenarios

**Source:** QA
**Category:** Test Coverage
**Severity:** Low

The following test plan scenarios lack HTTP-level integration tests (underlying code is correct but untested at the API level):

- GET /project/file when path is a directory (test plan #17)
- DELETE /project/file while lock held (test plan #33)
- Lock API error paths: double acquire, wrong/missing ID for renew/release (test plan #41, 43-47)
- Nested path traversal variants (test plan #15-16)
- Nested restricted paths for dotfiles and node_modules (test plan #18c, 18d, 23b, 31b)

**Suggested approach:** Add integration tests for these scenarios to verify RFC 9457 response shapes at the HTTP level.

---

## Test Results

### Automated Tests

| Check | Result |
|:---|:---|
| `npm test` | 117 tests pass across 7 test files |
| Test failures | None |
| Test output quality | Clean — logger silenced, no noise |
| `npm run build` | Clean |
| Test duration | 1.07s |

### Manual Test Results

Manual curl testing was not possible due to sandbox restrictions. Analysis based on supertest integration tests and source code review. See the QA draft for the full test matrix coverage table (40+ test plan scenarios verified via automated tests, ~25 scenarios not explicitly covered).

---

## Security Verification

| Check | Status | Evidence |
|:---|:---|:---|
| Path traversal blocked | PASS | `resolveProjectPath()` uses `path.resolve` + `relative.startsWith('..')` check. Tested for `../../../etc/passwd`. |
| Restricted paths at all depths | PASS | `isRestrictedPath()` checks `segments.some(shouldIgnoreEntry)`. Tests verify both top-level and nested. |
| Tree/file filtering consistent | PASS | Both `buildTree()` and `isRestrictedPath()` share `shouldIgnoreEntry()` — single source of truth. |
| Credentials not exposed | PASS | `.sf/` excluded from tree and file endpoints. OAuth tokens not logged. |
| Error message safety | PASS | `errorToProblem()` maps to safe messages. No stack traces in responses. |
| RFC 9457 compliance | PASS | All error responses use `application/problem+json` with `status`, `title`, `detail`. |
| OAuth state single-use | PASS | `pendingStates.delete(state)` called before token exchange. |
| OAuth PKCE | PASS | SHA-256 + base64url, `code_challenge_method=S256`. |
| OAuth XSS prevention | PASS | `escapeHtml()` applied to all rendered parameters. |
| OAuth loginUrl validation | PASS | Restricted to known Salesforce domains, HTTPS required for non-localhost. |
| Pending state TTL cleanup | PASS | 60s cleanup timer with `.unref()`. |

---

## Implementation Notes

When addressing these findings, consider the following second-order effects:

1. **Finding #1 (useless try/catch):** Simply removing the try/catch is safe. If you want cleanup-on-any-error, a `finally` block would need careful thought about which errors should trigger `clearSession()` vs. which shouldn't.

2. **Finding #2 (token validation):** A new `validateTokenResponse()` function will need its own unit tests. Consider what error type to throw — `OAuthError` is appropriate. The validation should handle both the initial exchange and the refresh flow.

3. **Finding #3 (write-lock middleware):** Extracting middleware affects how routes are registered. The OAuth callback has a slightly different message ("Server is busy" vs "Agent Active") — decide whether to unify the message or parameterize the middleware. This interacts with Finding #5 (OAuth callback 200 pattern) since the callback currently handles lock-held inline.

4. **Finding #4 (API version constant):** Straightforward extraction. Note that `sourceApiVersion` in sfdx-project.json is a string (`'62.0'`) while the REST URL needs a `v` prefix (`v62.0`) — the constant should be just `'62.0'` with the `v` prefix added at the URL construction site.

5. **Finding #7 (chokidar dotfiles):** If you add `'**/.*/**'` to the ignore list, verify it doesn't interfere with the existing `'**/.*'` pattern. Test with actual file creation in a `.hidden/` directory.

6. **Finding #10 (missing tests):** Adding integration tests is independent work. Lock API tests will need setup/teardown of lock state. Nested restricted path tests need the temp directory fixture to include those paths.

---

## Summary

The codebase is well-organized, readable, and follows consistent patterns. All 117 tests pass, the build is clean, and the security posture is strong across all checked vectors (path traversal, restricted paths, credentials, OAuth PKCE, XSS prevention, loginUrl validation).

The highest-priority item is **Finding #1** (ESLint error) — it's the only lint error and blocks clean CI. **Finding #2** (unvalidated token response) is the most impactful for reliability. The remaining findings are medium-to-low severity improvements.

**Important:** Read all findings before addressing any — some interact with each other (e.g., Finding #3 and #5 both touch the OAuth callback handler). Consider second-order effects of each fix (see Implementation Notes).
