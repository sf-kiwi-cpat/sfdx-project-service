# Review (Round 2) — SF Project Service

Review of `u/mtriantafelow/oauth-flow` at commit `b5d2b1c`.

---

## Checks

| Check | Result |
|:---|:---|
| `npx tsc --noEmit` | Clean |
| `npx eslint .` | Clean |
| `npm run build` | Clean |
| `npm test` | 124 pass, 1 flaky failure (125 total across 7 files, 1.09s) |

## Status of Round 1 Findings

### 1. ESLint error: unnecessary try/catch in refreshAccessToken — RESOLVED

The outer try/catch in `refreshAccessToken()` has been removed entirely. The function now has flat control flow with `clearSession()` called before the throw on the error path. ESLint reports zero errors.

**Evidence:** `src/oauth.ts:327-367` — no try/catch wrapper; `clearSession()` at line 352 before throw at line 353.

### 2. TokenResponse type assertion on unvalidated fetch response — RESOLVED

A `validateTokenResponse()` function (`src/oauth.ts:96-140`) now validates the response shape at runtime before use. It checks required fields (`access_token`, `token_type`) and conditionally validates exchange-specific fields (`instance_url`, `id`). Used in both `exchangeCodeForTokens()` (line 199) and `refreshAccessToken()` (line 357). Eight new test cases cover validation edge cases.

**Evidence:** `src/oauth.ts:96-140` — `asserts data is TokenResponse` type guard with field-by-field validation.

### 3. Duplicated write-lock guard pattern across route handlers — RESOLVED

A `requireWriteUnlocked()` middleware function (`src/routes.ts:22-33`) replaces the copy-pasted lock checks. Applied to POST /project/init, PUT /project/file, and DELETE /project/file. The OAuth callback retains its inline check (intentionally different — returns HTML, not RFC 9457 JSON).

**Evidence:** `src/routes.ts:22-33` — middleware definition; lines 122, 179, 205 — middleware applied to routes.

### 4. Hardcoded Salesforce API version string in multiple files — RESOLVED

`SF_API_VERSION` constant defined in `src/config.ts:51` and imported in both `src/oauth.ts:2` and `src/project.ts:4`. The `v` prefix is added at URL construction sites as recommended.

**Evidence:** `src/config.ts:51` — `export const SF_API_VERSION = '62.0'`; `src/oauth.ts:147` — `` `v${SF_API_VERSION}` ``; `src/project.ts:10` — `sourceApiVersion: SF_API_VERSION`.

### 5. OAuth callback returns HTTP 200 for all outcomes — RESOLVED

A JSDoc comment (`src/routes.ts:57-62`) now explains why 200 is used for all outcomes in the browser-redirect endpoint.

### 6. POST /project/init returns 201 instead of spec's 200 — UNRESOLVED

Still returns 201 at `src/routes.ts:144`. Spec alignment issue. Acceptable to leave if the spec is updated.

### 7. Chokidar watcher ignore pattern may not cover nested dotfile directories — UNRESOLVED

No change to `src/events.ts:25`. QA confirms the test is flaky (~66% fail rate), with ignored-path events leaking through intermittently.

### 8. Module-level mutable state in oauth.ts — ACKNOWLEDGED

Acceptable for the steel thread as noted in Round 1.

### 9. escapeHtml uses loose typing — UNRESOLVED (Low)

No change to `src/routes.ts:294-303`. Low severity.

### 10. Missing integration tests — PARTIALLY RESOLVED

+8 new tests (117 → 125), covering token validation and OAuth routes. Remaining gaps: GET /project/file for directories, lock API error paths, nested path traversal variants.

---

## Findings

### 1. validateTokenResponse allows refresh responses to silently skip instance_url/id validation

**Source:** Code Review
**Category:** Type Safety
**Severity:** Medium
**File:** `src/oauth.ts:124-139`

The validation function uses a heuristic: if *either* `instance_url` or `id` is present, validate both; if *neither* is present, skip both. A malformed exchange response omitting both fields would pass validation, and `handleCallback` would later call `parseIdUrl(tokenResponse.id)` on `undefined`, producing a confusing error instead of a clear validation failure.

**Evidence:**

```typescript
// oauth.ts:129 - if neither field present, validation skipped entirely
if (hasInstanceUrl || hasId) {
  // validate both
}
// But handleCallback at line 266 does:
const { orgId, userId } = parseIdUrl(tokenResponse.id);
// tokenResponse.id could be undefined if validation was skipped
```

The `asserts data is TokenResponse` claim is stronger than the runtime guarantee. A two-function approach (one for exchange, one for refresh) would make the type guarantee match reality.

### 2. Flaky test: chokidar ignored-path event filtering

**Source:** QA
**Category:** Bug
**Severity:** Medium
**File:** `src/events.test.ts:72-88`

