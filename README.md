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

## API (Steel Thread)

| Endpoint | Description |
| :--- | :--- |
| `POST /project/init` | Scaffold the SFDX project and connect the org |
| `GET /project/tree` | Return the full directory/file tree for the file explorer |
| `GET /project/file?path=...` | Read the full contents of a specific file |
| `PUT /project/file?path=...` | Create or overwrite the full contents of a file (auto-creates parent directories) |
| `DELETE /project/file?path=...` | Delete a file |
| `GET /project/events` | SSE stream of filesystem events (file created, modified, deleted) |
| `GET /oauth/authorize` | Get the Salesforce OAuth authorization URL |
| `GET /oauth/callback` | OAuth callback — Salesforce redirects here after login |
| `GET /oauth/status` | Check authentication status |
| `POST /oauth/disconnect` | Clear the OAuth session (logout) |

### Internal Lock API (for Agent Service)

| Endpoint | Description |
| :--- | :--- |
| `POST /internal/lock` | Acquire the write lock (returns lock ID) |
| `PATCH /internal/lock` | Renew the lock (body: `{ lockId }`) |
| `DELETE /internal/lock` | Release the lock (body: `{ lockId }`) |

When the lock is held, write operations (PUT, DELETE) return `409 Conflict` with an RFC 9457 problem detail.

## OAuth Authentication

To authenticate interactively with a Salesforce org:

1. Create a Connected App in your Salesforce org:
   - Setup → App Manager → New Connected App
   - Enable OAuth Settings
   - Set Callback URL: `http://localhost:3000/oauth/callback`
   - Select scopes: `api`, `refresh_token`
   - Save and copy Consumer Key and Consumer Secret

2. Start the server with OAuth credentials:
   ```bash
   SF_CLIENT_ID=your_consumer_key SF_CLIENT_SECRET=your_consumer_secret npm start
   ```

3. Get the authorization URL:
   ```bash
   curl http://localhost:3000/oauth/authorize
   ```

4. Open the returned `authorizationUrl` in your browser and log in

5. After login, Salesforce redirects back to the service. Check status:
   ```bash
   curl http://localhost:3000/oauth/status
   ```

6. For sandbox orgs, pass the sandbox login URL:
   ```bash
   curl "http://localhost:3000/oauth/authorize?loginUrl=https://test.salesforce.com"
   ```

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

# OAuth: Get authorization URL
curl http://localhost:3000/oauth/authorize

# OAuth: Check authentication status
curl http://localhost:3000/oauth/status

# OAuth: Disconnect (logout)
curl -X POST http://localhost:3000/oauth/disconnect
```

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
