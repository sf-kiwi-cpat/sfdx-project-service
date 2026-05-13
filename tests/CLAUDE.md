# tests/ — Agent-Mutable Quality Tools

These tests are owned by agents. Create, modify, and delete freely to
support implementation quality. They are not the contract — `spec/` is.

## Structure

- `tests/unit/` — Fast, isolated tests. Mocked dependencies.
- `tests/integration/` — Tests against the real Fastify app (via `inject()`).

Integration tests provide most of the coverage. Unit tests complement
them for edge cases and isolated logic.

## Coverage

Thresholds are in `vitest.config.ts`, split by git branch:
- **90%** on `main` (lines, branches, functions, statements)
- **85%** on feature branches (lines, branches, functions, statements)

Coverage must run against the **full test suite** (not unit-only):
```bash
npm run test:coverage    # all tests + coverage report
```

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
