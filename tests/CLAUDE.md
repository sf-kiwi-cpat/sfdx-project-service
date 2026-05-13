# tests/ — Agent-Mutable Quality Tools

These tests are owned by agents. Create, modify, and delete freely to
support implementation quality. They are not the contract — `spec/` is.

## Structure

- `tests/unit/` — Fast, isolated tests. Mocked dependencies.
- `tests/integration/` — Tests against the real Fastify app (via `inject()`).

Integration tests provide most of the coverage. Unit tests complement
them for edge cases and isolated logic.

## Coverage

Thresholds are in `vitest.config.ts`:
- **90%** on main (statements, functions, lines)
- **85%** on branches

Coverage must run against the **full test suite** (not unit-only):
```bash
npm run test:coverage    # all tests + coverage report
```

### Pragma justifications (CI-enforced)

Every NEW `/* v8 ignore */` pragma added to `src/**/*.ts` in a PR diff must be paired with a same-line `// justification: <reason>` comment. The check is enforced by `scripts/check-pragma-justifications.js` running as a step in `.github/workflows/ci.yml` — failures are not soft warnings, they fail the build. Existing pragmas on `main` are not affected; only added lines in the PR diff are inspected.

Acceptable:

```ts
const x = maybe ?? /* v8 ignore next */ defaultValue; // justification: TypeScript narrows maybe to defined here
```

Rejected (no justification, or justification on a different line):

```ts
const x = maybe ?? /* v8 ignore next */ defaultValue;
/* v8 ignore next */
const x = maybe ?? defaultValue; // justification: ...
```

The check is grep-based and only verifies that *something* follows `// justification:` — review handles the content. If a coverage failure tempts you to reach for a pragma to clear the gate, write the test instead, or remove the dead branch. Pragmas are reserved for type-narrowing branches the type system already excludes.

## Conventions

- Vitest (`describe`, `it`, `expect`)
- Import the app factory: `import { buildApp } from '../../src/app.js';`
- Use `app.inject()` for HTTP tests (no real server needed)
- Tests must be deterministic — no flaky tests, no timing dependencies

## Picking an HTTP test entry point

- **`app.inject()` is the default.** It bypasses the network stack and drives the route table directly — fastest, no port allocation, no socket cleanup. Use it for everything that doesn't need a real socket: JSON request/response, status codes, schema validation, headers, error problem+json bodies.
- **`supertest` is required when the test needs a real socket.** SSE / streaming routes go through `reply.raw` (or `@fastify/sse`'s underlying raw stream) and `app.inject()` does not surface the streamed chunks — assertions on `event:` / `data:` lines only work through a real HTTP request. Same applies to anything that calls `reply.hijack()`. Pattern:

  ```ts
  const app = createApp();
  await app.ready();           // bind the route table
  const res = await request(app.server)
    .get('/v1/.../events')
    .set('Accept', 'text/event-stream');
  // ...assertions...
  await app.close();           // teardown — release the port
  ```

  See `tests/integration/deploy.routes.test.ts` and `tests/integration/fs-events.routes.test.ts` for live examples.
