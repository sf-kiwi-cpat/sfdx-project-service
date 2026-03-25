# Q3 Test Plan — SF Project Service

## Purpose

This document captures a repeatable QA approach for the SF Project Service. The goal is to enable any engineer — including someone unfamiliar with the codebase — to perform a thorough quality review by following these steps. The plan covers static analysis, automated tests, and manual endpoint testing via curl.

## Prerequisites

Before starting, make sure you have:

- Node.js >= 20 installed
- Access to the repository
- The spec document at `.agents/sfdx-project-service-spec.md` (read it before you do anything else — the spec is the source of truth)
- A terminal with `curl` available
- Optionally, `python3` for pretty-printing JSON responses (`| python3 -m json.tool`)

## Phase 1: Spec Familiarization

Read `.agents/sfdx-project-service-spec.md` end-to-end before touching code. Pay particular attention to:

1. **API Surface table** — this defines every endpoint that must exist
2. **Write Lock Mechanism** — the rules for when writes are blocked (409 Conflict)
3. **Error Responses** — RFC 9457 format is mandatory for *all* error responses
4. **Logging** — what should/shouldn't be logged (never log customer data)
5. **Testing** — the spec says tests are the "executable specification" and should be comprehensive enough that someone could reconstruct the spec from the tests alone

Build a mental checklist of every behavioral claim the spec makes. You'll verify each one.

## Phase 2: Static Analysis

### 2.1 Read Every Source File

Read every `.ts` file in `src/`. For a service this size (< 500 lines of application code), reading everything is feasible and important. You're looking for:

- **Spec compliance** — does each endpoint match the spec's described behavior?
- **Security** — path traversal protection, credential exposure, input validation
- **Error handling** — are all error paths covered? Do they return RFC 9457 JSON?
- **Consistency** — are similar endpoints handled the same way? (e.g., do all write endpoints check the lock?)

Recommended reading order:
1. `config.ts` — understand how project root is determined
2. `errors.ts` — typed error classes (`RestrictedPathError`, `PathTraversalError`, `FileNotFoundError`, `NotAFileError`) and the `errorToProblem()` mapping that converts them to RFC 9457 responses via `instanceof` checks
3. `files.ts` — core file operations, path resolution (`resolveProjectPath`), restricted-path filtering (`isRestrictedPath`), tree building (`buildTree`). Verify that `isRestrictedPath` checks every segment (not just the first) and that `shouldIgnoreEntry` is shared between `isRestrictedPath` and `buildTree`.
4. `lock.ts` — write lock mechanism
5. `project.ts` — project scaffolding and org connection
6. `events.ts` — filesystem watcher
7. `routes.ts` — HTTP handlers (this ties everything together)
8. `app.ts` — Express app setup, middleware, global error handler
9. `logger.ts` — logging configuration
10. `index.ts` — entry point

### 2.2 Review Against Spec (Checklist)

For each endpoint in the spec's API Surface table, verify in `routes.ts`:

| Check | What to look for |
|:---|:---|
| Endpoint exists | Route is registered with correct HTTP method and path |
| Happy path works | Handler calls the right domain function and returns the expected response |
| Input validation | Missing/invalid inputs return 400 with RFC 9457 JSON |
| Write lock | Write endpoints (PUT, DELETE, POST /project/init) check `writeLock.isHeld()` |
| Error format | All error responses use `application/problem+json` with `status`, `title`, `detail` |
| Path traversal | File endpoints validate paths via `resolveProjectPath` |
| Restricted paths | `resolveProjectPath` → `isRestrictedPath` blocks `.sf/`, `.git/`, `node_modules/`, and dotfiles at *every* path segment, not just the first. Verify `segments.some()` pattern. |
| Error class mapping | `files.ts` throws typed error classes from `errors.ts`; `errorToProblem()` uses `instanceof` (not string matching). Adding a new error class that isn't handled should be caught at review time. |

