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

## Patterns

- Business logic in `domain/`, HTTP concerns in `routes/`
- Error responses use RFC 9457: `{ type, title, status, detail }`
- Routes register as Fastify plugins via `app.register()`
- All imports use `.js` extensions (ESM requirement)
