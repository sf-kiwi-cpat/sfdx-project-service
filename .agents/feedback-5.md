# Code Review (Round 5) — SF Project Service

Static analysis of the `feat/oauth-flow` branch (HEAD commit `c68f6dc` — "Merge branch 'main' into feat/oauth-flow") covering the new OAuth feature.

---

## Static Analysis

| Check | Result |
|:---|:---|
| `npx tsc --noEmit` | Clean (zero errors) |
| `npx eslint .` | Clean (zero errors) |
| `npm run build` | Clean |
| `npm test` | 96 tests pass (6 test files) |

---

## Code Quality Findings

### 1. OAuth errors thrown as plain `Error` instead of `OAuthError`

**Category:** Type Safety

**Severity:** High

**File:** `src/oauth.ts:123,136-137,166-168,237-238,261` — multiple functions

The codebase defines an `OAuthError` class in `src/errors.ts` and `errorToProblem()` maps it to a 400 response. However, the OAuth module never uses it. Every error thrown in `oauth.ts` is a plain `Error`:

**Evidence:**

```typescript
// src/oauth.ts:123
throw new Error(`Token exchange failed: ${response.status} ${errorText}`);

// src/oauth.ts:136-137
throw new Error('OAuth is not configured. Set SF_CLIENT_ID and SF_CLIENT_SECRET environment variables.');

// src/oauth.ts:166-168
throw new Error('Invalid or expired state parameter');

// src/oauth.ts:237-238
throw new Error('No refresh token available');

// src/oauth.ts:261
throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
```

**Why this matters:**

The `OAuthError` class exists but is dead code — it is never constructed anywhere. This defeats the purpose of the typed error hierarchy that was established in prior reviews (Round 4). If any of these errors propagate through the Express error handler in `app.ts`, they will hit the catch-all `500 Internal Server Error` branch of `errorToProblem()` instead of the `OAuthError` branch that returns a proper `400 OAuth Error`. The route handlers in `routes.ts` catch some of these errors manually, but `refreshAccessToken()` errors would be untyped if called from a future route.

**Suggested approach:**

Replace `new Error(...)` with `new OAuthError(...)` in all OAuth functions. Import `OAuthError` from `./errors.js`. This aligns with the project pattern where file operations use `FileNotFoundError`, `RestrictedPathError`, etc.

---

### 2. `parseIdUrl()` try/catch is a no-op — string splitting never throws

**Category:** Code Smell

**Severity:** Medium

**File:** `src/oauth.ts:60-69` — `parseIdUrl()`

**Evidence:**

```typescript
function parseIdUrl(idUrl: string): { orgId: string; userId: string } {
  try {
    const parts = idUrl.split('/');
    const userId = parts[parts.length - 1];
    const orgId = parts[parts.length - 2];
    return { orgId, userId };
  } catch {
    throw new Error(`Failed to parse id URL: ${idUrl}`);
  }
}
```

**Why this matters:**

`String.prototype.split()` never throws. If `idUrl` is an empty string or malformed, `parts[parts.length - 1]` will be `""` and `parts[parts.length - 2]` will be `undefined`. The function will silently return `{ orgId: undefined, userId: "" }` — which violates the return type `{ orgId: string; userId: string }` (TypeScript will not catch this at runtime). The try/catch provides a false sense of safety.

**Suggested approach:**

Remove the try/catch. Instead, validate the result: check that `orgId` and `userId` are truthy strings before returning. Throw an `OAuthError` if they are not. This turns a silent bad-data bug into an explicit, catchable error.

---

### 3. `pendingStates` map grows without bound — no cleanup of unused states

**Category:** Maintainability

**Severity:** Medium

**File:** `src/oauth.ts:35` — `pendingStates`

**Evidence:**

```typescript
const pendingStates = new Map<string, string>();
```

Each call to `generateAuthorizationUrl()` adds an entry. Entries are deleted on successful callback (`pendingStates.delete(state)` on line 169). But if a user requests an authorization URL and never completes the callback (e.g., closes the browser tab, navigates away), the entry stays in the map forever.

**Why this matters:**

In production, this is a memory leak. If the service runs for weeks (expected in a container), abandoned authorization attempts accumulate without bound. While each entry is small (~100 bytes), it is also an information leak: the code verifiers persist longer than necessary, which weakens the security posture of PKCE.

