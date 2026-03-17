# SF Project Service Spec

## Overview

The SF Project Service is a REST API for template-based Salesforce project creation and metadata deployment. It lets clients create projects from pre-built SFDX templates, browse project files, and deploy metadata to Salesforce orgs.

## Relationship to Agent Service

The **Agent Service** is a separate REST API that wraps an AI Coding Assistant agent (e.g. Gemini CLI, Claude Code, Cline). It runs the agent in the cloud and abstracts away the implementation details of which agent is being used. Its endpoints are about managing chats and messages — sufficient to build an agentic chat experience (e.g. a Slack bot) but nothing about projects or files.

The **SF Project Service** is the complement: it provides project and file operations but has no concept of agents or chat.

Together, these two services compose the backend for [[App Studio (Program)|App Studio]] (FKA Easy Vibes). The App Studio UI is a lightweight IDE that:
- Uses the **SF Project Service** for project creation, file browsing, and deployment
- Uses the **Agent Service** via a chat panel for vibe coding

## Deployment Model

For the steel thread (and likely MVP), the SF Project Service runs in the **same container** as the Agent Service. Both are separate Node.js processes sharing the same OS and EFS mount.

If the services need to scale independently in the future, they can be separated into distinct containers.

## Repository

The SF Project Service starts in its **own repo** for the steel thread. Key reasons:
- The two services are built by **different teams** — shared repos between teams create friction (merge conflicts, competing CI, unclear ownership)
- Enforces the clean boundary between services — no accidental coupling via internal imports
- Enables moving fast without coordinating repo conventions with another team

The container build (Dockerfile) pulls from both repos to colocate them at deploy time.

### Future: Consolidation into `agentic-dx`

There is a program-level monorepo at `forcedotcom/agentic-dx` (`@forcedotcom/agentic-dx`) that currently houses `agentic-dx-core` (Salesforce gateway auth + shared utilities) and `llm-gateway-sdk`. The Project Service will likely depend on `agentic-dx-core` for org auth.

Once the program aligns on the role and ownership model for this monorepo, the Project Service may migrate into it as a `packages/project-service` workspace. For now, starting separately avoids blocking on that alignment while keeping the door open.

## Tech Stack

- **Runtime:** Node.js >= 20 (ESM)
- **Language:** TypeScript
- **Framework:** Express
- **Testing:** vitest
- **Linting/Formatting:** ESLint + Prettier
- **Key libraries:** `@salesforce/core`, `@salesforce/source-deploy-retrieve`, `adm-zip`

Conventions align with those established in the `agentic-dx` repo to ease future consolidation.

Node.js is the preferred language. Key reasons:
- Native access to `@salesforce/core` and `@salesforce/source-deploy-retrieve` as libraries (no subprocess overhead)
- Alignment with sf CLI and the broader Salesforce DX toolchain
- Lower memory footprint (~50-150MB vs ~300-500MB+ for JVM)

## API Surface (Steel Thread)

The steel thread aims for the minimum set of endpoints needed to build a rough UI on top of the service.

| Endpoint | Description |
| :--- | :--- |
| `GET /templates` | List available project templates |
| `POST /projects` | Create a project from a template (body: `{ "template": "..." }`) |
| `GET /projects/:id/tree` | Get the file tree for a specific project |
| `POST /projects/:id/deploy` | Deploy metadata from a project to a Salesforce org (body: `{ "accessToken": "...", "instanceUrl": "..." }`) |

### Template System

Templates are pre-built SFDX projects distributed as `.zip` files in the `templates/` directory at the package root. Each zip contains a valid SFDX project structure: `sfdx-project.json` and a `force-app/` directory tree with metadata.

**Current templates:**
- `hello-world-1` — Custom Object (`Hello_World__c`) with custom fields (`Description__c`, `Priority__c`)
- `hello-world-2` — React app bundled as a StaticResource

**How it works:**

- `GET /templates` reads the `templates/` directory, finds all `.zip` files, and returns `[{ id, name }]` for each. The `id` is the filename without the `.zip` extension. The `name` is derived from the `id` by replacing hyphens with spaces and title-casing.
- `POST /projects` accepts `{ "template": "<template-id>" }` in the request body. It validates the template exists, generates a UUID for the new project, creates a directory under `PROJECTS_ROOT`, and unzips the template into it. Returns `{ "id": "<uuid>" }` with status 201.
- `GET /projects/:id/tree` returns the recursive file tree for a specific project, scoped to the project's directory.

Projects are identified by UUID and stored as subdirectories of `PROJECTS_ROOT`. The project ID is validated as a UUID pattern to prevent path traversal. A `ProjectNotFoundError` (404) is returned if the project directory does not exist.

### Metadata Deployment

`POST /projects/:id/deploy` deploys metadata from a project to a Salesforce org using `@salesforce/source-deploy-retrieve` (SDR) as a TypeScript library.

**How it works:**

1. **Credentials** — provided per-request in the body as `{ "accessToken": "...", "instanceUrl": "..." }`. The service is stateless with respect to credentials; no tokens are stored at rest. A `Connection` is built from `@salesforce/core`'s `AuthInfo` for each request.
2. **Project validation** — the project ID from the URL path is validated as a UUID and checked against the filesystem. Returns 404 if the project does not exist.
3. **Metadata** — read from disk using SDR's `ComponentSet.fromSource()`, pointed at the package directories declared in the project's `sfdx-project.json`. This supports any valid SFDX project structure, including CustomObjects, CustomFields, StaticResources, Apex classes, and any other metadata type SDR can resolve.
4. **Deploy** — SDR's `deploy()` pushes the resolved components to the Metadata API via SOAP. The endpoint blocks while `pollStatus()` polls for completion.
5. **Result mapping** — SDR's `DeployResult` is mapped to the service's own response shape. SDR types are not leaked through the API.

