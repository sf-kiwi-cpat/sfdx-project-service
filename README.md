# SF Project Service

REST API for template-based Salesforce project creation and metadata deployment. Supports creating projects from pre-built SFDX templates and deploying them to Salesforce orgs using SDR.

## Quick Start

```bash
npm install
npm run dev              # starts Express on port 3000 with watch mode
```

## API Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/templates` | GET | List available project templates |
| `/projects` | POST | Create a project from a template (`{ "template": "hello-world-1" }`) |
| `/projects/:id/tree` | GET | Get the file tree for a project |
| `/projects/:id/deploy` | POST | Deploy project metadata to a Salesforce org (`{ "accessToken", "instanceUrl" }`) |

Interactive API docs (Swagger UI) are available at `/docs` when the server is running.

## Template System

Templates are zipped SFDX projects stored in the `templates/` directory. Each `.zip` contains `sfdx-project.json` and package directories with metadata.

**Available templates:**
- `hello-world-1` -- Custom Object with custom fields
- `hello-world-2` -- React app as a StaticResource

`POST /projects` unzips a template into a UUID-named directory under `PROJECTS_ROOT`. The returned project ID is used in subsequent `/projects/:id/*` calls.

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Server port |
| `PROJECTS_ROOT` | `{cwd}/projects` | Root directory for template-created projects |
| `TEMPLATES_DIR` | `{package-root}/templates` | Directory containing template `.zip` files |

## Testing

```bash
npm test                 # run all tests
npm run test:unit        # unit tests only
npm run test:integration # integration tests only
npm run test:coverage    # all tests with coverage report
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
  "title": "Project Not Found",
  "detail": "Project not found: 00000000-0000-0000-0000-000000000000"
}
```