The test "does not emit events for ignored paths" fails intermittently (~66% fail rate). A `change` event for an ignored directory leaks through. Likely a timing issue: the watcher may not have fully registered ignore patterns before writes occur, or the `**/.*` glob pattern conflicts with explicit patterns.

**Evidence:**

```
FAIL  src/events.test.ts > createProjectWatcher > does not emit events for ignored paths
AssertionError: expected [ { type: 'change', ...(1) } ] to have a length of 0 but got 1
```

Fix by waiting for chokidar's `ready` event before writing test files, or increasing the initialization wait.

### 3. Redundant variable assignment after validateTokenResponse in refreshAccessToken

**Source:** Code Review
**Category:** Code Smell
**Severity:** Low
**File:** `src/oauth.ts:356-358`

```typescript
const data = await response.json();
validateTokenResponse(data);
const tokenResponse = data;  // <-- redundant alias
```

After `validateTokenResponse(data)` narrows `data` to `TokenResponse`, the reassignment adds no value. `exchangeCodeForTokens()` correctly returns `data` directly. Remove the alias for consistency.

---

## Test Results

### Automated Tests

| Check | Result |
|:---|:---|
| `npm test` | 124 pass, 1 flaky fail (125 total across 7 files) |
| Test failures | `events.test.ts` — "does not emit events for ignored paths" (flaky, ~66% fail rate) |
| Test output quality | Clean — logger silenced, no noise |
| `npm run build` | Clean |
| Test duration | 1.09s |
| Test count change | +8 tests from Round 1 (117 → 125), all new tests in oauth.test.ts and routes.test.ts |

### Manual Test Results

Manual curl testing was not possible due to sandbox restrictions. Analysis is based on supertest integration tests in `routes.test.ts` (43 tests) and `oauth.test.ts` (29 tests), which exercise the full Express stack including middleware, routing, error handling, and RFC 9457 responses.

Key behavioral observations:
- Path traversal returns 400 with "Path escapes project root"
- Restricted paths return 400 with "Access to this path is restricted"
- OAuth authorize returns authorization URL with PKCE params (code_challenge, code_challenge_method=S256)
- OAuth callback returns HTML pages for all outcomes (success, error, missing params, lock held)
- OAuth status returns `{ authenticated: false }` when no session, full session details when authenticated
- OAuth disconnect returns 204 and clears session
- Write lock middleware blocks POST/PUT/DELETE with 409
- All error responses use `application/problem+json` with `status`, `title`, `detail` fields

---

## Security Verification

| Check | Status | Evidence |
|:---|:---|:---|
| Path traversal blocked | PASS | Integration tests verify 400 for `../../../etc/passwd` on PUT and DELETE |
| Restricted paths at all depths | PASS | Tests verify `.sf/auth.json` and `force-app/.git/config` return 400 |
| Tree/file filtering consistent | PASS | `buildTree()` and `isRestrictedPath()` share `shouldIgnoreEntry()` |
| Credentials not exposed | PASS | `/oauth/status` returns no `accessToken`; `.sf/` blocked from tree/file endpoints |
| Error message safety | PASS | `errorToProblem()` maps to safe messages; `escapeHtml()` prevents XSS |
| RFC 9457 compliance | PASS | All errors use `application/problem+json` with required fields |
| OAuth PKCE | PASS | SHA-256 + base64url, `code_challenge_method=S256` |
| OAuth state single-use | PASS | `pendingStates.delete(state)` before token exchange |
| OAuth loginUrl validation | PASS | Restricts to known SF domains, HTTPS required for non-localhost |
| Token response validation | PASS | `validateTokenResponse()` checks required fields; 8 unit tests |

---

## Implementation Notes

- **Finding #1** (validateTokenResponse heuristic): Split into `validateExchangeResponse` and `validateRefreshResponse`, or accept a `requiredFields` parameter. If splitting, update both call sites and their tests. The exchange variant should require all four fields; the refresh variant only `access_token` and `token_type`.
- **Finding #2** (flaky chokidar test): Wait for chokidar's `ready` event before writing test files. This changes the test setup, not the production code. Consider whether the `**/.*` glob pattern is redundant with `**/.git/**` and `**/.sf/**`.
- **Finding #3** (redundant alias): Simple deletion of one line. No side effects.
- **Interaction:** Findings #1 and #3 both touch `refreshAccessToken()`. If splitting the validator (Finding #1), the redundant alias (Finding #3) would be naturally eliminated.

---

## Summary

5 of 10 Round 1 findings are resolved. All static analysis checks pass. The write-lock middleware extraction, token validation, and API version constant are well implemented. Two new medium-severity findings: the `validateTokenResponse` heuristic that could allow malformed exchange responses through with confusing errors, and a flaky chokidar test. One low-severity code smell. Security posture is strong across all checks.

**Important:** Read all findings before addressing any — some interact with each other. See "Implementation Notes" section for second-order effects.
