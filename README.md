# SF Project Service

REST API wrapping an SFDX project for remote IDE-like operations. Supports template-based project creation, file browsing, and metadata deployment to Salesforce orgs.

## Quick Start

```bash
# API server
npm install
npm run dev              # starts Express on port 3000 with watch mode

# Demo UI (separate terminal)
cd ui
npm install
npm run dev              # starts Vite dev server on port 5173, proxies API to :3000
```

## API Endpoints

### Template & Project Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/templates` | GET | List available project templates |
| `/projects` | POST | Create a project from a template (`{ "template": "hello-world-1" }`) |
| `/projects/:id/tree` | GET | Get the file tree for a project |
| `/projects/:id/deploy` | POST | Deploy project metadata to a Salesforce org (`{ "accessToken", "instanceUrl" }`) |

### Single-Project Endpoints (Legacy)

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/project/tree` | GET | Return the full directory/file tree |
| `/project/file?path=...` | GET | Read a file |
| `/project/file?path=...` | PUT | Create or overwrite a file |
| `/project/file?path=...` | DELETE | Delete a file |
| `/project/events` | GET | SSE stream of filesystem change events |

### Internal Lock API

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/internal/lock` | POST | Acquire write lock |
| `/internal/lock` | PATCH | Renew write lock (`{ "lockId" }`) |
| `/internal/lock` | DELETE | Release write lock (`{ "lockId" }`) |

Interactive API docs (Swagger UI) are available at `/docs` when the server is running.

## Template System

Templates are zipped SFDX projects stored in the `templates/` directory. Each `.zip` contains `sfdx-project.json` and a `force-app/` directory tree with metadata.

**Available templates:**
- `hello-world-1` -- Custom Object with custom fields
- `hello-world-2` -- React app as a StaticResource

`POST /projects` unzips a template into a UUID-named directory under `PROJECTS_ROOT`. The returned project ID is used in subsequent `/projects/:id/*` calls.

## Demo UI

An ephemeral Vite+React app in `ui/` that demonstrates the full flow:

1. **Login** -- OAuth PKCE flow authenticates directly with Salesforce
2. **Template selection** -- pick a template from the available list
3. **Project creation** -- creates a new project from the selected template
4. **File tree** -- browse the project's file structure
5. **Deploy** -- deploy the project metadata to your authenticated org

In development, run `cd ui && npm run dev` alongside `npm run dev` for the API. The Vite dev server proxies API requests to port 3000.

For production, build the UI (`cd ui && npm run build`) and the Express server serves the static files from `ui/dist/` automatically.

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Server port |
| `PROJECT_ROOT` | `cwd()` | SFDX project directory (for legacy `/project/*` endpoints) |
| `PROJECTS_ROOT` | `{cwd}/projects` | Root directory for template-created projects |
| `TEMPLATES_DIR` | `{package-root}/templates` | Directory containing template `.zip` files |

## Testing

```bash
npm test                 # run all tests
npm run test:unit        # unit tests only
npm run test:integration # integration tests only
npm run test:coverage    # all tests with coverage report (90% threshold)
npm run lint             # eslint
```

## Docker

```bash
npm run build
docker build -t sf-project-service .
docker run -p 3000:3000 sf-project-service
```

## Error Responses

All errors follow RFC 9457 (Problem Details) with `Content-Type: application/problem+json`:

```json
{
  "status": 404,
  "title": "File Not Found",
  "detail": "No file exists at path 'force-app/main/default/classes/Foo.cls'"
}
```
