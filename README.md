# SF Project Service

REST API wrapping an SFDX project for remote IDE-like operations. Exposes filesystem and project operations to clients that don't have direct filesystem access (e.g. web app, mobile app).

## Tech Stack

- **Runtime:** Node.js >= 20 (ESM)
- **Language:** TypeScript
- **Framework:** Express
- **Testing:** vitest
- **Linting/Formatting:** ESLint + Prettier
- **Key libraries:** `@salesforce/core`, `chokidar`, `pino`

## Quick Start

```bash
npm install
npm run build
npm start
```

The service listens on port 3000 (configurable via `PORT` env var). Set `PROJECT_ROOT` to the SFDX project directory (defaults to cwd).

## API Documentation

Interactive API docs (Swagger UI) are available at [`/docs`](http://localhost:3000/docs) when the server is running. The raw OpenAPI 3.0 spec is served at [`/openapi.json`](http://localhost:3000/openapi.json).

## API (Steel Thread)

| Endpoint | Description |
| :--- | :--- |
| `POST /project/init` | Scaffold the SFDX project and connect the org |
| `GET /project/tree` | Return the full directory/file tree for the file explorer |
| `GET /project/file?path=...` | Read the full contents of a specific file |
| `PUT /project/file?path=...` | Create or overwrite the full contents of a file (auto-creates parent directories) |
| `DELETE /project/file?path=...` | Delete a file |
| `GET /project/events` | SSE stream of filesystem events (file created, modified, deleted) |
### Internal Lock API (for Agent Service)

| Endpoint | Description |
| :--- | :--- |
| `POST /internal/lock` | Acquire the write lock (returns lock ID) |
| `PATCH /internal/lock` | Renew the lock (body: `{ lockId }`) |
| `DELETE /internal/lock` | Release the lock (body: `{ lockId }`) |

When the lock is held, write operations (PUT, DELETE) return `409 Conflict` with an RFC 9457 problem detail.

## Example: curl

```bash
# Scaffold project and connect org
curl -X POST http://localhost:3000/project/init \
  -H "Content-Type: application/json" \
  -d '{"accessToken":"YOUR_TOKEN","instanceUrl":"https://your-org.my.salesforce.com"}'

# Get directory tree
curl http://localhost:3000/project/tree

# Read file
curl "http://localhost:3000/project/file?path=force-app/main/default/classes/Foo.cls"

# Write file
curl -X PUT "http://localhost:3000/project/file?path=force-app/main/default/classes/Foo.cls" \
  -H "Content-Type: text/plain" \
  -d 'class Foo {}'

# Delete file
curl -X DELETE "http://localhost:3000/project/file?path=force-app/main/default/classes/Foo.cls"

# SSE events (streaming)
curl -N http://localhost:3000/project/events
```

## Docker

```bash
npm run build
docker build -t sf-project-service .
docker run -p 3000:3000 sf-project-service
```

The image expects `dist/` and `node_modules/` to be pre-built on the host (no `npm install` inside the container).

## Development

```bash
npm run dev          # Watch mode
npm test             # Run tests
npm run lint         # ESLint
npm run format       # Prettier
```

## Error Responses

All errors follow RFC 9457 (Problem Details for HTTP APIs) with `Content-Type: application/problem+json`:

```json
{
  "status": 404,
  "title": "File Not Found",
  "detail": "No file exists at path 'force-app/main/default/classes/Foo.cls'"
}
```