Cross-cutting concerns to verify:
- Unknown routes return RFC 9457 JSON (not Express's default HTML 404)
- The global error handler in `app.ts` catches unhandled exceptions and formats them as RFC 9457
- `pino-http` middleware is registered and request logging works
- Customer data (file contents, auth tokens) is never logged

### 2.3 Review Test Files

Read every `.test.ts` file. For each, ask:

1. **Coverage** — is every endpoint tested for happy path + error cases?
2. **Behavioral completeness** — does the test suite match what the spec describes? Could you reconstruct the spec from the tests?
3. **Edge cases** — are path traversal, missing params, wrong content types, lock interactions all tested?
4. **Test isolation** — do tests clean up after themselves? (temp dirs, env vars, open servers)
5. **Missing test files** — is there a test file for every source module? (e.g., if `events.ts` exists, does `events.test.ts` exist?)

### 2.4 Review Configuration

Check these files for correctness:

| File | What to verify |
|:---|:---|
| `package.json` | All dependencies installed? Type packages present? Scripts work? |
| `tsconfig.json` | Strict mode on? ESM configured? |
| `vitest.config.ts` | Coverage provider installed? Test pattern correct? |
| `eslint.config.js` | Ignores dist/node_modules? Rules sensible? |
| `.gitignore` | Sensitive files excluded? Build artifacts excluded? |

### 2.5 Run Static Checks

```bash
# TypeScript type checking (should produce zero errors)
npx tsc --noEmit

# ESLint (should produce zero errors/warnings)
npx eslint .

# Check for missing dependencies referenced in config
npm test -- --coverage  # Verifies @vitest/coverage-v8 is installed if configured
```

## Phase 3: Automated Test Execution

### 3.1 Run the Test Suite

```bash
npm test
```

Record:
- Total test count and pass/fail
- Any console noise (log output, warnings) mixed into test results
- Test duration (baseline for future regressions)

All tests must pass. If any fail, stop and investigate before proceeding to manual testing.

### 3.2 Evaluate Test Output Quality

While tests run, observe the console output. Things to flag:
- **Log noise** — if JSON log lines are interleaved with test results, the logger isn't silenced during tests. This makes test output hard to read.
- **Deprecation warnings** — Node.js or dependency deprecation warnings
- **Unhandled promise rejections** — indicate missing error handling

## Phase 4: Manual Endpoint Testing (curl)

This is the most important phase. The spec's Definition of Done says the service should be *"explored, tested, and demoed using curl."* You're simulating what a front-end developer would experience integrating against this API.

### 4.1 Server Setup

```bash
# Create an isolated test project directory
mkdir -p /tmp/sf-qa-project/force-app/main/default/classes
echo 'class Foo {}' > /tmp/sf-qa-project/force-app/main/default/classes/Foo.cls
echo '{"packageDirectories":[{"path":"force-app","default":true}]}' > /tmp/sf-qa-project/sfdx-project.json

# Create sensitive directories (for restricted-path testing)
mkdir -p /tmp/sf-qa-project/.sf /tmp/sf-qa-project/.git
echo '{"accessToken":"secret"}' > /tmp/sf-qa-project/.sf/auth.json
echo '[core]' > /tmp/sf-qa-project/.git/config
echo 'SECRET=abc' > /tmp/sf-qa-project/.env

# Create nested sensitive directories (for nested restricted-path testing)
mkdir -p /tmp/sf-qa-project/force-app/.git /tmp/sf-qa-project/force-app/.hidden
mkdir -p /tmp/sf-qa-project/force-app/node_modules
echo 'nested git' > /tmp/sf-qa-project/force-app/.git/config
echo 'nested secret' > /tmp/sf-qa-project/force-app/.hidden/secret.txt
echo 'nested nm' > /tmp/sf-qa-project/force-app/node_modules/pkg.js

# Build and start the server
npm run build
PROJECT_ROOT=/tmp/sf-qa-project node dist/index.js &
```

Using a separate `PROJECT_ROOT` avoids polluting the repo's own directory. Port defaults to 3000; use `PORT=XXXX` if 3000 is taken.

### 4.2 Test Matrix

Work through every row in this matrix. For each test, verify the HTTP status code, the `Content-Type` header, and the response body structure.

#### POST /project/init

| # | Scenario | curl command | Expected |
|:--|:---|:---|:---|
| 1 | Happy path | `-X POST -H "Content-Type: application/json" -d '{"accessToken":"tok","instanceUrl":"https://test.salesforce.com"}'` | 201, `{ ok: true }` (may 500 if no real org — that's expected, note it) |
| 2 | Missing accessToken | `-d '{"instanceUrl":"https://test.salesforce.com"}'` | 400, RFC 9457, `"accessToken and instanceUrl are required"` |
| 3 | Missing instanceUrl | `-d '{"accessToken":"tok"}'` | 400, RFC 9457 |
| 4 | Empty body | `-d '{}'` | 400, RFC 9457 |
| 5 | No Content-Type header | `-d '{"accessToken":"tok","instanceUrl":"https://x.com"}'` (no `-H`) | Should still validate — check if Express parses the body |
| 6 | While lock is held | Acquire lock first, then POST init | Should return 409 Conflict |

#### GET /project/tree

| # | Scenario | curl command | Expected |
|:--|:---|:---|:---|
| 7 | Happy path | `GET /project/tree` | 200, JSON tree with `name`, `type`, `path`, `children` |
| 8 | Verify sorting | Create dirs + files, check tree | Directories before files, alphabetical, case-insensitive |
| 9 | Sensitive dir filtering | Create `.git/`, `.sf/` dirs in project, check tree | `.git`, `.sf`, `node_modules` should NOT appear |
| 10 | While lock is held | Acquire lock, then GET tree | 200 — reads are not blocked |

#### GET /project/file

| # | Scenario | curl command | Expected |
|:--|:---|:---|:---|
| 11 | Happy path | `?path=force-app/main/default/classes/Foo.cls` | 200, `Content-Type: text/plain`, file contents |
| 12 | Missing path param | No `?path=` | 400, RFC 9457 |
| 13 | File not found | `?path=nonexistent.cls` | 404, RFC 9457, `"No file exists"` |
| 14 | Path traversal (../) | `?path=../../../etc/passwd` | 400, RFC 9457, `"Path escapes project root"` |
| 15 | Path traversal (nested) | `?path=force-app/../../etc/passwd` | 400, RFC 9457 |
| 16 | Absolute path | `?path=/etc/passwd` | 400, RFC 9457 |
| 17 | Path is a directory | `?path=force-app/main/default/classes` | 400, RFC 9457, `"Not a file"` |
| 18 | While lock is held | Acquire lock, then GET file | 200 — reads are not blocked |
| 18a | Restricted path (top-level) | `?path=.sf/auth.json` | 400, RFC 9457, `"Access to this path is restricted"` |
| 18b | Restricted path (nested) | `?path=force-app/.git/config` | 400, RFC 9457, `"Access to this path is restricted"` |
| 18c | Restricted path (dotfile) | `?path=force-app/.hidden/secret.txt` | 400, RFC 9457 |
| 18d | Restricted path (node_modules) | `?path=force-app/node_modules/pkg.js` | 400, RFC 9457 |

#### PUT /project/file

| # | Scenario | curl command | Expected |
|:--|:---|:---|:---|
| 19 | Create new file | `-X PUT -H "Content-Type: text/plain" -d 'class X {}' ?path=...` | 200, `{ ok: true }`, file exists on disk |
| 20 | Overwrite existing | PUT to same path with different content | 200, content updated |
| 21 | Auto-create parent dirs | PUT to `force-app/main/default/triggers/X.trigger` (triggers/ doesn't exist) | 200, parent dirs created |
| 22 | Missing path param | No `?path=` | 400, RFC 9457 |
| 23 | Path traversal | `?path=../../etc/malicious` | 400, RFC 9457 |
| 23a | Restricted path (top-level) | `-X PUT -H "Content-Type: text/plain" -d 'x' ?path=.sf/auth.json` | 400, RFC 9457, `"Access to this path is restricted"` |
| 23b | Restricted path (nested) | `-X PUT -H "Content-Type: text/plain" -d 'x' ?path=force-app/.sf/evil.json` | 400, RFC 9457 |
| 24 | While lock is held | Acquire lock, then PUT | 409, RFC 9457, `"Agent Active"` |
| 25 | Wrong content type | `-d 'content'` without `-H "Content-Type: text/plain"` | Should not silently write empty file — check what happens |
| 26 | Empty body | PUT with no body | Check behavior — should it be an error or create empty file? |
| 27 | JSON body with `content` field | `-H "Content-Type: application/json" -d '{"content":"class X {}"}'` | 200, file contains `class X {}` |

#### DELETE /project/file

| # | Scenario | curl command | Expected |
|:--|:---|:---|:---|
| 28 | Happy path | `-X DELETE ?path=...` on existing file | 200, `{ ok: true }`, file gone |
| 29 | File not found | DELETE on nonexistent path | 404, RFC 9457 |
| 30 | Missing path param | No `?path=` | 400, RFC 9457 |
| 31 | Path traversal | `?path=../../../etc/passwd` | 400, RFC 9457 |
| 31a | Restricted path (top-level) | `-X DELETE ?path=.sf/auth.json` | 400, RFC 9457, `"Access to this path is restricted"` |
| 31b | Restricted path (nested) | `-X DELETE ?path=force-app/node_modules/pkg.js` | 400, RFC 9457 |
| 32 | Target is a directory | `?path=force-app/main/default/classes` | 400, RFC 9457, `"Not a file"` |
| 33 | While lock is held | Acquire lock, then DELETE | 409, RFC 9457 |

#### GET /project/events (SSE)

| # | Scenario | How to test | Expected |
|:--|:---|:---|:---|
| 34 | Stream opens | `curl -N http://localhost:3000/project/events` | 200, `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive` |
| 35 | File create event | Open SSE stream, then in another terminal: PUT a new file | Stream receives `data: {"type":"add","path":"..."}` |
| 36 | File modify event | Open SSE stream, then overwrite an existing file | Stream receives `data: {"type":"change","path":"..."}` |
| 37 | File delete event | Open SSE stream, then DELETE a file | Stream receives `data: {"type":"unlink","path":"..."}` |
| 38 | Ignored paths | Modify a file in `.git/` or `node_modules/` | No event emitted |
| 39 | Client disconnect | Open stream, then Ctrl+C | Watcher should close (check server logs, no resource leak) |

**How to test SSE manually:**
Open two terminal tabs. In tab 1, start the SSE stream:
```bash
curl -N http://localhost:3000/project/events
```
In tab 2, make file changes:
```bash
curl -X PUT "http://localhost:3000/project/file?path=force-app/main/default/classes/SSETest.cls" \
  -H "Content-Type: text/plain" -d 'class SSETest {}'
```
Watch tab 1 for the SSE event. Then Ctrl+C tab 1 and verify no errors in the server log.

#### Internal Lock API

| # | Scenario | curl command | Expected |
|:--|:---|:---|:---|
| 40 | Acquire lock | `POST /internal/lock` | 200, `{ lockId: "uuid" }` |
| 41 | Double acquire | POST again while held | 409, RFC 9457, `"Lock Held"` |
| 42 | Renew lock | `PATCH /internal/lock -d '{"lockId":"..."}'` | 200, `{ ok: true }` |
| 43 | Renew wrong ID | PATCH with wrong lockId | 404, RFC 9457, `"Lock Not Found"` |
| 44 | Renew missing ID | PATCH with `{}` | 400, RFC 9457 |
| 45 | Release lock | `DELETE /internal/lock -d '{"lockId":"..."}'` | 200, `{ ok: true }` |
| 46 | Release wrong ID | DELETE with wrong lockId | 404, RFC 9457 |
| 47 | Release missing ID | DELETE with `{}` | 400, RFC 9457 |
| 48 | TTL auto-expiry | Acquire lock, wait > 60 seconds, then PUT a file | PUT should succeed (lock expired) |
| 49 | Renew extends TTL | Acquire, wait 30s, renew, wait 30s more | Lock should still be held (TTL reset) |

#### Cross-Cutting

| # | Scenario | How to test | Expected |
|:--|:---|:---|:---|
| 68 | Unknown route | `GET /nonexistent` | 404 with RFC 9457 JSON (not HTML) |
| 69 | Wrong HTTP method | `POST /project/tree` | Should return 404 or 405, with RFC 9457 JSON |
| 70 | RFC 9457 shape | Every error response in the matrix above | Must have `status` (number), `title` (string), `detail` (string) |
| 71 | Content-Type on errors | Every error response | Must be `application/problem+json` |

### 4.3 Recording Results

For each test case, record in a table or spreadsheet:

| # | Scenario | Expected Status | Actual Status | Pass/Fail | Notes |
|:--|:---|:--|:--|:--|:---|
| 1 | POST /project/init happy path | 201 | 500 | FAIL | Expected — no real org available |
| ... | | | | | |

Use `-w "\nHTTP_CODE: %{http_code}\nCONTENT_TYPE: %{content_type}\n"` with curl to capture status code and content type in a single command:

```bash
curl -s -w "\nHTTP_CODE: %{http_code}\nCONTENT_TYPE: %{content_type}\n" \
  http://localhost:3000/project/tree
```

### 4.4 Cleanup

After testing:
```bash
# Stop the server
kill %1   # or: lsof -ti:3000 | xargs kill

# Remove test project directory
rm -rf /tmp/sf-qa-project
```

## Phase 5: Security Review

These checks are specific to this service's trust model and deployment context.

| Check | How to verify |
|:---|:---|
| Path traversal blocked on all file endpoints | Tested in Phase 4 (tests 14-16, 23, 31) |
| Restricted paths blocked at all depths | Tested in Phase 4 (tests 18a-18d, 23a-23b, 31a-31b). Verify both top-level (`.sf/auth.json`) and nested (`force-app/.git/config`) paths return 400. |
| Tree and file endpoint filtering are consistent | Paths hidden from `/project/tree` must also be blocked by `/project/file` GET/PUT/DELETE. Verify by creating nested `.git/`, `.sf/`, `node_modules/`, and dotfile directories inside `force-app/`, then checking tree excludes them AND file endpoints return 400. |
| Auth tokens not exposed via tree/file read | GET /project/tree should not include `.sf/` directory; GET /project/file should not serve `.sf/` contents |
| Auth tokens not logged | Search `routes.ts`, `project.ts` for any logging of `accessToken`, `refreshToken`, `instanceUrl`. Check pino-http serializer doesn't log request bodies. |
| No customer data in logs | Review `logger.ts` and all `logger.*()` calls — they should log paths/shapes, not contents |
| `sfdx-project.json` not overwritten on re-init | Call POST /project/init twice — second call should preserve existing config |

## Phase 6: Write Feedback

Save findings to `.agents/feedback.md` (or the designated review file). Organize by severity:

1. **Bugs** — things that are broken or violate the spec
2. **Spec Deviations** — things that don't match the spec but aren't necessarily broken
3. **Test Coverage Gaps** — missing tests that should exist per the spec's testing philosophy
4. **Code Quality** — style, naming, configuration issues

For each finding, include:
- Which file(s) and line(s) are affected
- What the spec says (if relevant)
- What you observed
- What the fix should be (brief — the developer should figure out the details)

## Appendix: Quick Reference Commands

```bash
# Build
npm run build

# Run all tests
npm test

# Type check
npx tsc --noEmit

# Lint
npx eslint .

# Start server with custom project root
PROJECT_ROOT=/tmp/sf-qa-project node dist/index.js

# Start server on different port
PORT=3001 PROJECT_ROOT=/tmp/sf-qa-project node dist/index.js

# curl with status code output
curl -s -w "\nHTTP_CODE: %{http_code}\n" <url>

# curl with full response headers
curl -s -D- <url>

# Pretty-print JSON response
curl -s <url> | python3 -m json.tool

# SSE stream (stays open)
curl -N http://localhost:3000/project/events

# Kill server by port
lsof -ti:3000 | xargs kill
```