**Input:** `{ "accessToken": "...", "instanceUrl": "..." }` in the request body.

**Output (200):**
```json
{
  "ok": true,
  "status": "Succeeded",
  "numberComponentsDeployed": 3,
  "numberComponentsTotal": 3,
  "components": [
    { "fullName": "Hello_World__c", "type": "CustomObject", "state": "Created" },
    { "fullName": "Hello_World__c.Description__c", "type": "CustomField", "state": "Created" },
    { "fullName": "Hello_World__c.Priority__c", "type": "CustomField", "state": "Created" }
  ]
}
```

**Error responses:**
- `400 Bad Request` — missing `accessToken` or `instanceUrl` in the request body
- `404 Project Not Found` — project ID does not exist
- `502 Bad Gateway` — deployment failed (SDR errors, connection errors, metadata validation failures). 502 is used because the service is proxying to Salesforce's Metadata API — the upstream is the source of the failure.

All errors follow RFC 9457 (Problem Details for HTTP APIs).

**Design choices:**
- Per-request credentials — stateless, no credentials at rest, supports deploying to any org
- Synchronous — blocks while SDR polls; fine for small payloads, will need async job pattern for template-scale deploys
- The acceptance test suite (`deploy.acceptance.test.ts`) is the canonical specification for this endpoint's contract

### Deferred (Post-Steel Thread)

These operations are valuable but can wait. In the near term, the agent can handle them via its own toolchain.

- Retrieve from org
- Run tests
- Rename / move file
- Create directory (if not handled by auto-creating parents on write)

## Demo UI

A local-only Vite+React demo UI lives in the `ui/` directory (gitignored). It is a development/testing tool for exercising the API locally — not deployed with the service.

## Definition of Done (Steel Thread)

The steel thread is complete when all endpoints in the API surface above are functional and can be **explored, tested, and demoed using curl** (or a similar HTTP client). No UI is required. A teammate will build the App Studio UI against these endpoints as a separate effort.


## Authentication

**Org auth (connecting to Salesforce):** Credentials (`accessToken` and `instanceUrl`) are passed per-request in the body of `POST /projects/:id/deploy`. The service is stateless with respect to credentials — no tokens are stored at rest. The VaaS infrastructure handles the actual OAuth flow with the user upstream; the Project Service is just a consumer of the resulting token.

**Endpoint auth (securing the API):** Not required for the steel thread. The container is a single-user environment behind the VaaS infrastructure, which serves as the trust boundary. Endpoint-level auth can be added later if the deployment model changes.

## Configuration

Environment variables control deployment settings:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Server port |
| `PROJECTS_ROOT` | `{cwd}/projects` | Root directory for template-created projects (each project gets a UUID subdirectory) |
| `TEMPLATES_DIR` | `{package-root}/templates` | Directory containing template `.zip` files |

## Implementation Guidelines

### Error Responses

All error responses follow **RFC 9457** (Problem Details for HTTP APIs). Every error returns `Content-Type: application/problem+json` with a consistent shape:

```json
{
  "status": 404,
  "title": "File Not Found",
  "detail": "No file exists at path 'force-app/main/default/classes/Foo.cls'"
}
```

Required fields for the steel thread: `status`, `title`, `detail`. The optional `type` and `instance` fields can be added as the service matures.

### Logging

Use `pino` (with `pino-http` for Express middleware). Logs are structured JSONL to stdout — one JSON object per line, captured automatically by the container runtime.

**Levels:** `error`, `warn`, `info`, `debug`. Default to `info` in production.

- `error` — something failed that shouldn't have (unhandled exception, filesystem error)
- `warn` — something suspect but handled (e.g., invalid request parameters)
- `info` — routine operations (request completed, project created, deployment succeeded)
- `debug` — verbose detail useful during development only

**Request log fields** (emitted automatically by `pino-http` middleware):

| Field | Example |
| :--- | :--- |
| `timestamp` | `2026-02-12T18:30:00.000Z` |
| `level` | `info` |
| `method` | `GET` |
| `path` | `/projects/abc-123/deploy` |
| `statusCode` | `200` |
| `durationMs` | `12` |

For `error`-level logs, include the stack trace.

**Never log customer data.** This includes file contents, auth tokens, and anything the user manually provided. Salesforce does not log customer data — certainly not in plain text. When in doubt, log the *shape* of the data (e.g., file path, byte count) rather than the data itself.

### Testing

The test suite is the **executable specification**. It should be written with enough clarity — descriptive `describe`/`it` blocks, comments where the code isn't self-explanatory — that a reader could reverse-engineer this spec from the tests alone. The tests are the source of truth; this document is the starting point.

**Unit tests** cover internal logic (path resolution, error mapping, request validation). **Integration tests** exercise the real HTTP endpoints using `supertest` against the Express app. Both levels should have thorough coverage.

Integration tests are especially important here: every endpoint in the API surface should have tests that verify the happy path, relevant error cases (missing file, invalid path, etc.), and the correct RFC 9457 error response shape. These tests should read as behavioral statements — e.g., `it('returns 404 with RFC 9457 problem detail when file does not exist')`.