**Suggested approach:**

Add a TTL to pending states. A simple approach: store `{ codeVerifier, createdAt }` instead of just the verifier, and either (a) check TTL in `handleCallback()` and reject expired states, or (b) run a periodic cleanup interval. A 10-minute TTL is typical for OAuth state parameters.

---

### 4. Callback handler is 80 lines with 4 duplicated HTML templates

**Category:** Maintainability / Code Smell

**Severity:** Medium

**File:** `src/routes.ts:39-119` — `GET /oauth/callback` handler

The callback route handler contains four nearly identical HTML response blocks (lines 46-56, 63-73, 77-87, 108-117) and one success block (lines 97-105). Each block is a full HTML page with the same structure, differing only in the message.

**Evidence:**

```typescript
// Pattern repeated 4 times for errors + 1 time for success:
res.status(200).type('text/html').send(`
  <html>
    <head><title>Authentication Failed</title></head>
    <body>
      <h1>Authentication Failed</h1>
      <p>${escapeHtml(errorMsg)}</p>
      <p>You can close this tab.</p>
    </body>
  </html>
`);
```

**Why this matters:**

The duplication makes the handler long (~80 lines) and hard to scan. If the HTML template needs to change (e.g., adding a CSS stylesheet, adding a "retry" link), it must be updated in five places. This is the kind of duplication that leads to inconsistency over time.

**Suggested approach:**

Extract a helper function like `renderCallbackPage(title: string, message: string, isSuccess: boolean): string` that returns the HTML string. Each branch becomes a one-liner. This cuts the handler to ~30 lines and makes the control flow immediately visible.

---

### 5. Token exchange error messages may leak sensitive response bodies

**Category:** Security Risk

**Severity:** Medium

**File:** `src/oauth.ts:122-123, 258-261` — `exchangeCodeForTokens()` and `refreshAccessToken()`

**Evidence:**

```typescript
// src/oauth.ts:122-123
const errorText = await response.text();
throw new Error(`Token exchange failed: ${response.status} ${errorText}`);

// src/oauth.ts:258-261
const errorText = await response.text();
logger.warn({ status: response.status }, 'Token refresh failed');
clearSession();
throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
```

The full response body from Salesforce's token endpoint is embedded in the error message. In the callback route handler, this error message is rendered into the HTML page via `escapeHtml(message)` (line 113). Salesforce error responses can include `error_description` text that references internal details.

**Why this matters:**

The spec explicitly states: "Never log customer data" and "no sensitive data (tokens, client secret) is logged." While the `logger.warn` call on line 259 correctly omits the response body, the thrown error message includes it. If this error propagates to the global error handler in `app.ts`, the full response text will be logged via `logger.error`. Additionally, the callback route renders it in the HTML response to the user's browser.

**Suggested approach:**

Log the raw error text at `debug` level for developer troubleshooting, but throw an error with a sanitized message like `Token exchange failed (HTTP ${response.status})`. This prevents both log leakage and HTML rendering of potentially sensitive response content.

---

### 6. `loginUrl` query parameter accepted on callback without validation

**Category:** Security Risk

**Severity:** High

**File:** `src/routes.ts:30,90` — `GET /oauth/authorize` and `GET /oauth/callback`

**Evidence:**

```typescript
// src/routes.ts:30 (authorize)
const loginUrl = req.query.loginUrl as string | undefined;
const authorizationUrl = generateAuthorizationUrl(loginUrl);

// src/routes.ts:90 (callback)
const loginUrl = req.query.loginUrl as string | undefined;
const session = await handleCallback(code, state, loginUrl);
```

The `loginUrl` parameter is accepted from the query string and passed directly to `generateAuthorizationUrl()` and `handleCallback()`. In `exchangeCodeForTokens()` (oauth.ts:104), it is used to construct the token endpoint URL:

```typescript
const tokenUrl = `${loginUrl ?? config.loginUrl}/services/oauth2/token`;
```

**Why this matters:**

An attacker could pass `loginUrl=https://evil.example.com` on the callback URL. The service would then POST the authorization code, client ID, client secret, and code verifier to `https://evil.example.com/services/oauth2/token`. This is a credential exfiltration vector — the client secret is sent to an attacker-controlled server. Even if the attacker cannot trigger the callback themselves (due to state validation), the `loginUrl` on the authorize endpoint controls where the user is sent, and a phishing scenario could redirect a legitimate user through a malicious flow.

