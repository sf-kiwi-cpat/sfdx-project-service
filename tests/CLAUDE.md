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
- **90%** on main (all four metrics: statements, branches, functions, lines)
- **85%** on feature branches (all four metrics)

Coverage must run against the **full test suite** (not unit-only):
```bash
npm run test:coverage    # all tests + coverage report
```

### No pragma without justification

**Don't add `/* v8 ignore next */` (or any v8-ignore variant) to clear a coverage gate without justification.** When a coverage failure is caused by a real, missing test, the right action is to write the test or remove the dead branch — not annotate around it. Pragmas are reserved for branches the type system already excludes (e.g., `?? defaultValue` where the left side is non-nullable per the function signature) or for genuinely unreachable defensive code that exists as a guard against an invariant violation that cannot occur in practice.

Every pragma must be followed by a `--` justification suffix inside the same comment so reviewers can tell at a glance whether the exclusion is legitimate. The format is:

```ts
/* v8 ignore next -- <one-line reason> */
```

For example:

```ts
/* v8 ignore next -- timer is always assigned before any await in the try block, so the falsy branch is unreachable */
if (timer) clearTimeout(timer);
```

The `--` separator is parsed by `ast-v8-to-istanbul`'s ignore regex as the boundary between the directive and the reason, so anything after `--` is free-form prose. A pragma without `--` followed by text is treated as undocumented and should be flagged in review.

If you find yourself adding a pragma to make CI pass, **stop and reconsider whether the branch should be tested instead.** The 90% / 85% threshold is the deterministic forcing function that keeps coverage meaningful for autonomous AI implementers; pragmas without justification erode that signal silently. The threshold itself is held strict on purpose — see issue #238 for the framing — and the right escape hatches are (1) writing the missing test or (2) deleting genuinely-dead code, not annotating around the gap.

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
