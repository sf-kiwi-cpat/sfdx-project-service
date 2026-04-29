# SF Project Service

REST API for template-based Salesforce project creation and metadata deployment. Supports creating projects from pre-built SFDX templates and deploying them to Salesforce orgs using SDR.

## Quick Start

```bash
npm install
npm run dev              # starts Fastify on port 3000 with watch mode
```

## API

Product endpoints are served under the `/v1` prefix and cover templates,
projects, file reads, metadata deployments (async + SSE), and filesystem
change events (SSE). See [docs/api.md](docs/api.md) for the full endpoint
reference — request bodies, response shapes, error codes, and examples.

Operational endpoints exist outside `/v1` and are unversioned: `GET /health`
(liveness probe), `GET /openapi.json` (OpenAPI 3.0 spec), and `GET /docs`
(interactive Swagger UI).

## Template System

Templates are zipped SFDX projects stored in the `templates/` directory. Each `.zip` contains `sfdx-project.json` and package directories with metadata.

The authoritative list of available templates is returned by
[`GET /v1/templates`](docs/api.md#templates). Each template's
`template.json` declares its name, description, and visibility —
templates declared `visible: false` are excluded from the listing.

`POST /v1/projects` unzips the named template into a UUID-named
directory under `PROJECTS_ROOT`. The returned project ID is used in
subsequent `/v1/projects/:id/*` calls.

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

## Error Responses

All errors follow [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457.html)
with `Content-Type: application/problem+json`. See
[Error Handling in docs/api.md](docs/api.md#error-handling) for the
response shape and per-endpoint error codes.
