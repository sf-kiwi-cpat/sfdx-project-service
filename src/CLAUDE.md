# src/ — Production Code

ESM project (`"type": "module"`), TypeScript strict mode, Node.js >= 20.

## Architecture

Fastify REST API wrapping SFDX project operations.

- **`routes/`** — HTTP layer. Request parsing, response formatting, status codes.
  Routes are thin — delegate to domain for logic.
- **`domain/`** — Business logic. Framework-agnostic. No Fastify imports.
  Testable independently of HTTP.
- **`errors.ts`** — Error classes using RFC 9457 Problem Details format.
  All API errors should use these classes.
- **`app.ts`** — Fastify app factory and plugin registration.
- **`config.ts`** — Environment-backed configuration (reads from `process.env`).
- **`logger.ts`** — Pino logger setup.
- **`index.ts`** — Entry point. Excluded from coverage.

### Fastify 5 gotchas

Discovered during the Express→Fastify migration (#78, PR #89). Each one maps to a load-bearing comment in `app.ts` or a route file — don't "clean up" the patterns without reading the comment first.

- **Use `loggerInstance`, not `logger`, when passing an existing pino instance.** Fastify 5 renamed the option. The old name still type-checks but throws `"logger options only accepts a configuration object"` at runtime when given a pino instance. See `createApp()` in `app.ts`.
- **Don't put an explicit `: FastifyInstance` return type on `createApp()`.** Once you pass `loggerInstance`, the inferred `FastifyInstance` generic switches its `Logger` type parameter from the default `FastifyBaseLogger` to the concrete pino `Logger<...>`. An explicit `: FastifyInstance` annotation pins the default and causes a build error. Let TypeScript infer the return type.
- **Every status code the route handler emits via `reply.status(...)` must appear in the `response:` block — and declare error codes you want documented in OpenAPI even if the global error handler emits them.** TypeBox + Fastify's type provider use `response:` as both the OpenAPI schema and the runtime serializer. A code emitted from inside the handler that's missing from `response:` is stripped to a generic 500 by the serializer, and `reply.status(<missing-code>)` fails to typecheck. Errors thrown out of the handler are a different path: `setErrorHandler` (in `app.ts`) maps them via `errorToProblem` and serializes the problem+json directly, so they reach the wire fine without being declared on the route — but the OpenAPI doc only shows the codes you list in `response:`, so add the 4xx codes the route is meant to surface even when the handler throws rather than calling `reply.status()`. For problem+json codes, use the shared `problemJsonResponse(description)` helper from `src/errors.ts` (e.g. `400: problemJsonResponse('...')`, `404: problemJsonResponse('...')`) — keeps the OpenAPI shape consistent and avoids drift if the problem schema changes. See `routes/projects.routes.ts` and `routes/deploy.routes.ts` for the canonical pattern.
- **For SSE, use the `@fastify/sse` plugin and run resource-existence checks in `preHandler`.** Once the plugin's route wrapper sees `Accept: text/event-stream` it commits 200 text/event-stream headers around the handler body, so a `throw` or `reply.status(404)` from inside the handler can no longer be rewritten — the client sees an empty 200 stream. Validate the resource (project exists, deployment exists) in `preHandler` so the error path runs before headers are committed. Reject missing `Accept` headers explicitly with 400 problem+json from inside the handler before touching `reply.sse`. See `routes/deploy.routes.ts` for the canonical example. (If you ever need to bypass the plugin and stream by hand, use `reply.hijack()` + `reply.raw` and validate before the hijack call — same ordering rule.)

## Patterns

- Business logic in `domain/`, HTTP concerns in `routes/`
- Error responses use RFC 9457: `{ type, title, status, detail }`
- Routes register as Fastify plugins via `app.register()`
- All imports use `.js` extensions (ESM requirement)
