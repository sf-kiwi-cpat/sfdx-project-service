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
- **Every status code your handler can emit must appear in the `response:` block.** TypeBox + Fastify's type provider use the `response:` declaration as both an OpenAPI schema and the runtime serializer. A status code missing from `response:` gets stripped to a generic 500 by the serializer, and `reply.status(<missing-code>)` fails to typecheck. For problem+json error codes, use the shared `problemJsonResponse(description)` helper from `src/errors.ts` (e.g. `400: problemJsonResponse('...')`, `404: problemJsonResponse('...')`) — this keeps the OpenAPI shape consistent across routes and avoids drift if the problem schema changes. See `routes/projects.routes.ts` and `routes/deploy.routes.ts` for the canonical pattern.
- **For SSE, use the `@fastify/sse` plugin and run resource-existence checks in `preHandler`.** Once the plugin's route wrapper sees `Accept: text/event-stream` it commits 200 text/event-stream headers around the handler body, so a `throw` or `reply.status(404)` from inside the handler can no longer be rewritten — the client sees an empty 200 stream. Validate the resource (project exists, deployment exists) in `preHandler` so the error path runs before headers are committed. Reject missing `Accept` headers explicitly with 400 problem+json from inside the handler before touching `reply.sse`. See `routes/deploy.routes.ts` for the canonical example. (If you ever need to bypass the plugin and stream by hand, use `reply.hijack()` + `reply.raw` and validate before the hijack call — same ordering rule.)

## Patterns

- Business logic in `domain/`, HTTP concerns in `routes/`
- Error responses use RFC 9457: `{ type, title, status, detail }`
- Routes register as Fastify plugins via `app.register()`
- All imports use `.js` extensions (ESM requirement)
