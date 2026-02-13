# Code Review Feedback — SF Project Service

Reviewer notes: This review compares the implementation against the spec in `.agents/sf-project-service-spec.md`. The spec is the source of truth. All 40 tests pass, TypeScript compiles clean, and ESLint reports no issues. The findings below are grouped by severity.

---

## Bugs

### 1. `buildTree` exposes `.git`, `.sf`, `node_modules`, and other sensitive directories

**Files:** `src/files.ts` — `buildTree()`

The `events.ts` watcher correctly ignores `.git`, `.sf`, `node_modules`, and dotfiles. However, `buildTree()` (which powers `GET /project/tree`) has zero filtering — it returns *everything* in the project root, including:

- `.sf/` — contains auth credentials (access tokens saved by `@salesforce/core`)
- `.git/` — repository internals
- `node_modules/` — thousands of files the UI doesn't need
- Editor temp files, dotfiles, etc.

During manual testing, the `.sf` directory (created by a prior `POST /project/init`) showed up in the tree response. A client could then `GET /project/file?path=.sf/...` and read the saved auth token.

This is both a **security issue** (leaking credentials) and a **usability issue** (the file explorer would be polluted with irrelevant entries). `buildTree` should filter the same set of paths that the chokidar watcher ignores.

### 2. `POST /project/init` is not protected by the write lock

**Files:** `src/routes.ts:13-30`

The spec says: *"write access is mutually exclusive: when the agent is active, the Project Service locks out all write operations."*

`PUT /project/file` and `DELETE /project/file` both check `writeLock.isHeld()` before proceeding, but `POST /project/init` does not. This endpoint writes to the filesystem (creates directories, writes `sfdx-project.json`, saves auth credentials). If the agent is active and the user somehow re-triggers init, it could corrupt the project state while the agent is working.

Add the same `writeLock.isHeld()` guard to the init route.

### 3. Unknown routes return HTML instead of RFC 9457 JSON

**Observed during testing:**

```
GET /nonexistent → 404
Content-Type: text/html

<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Error</title></head>
<body><pre>Cannot GET /nonexistent</pre></body>
</html>
```

The spec says: *"All error responses follow RFC 9457."* Express's default 404 handler returns HTML. You need a catch-all at the end of the router (after all defined routes) that returns a `404` with `application/problem+json`.

### 4. `PUT /project/file` silently writes empty file for unrecognized content types

**Files:** `src/routes.ts:79`

```ts
const content = typeof req.body === 'string' ? req.body : req.body?.content ?? '';
```

When a request arrives with `Content-Type: application/x-www-form-urlencoded` (curl's default when using `-d` without `-H`), Express doesn't parse it (no `urlencoded` middleware registered), so `req.body` is `undefined`. The fallback `?? ''` silently writes an empty file.

This is a silent data loss scenario. If a client forgets the `Content-Type` header, they'll get a `200 OK` but their content is gone. The endpoint should return `400 Bad Request` when the body is empty or unparsable, rather than silently writing nothing.

---

## Spec Deviations

### 5. `POST /project/init` returns `200` — consider `201 Created`

**Files:** `src/routes.ts:26`

The endpoint scaffolds a new project (creates directories + files). `201 Created` is more semantically accurate for resource creation. `200` isn't wrong, but `201` better communicates what happened. (Minor — the spec doesn't mandate a specific success code.)

### 6. Missing `@types/supertest` dev dependency

**Files:** `package.json`

`supertest` is installed but `@types/supertest` is not. This means `routes.test.ts` has no type safety for the supertest API. The tests work at runtime because vitest runs TypeScript via transpilation, but the types are effectively `any`. This should be added as a dev dependency.

### 7. `@vitest/coverage-v8` is configured but not installed

**Files:** `vitest.config.ts:10`, `package.json`

`vitest.config.ts` configures the `v8` coverage provider, but `@vitest/coverage-v8` is not in `devDependencies`. Running `npm test -- --coverage` fails with: `MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'`. Either add the dependency or remove the coverage config.

### 8. `POST /project/init` doesn't validate `instanceUrl` format

**Files:** `src/routes.ts:16`

The route checks that `accessToken` and `instanceUrl` are truthy, but doesn't validate that `instanceUrl` is a valid URL. An `instanceUrl` like `"not-a-url"` will be passed directly to `AuthInfo.create()`, which will throw an opaque error. A simple URL format check and a clear `400` response would be more helpful to API consumers.

---

## Test Coverage Gaps

### 9. No test for `POST /project/init` write lock enforcement

**Files:** `src/routes.test.ts`

The test suite verifies that `PUT` and `DELETE` are blocked when the lock is held (test at line 222), but there's no test for `POST /project/init` under lock. This is tied to bug #2 above — once the lock guard is added, a test should verify it.

