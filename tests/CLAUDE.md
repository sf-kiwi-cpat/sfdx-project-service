# tests/ — Agent-Mutable Quality Tools

These tests are owned by agents. Create, modify, and delete freely to
support implementation quality. They are not the contract — `spec/` is.

## Structure

- `tests/unit/` — Fast, isolated tests. Mocked dependencies.
- `tests/integration/` — Tests against the real Fastify app (via `inject()`).

Integration tests provide most of the coverage. Unit tests complement
them for edge cases and isolated logic.

## Coverage

Coverage runs on two axes: an aggregate gate and a per-file floor.

**Aggregate** — in `vitest.config.ts`, split by git branch:
- **90%** on the `main` branch (all metrics)
- **85%** on feature branches (all metrics)

"All metrics" means lines, branches, functions, and statements — every coverage metric must clear the threshold for the run to pass.

**Per-file floor** — in `scripts/check-per-file-coverage.js`, applied individually to each `src/**/*.ts` file: lines 75 / branches 60 / functions 45 / statements 75. Catches the failure mode where a new under-covered file hides in the average of well-covered files: a 30%-covered new route pulls the aggregate from 92% to 91% — still over the 90% gate. The aggregate misses it; the per-file floor catches it.

The floor is set deliberately below today's worst-covered file (rather than at the team's aspirational target) so it fires on *new* under-covered files rather than retroactively failing current ones. The script reads vitest's `coverage-summary.json` (already emitted via the `json-summary` reporter) — it doesn't run tests itself, just walks the report. Raising the floor over time: rerun `npm run test:coverage`, take `min(observed per-file value)` per metric, subtract 5pp, round to the nearest 5%, and bump the constants in the script.

Coverage must run against the **full test suite** (not unit-only):
```bash
npm run test:coverage    # all tests + coverage + per-file floor check
```

`test:coverage` and `test:quality` both chain `vitest run --coverage` with the per-file check via `&&`, so either gate failing fails the run.

The threshold gate is enforced in two places:
- **CI:** the `coverage` job in `.github/workflows/ci.yml` runs `npm run test:coverage` and fails the build if any aggregate metric or any per-file metric falls below the threshold for the target branch.
- **Pre-push:** the husky pre-push hook runs `npm run test:quality`, which is wired to `--coverage` and the per-file check, so a local push that drops below either gate fails before it leaves the machine.

## Wall-clock visibility (top-20 slowest tests)

Every CI run prints the 20 slowest tests for that tier (unit / integration / spec) to the workflow log via `scripts/test-timing-report.js`. The script consumes vitest's `--reporter=json --outputFile=test-results.json` output, which each test job emits. Useful when you want to know *which* test is dragging the suite down — the data is one click away in the most recent CI run.

The report runs with `if: always()` so timing data still surfaces when the test step itself failed. A slow-and-failing test should be visible on both axes.

This is part 1 of the wall-clock budget work (GitHub #248). The hard CI gate, the per-test ceiling, the allowlist, and the re-baselining procedure all land in part 2 — once enough CI runs have accumulated to set the budget from observed `ubuntu-latest` numbers rather than developer-local numbers.

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