**Suggested approach:**

Either (a) remove `loginUrl` from the callback endpoint entirely (the authorize endpoint already stored the state, and the config has the login URL), or (b) validate that `loginUrl` matches a known allowlist (e.g., `login.salesforce.com`, `test.salesforce.com`). At minimum, validate that it is a Salesforce domain.

---

### 7. `getSession()` returns a mutable reference to internal state

**Category:** Type Safety

**Severity:** Low

**File:** `src/oauth.ts:202-204` — `getSession()`

**Evidence:**

```typescript
export function getSession(): OAuthSession | null {
  return currentSession;
}
```

This returns a direct reference to the module-level `currentSession` object. Any caller can mutate the session's fields (e.g., `getSession()!.accessToken = 'tampered'`) without going through any controlled API.

**Why this matters:**

In the routes, `getSession()` is only used to read properties for the `/oauth/status` response, so this is not an active bug. However, as the codebase grows and more code consumes `getSession()`, accidental mutation of the shared session object becomes likely. The `refreshAccessToken()` function already mutates `currentSession` directly (lines 266-268), establishing a pattern where mutation is expected — but only from within the module.

**Suggested approach:**

Return a shallow copy: `return currentSession ? { ...currentSession } : null`. This makes the API's intent clear: callers get a snapshot, not a handle to internal state. Alternatively, mark the return type as `Readonly<OAuthSession> | null`.

---

### 8. `TokenResponse.expires_in` typed as required but handled as optional

**Category:** Type Safety

**Severity:** Low

**File:** `src/oauth.ts:28-29` — `TokenResponse` interface, `src/oauth.ts:186` — usage

**Evidence:**

```typescript
// Interface definition (line 29):
interface TokenResponse {
  // ...
  expires_in: number;  // <-- required
}

// Usage (line 186):
expiresAt: tokenResponse.expires_in ? Date.now() + tokenResponse.expires_in * 1000 : null,
```

The `expires_in` field is declared as `number` (required) in the `TokenResponse` interface, but lines 186 and 268 check it with a truthy guard (`tokenResponse.expires_in ?`), which treats `0` and `undefined` the same way. The refresh token endpoint sometimes omits `expires_in` entirely.

**Why this matters:**

The type says "this is always a number" but the code says "this might be falsy." This is a contradiction that will confuse future readers. If `expires_in` is truly `0` (some providers do this to mean "no expiration"), the truthy check would incorrectly set `expiresAt` to `null`.

**Suggested approach:**

Change the type to `expires_in?: number` (optional) to match actual usage, or use an explicit `!== undefined` check instead of a truthy guard.

---

## Test Quality Assessment

The test suite is well-structured with 21 unit tests for `oauth.ts` and 22 integration tests for the OAuth routes. Key observations:

**Strengths:**
- State one-time-use is explicitly tested (reused state rejection)
- PKCE code challenge format is validated (base64url, correct length)
- Expiration buffer logic is tested with a specific edge case (4 min < 5 min buffer)
- Integration tests exercise the full authorize-callback-status-disconnect lifecycle
- Mocking of `global.fetch` is clean and properly restored in afterEach

**Areas for improvement:**
- The expiration test (line 322-328) uses a real `setTimeout` of 2 seconds, making the test suite slow. Consider using `vi.useFakeTimers()` to avoid the wait.
- No test covers the `loginUrl` query parameter on the callback endpoint (only tested on authorize).
- No test verifies that `fetchOrgName` failure does not prevent session creation when the fetch itself throws (only the `!response.ok` path is tested).

---

## Summary

The OAuth implementation is well-organized with clean separation between the OAuth service module (`oauth.ts`) and route handlers (`routes.ts`). PKCE is correctly implemented, state parameters are one-time-use, and HTML output is properly escaped against XSS. The test coverage is thorough for the core flows.

The highest-priority issue is **Finding #6 (unvalidated `loginUrl`)**, which is a credential exfiltration vector — the `client_secret` can be sent to an attacker-controlled server. This should be addressed before merging. The second priority is **Finding #1 (unused `OAuthError` class)**, which undermines the typed error hierarchy established in prior review rounds. The remaining findings are maintainability improvements that would make the code easier to extend.