### 10. No test for `DELETE /project/file` when target is a directory

**Files:** `src/routes.test.ts`

The test for `DELETE /project/file` covers file-not-found (404) but doesn't test what happens when the path points to a directory. The underlying `deleteFile()` would throw `"Not a file"` → `400`, but there's no integration test verifying this behavior through the HTTP layer.

### 11. No test for `PUT /project/file` path traversal

**Files:** `src/routes.test.ts`

`GET /project/file` has a path-traversal test at the unit level (in `files.test.ts`), but there's no integration test for path traversal on `PUT` or `DELETE`. Since these are write operations, they're higher risk and should be explicitly tested at the HTTP layer.

### 12. No test for `GET /project/tree` when project directory doesn't exist

**Files:** `src/routes.test.ts`

If `PROJECT_ROOT` points to a non-existent directory, `buildTree()` will throw. There's no test verifying the service returns a proper error response.

### 13. No test for SSE event payloads

**Files:** `src/routes.test.ts:182-200`

The SSE test only verifies the response headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`). It doesn't verify that writing/deleting a file actually produces an SSE event with the correct payload. This is arguably the most important behavioral test for the SSE endpoint — verifying the headers proves the stream opens, but not that it works.

### 14. No event watcher tests at all (`events.ts` is untested)

**Files:** `src/events.ts`

There is no `events.test.ts` file. The `createProjectWatcher` function — which is responsible for watching the filesystem and emitting relative-path events — has zero unit tests. Things to test:
- Events are emitted with paths relative to the project root
- The correct event types (`add`, `change`, `unlink`) map to the correct chokidar events
- Ignored paths (`.git`, `node_modules`, `.sf`) don't produce events
- The watcher can be closed cleanly

---

## Code Quality

### 15. Logger outputs to console during test runs

**Observed during testing:** Running `npm test` produces pages of JSON log output interleaved with test results:

```
{"level":"info","time":...,"req":{...},"res":{"statusCode":200,...},"msg":"request completed"}
```

In `logger.ts:8-10`, `pino` transport is set to `undefined` when `NODE_ENV === 'test'`, which disables the pino transport but still outputs to stdout. The `pinoHttp` middleware in `app.ts` still logs every request. Consider setting the log level to `'silent'` during tests, or setting `enabled: false` on the pino instance when `NODE_ENV === 'test'`.

### 16. The `renewalTimer` name is misleading

**Files:** `src/lock.ts:13`

The private field `renewalTimer` is actually the *expiry* timer — it fires when the lock's TTL runs out to auto-release. It has nothing to do with renewal. A name like `expiryTimer` would be less confusing to future readers.

### 17. Error handler has a redundant cast

**Files:** `src/app.ts:40-41`

```ts
const isNodeError = err instanceof Error;
const stack = isNodeError ? (err as Error).stack : undefined;
```

If `isNodeError` is `true`, then `err` is already narrowed to `Error` by the type guard. The `as Error` cast is unnecessary.

### 18. `vitest.config.ts` sets `globals: true` but tests explicitly import from vitest

**Files:** `vitest.config.ts:7`, all `*.test.ts` files

The config enables `globals: true`, which makes `describe`, `it`, `expect`, etc. available globally. But every test file explicitly imports them: `import { describe, it, expect } from 'vitest'`. This is fine (explicit imports are arguably better practice), but the `globals: true` setting is then unnecessary. Pick one style — either use global imports or explicit imports, not both.

### 19. `eslint` scripts use deprecated `--ext` flag

**Files:** `package.json:14-15`

```json
"lint": "eslint . --ext .ts",
"lint:fix": "eslint . --ext .ts --fix"
```

The `--ext` flag is for ESLint's legacy config system. ESLint 9 with flat config (which this project uses) ignores `--ext` entirely — file filtering is handled by the config's `files` and `ignores` arrays. These scripts should be simplified to `eslint .` and `eslint . --fix`.

---

## Summary

The implementation is solid for a first pass. The core file operations, path traversal protection, lock mechanism, and error formatting all work correctly. The biggest issues are:

1. **`buildTree` leaking `.sf` auth credentials** — fix this first, it's a security issue
2. **`POST /project/init` not respecting the write lock** — small fix, big correctness improvement
3. **Unknown routes returning HTML** — breaks the RFC 9457 contract
4. **Silent empty writes on bad content type** — subtle data loss bug

The test suite is decent but has notable gaps around SSE behavior, the filesystem watcher, and write-operation edge cases. The spec explicitly calls out that *"the tests are the source of truth"* — so the test suite needs to be comprehensive enough to serve as documentation.
