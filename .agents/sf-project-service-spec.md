# SF Project Service Spec

## Overview

The SF Project Service is a REST API that wraps an SFDX project, exposing filesystem and project operations to remote clients. It knows nothing about agents or AI. Its job is to let a client that doesn't have direct filesystem access (e.g. a web app, mobile app) do things a local IDE would do: browse files, read and write source, run tests, deploy to an org, etc.

## Relationship to Agent Service

The **Agent Service** is a separate REST API that wraps an AI Coding Assistant agent (e.g. Gemini CLI, Claude Code, Cline). It runs the agent in the cloud and abstracts away the implementation details of which agent is being used. Its endpoints are about managing chats and messages — sufficient to build an agentic chat experience (e.g. a Slack bot) but nothing about projects or files.

The **SF Project Service** is the complement: it provides project and file operations but has no concept of agents or chat.

Together, these two services compose the backend for [[App Studio (Program)|App Studio]] (FKA Easy Vibes). The App Studio UI is a lightweight IDE that:
- Uses the **SF Project Service** for traditional IDE-like operations (file explorer, reading/writing files, running tests, deploying)
- Uses the **Agent Service** via a chat panel for vibe coding

Both services share a filesystem — the SFDX project on an **EFS mount** — but have distinct responsibilities.

### Filesystem Concurrency (Steel Thread)

The agent (via the Agent Service) has direct read/write access to the SFDX project on the EFS mount. For the steel thread, **write access is mutually exclusive**: when the agent is active, the Project Service locks out all write operations. The user can still read/browse files, but cannot edit until the agent completes.

This is a deliberate simplification. More sophisticated concurrency (e.g. file-level locking, operational transforms) can be explored later once the basic flow is proven.

#### Write Lock Mechanism

The Project Service owns the lock and exposes it as an internal API:

- `POST /internal/lock` — acquire the write lock (returns a lock ID, starts the TTL)
- `PATCH /internal/lock` — renew the lock (resets the TTL)
- `DELETE /internal/lock` — release the lock

The lock uses a **TTL with heartbeat renewal**. The TTL is set to cover a single agent action (not the entire session). The Agent Service acquires the lock when the agent starts, renews it between each action the agent takes, and releases it when the agent finishes. If the agent crashes mid-action, the TTL expires shortly thereafter and the lock auto-releases — no deadlock possible.

Write requests to the Project Service while the lock is held return `409 Conflict` with an RFC 9457 problem detail explaining that the agent is active.

## Deployment Model

For the steel thread (and likely MVP), the SF Project Service runs in the **same container** as the Agent Service. Both are separate Node.js processes sharing the same OS and EFS mount.

This colocation simplifies the architecture:
- Filesystem watchers (`inotify`) work because both processes share a kernel
- No inter-container networking needed
- Shared EFS mount is straightforward

If the services need to scale independently in the future, they can be separated into distinct containers. That move would require revisiting the filesystem event mechanism (e.g. switching from `inotify` to polling or a shared event bus).

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
- **Key libraries:** `@salesforce/core`, `@salesforce/source-deploy-retrieve`, `chokidar`

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
| `POST /project/init` | Scaffold the SFDX project and connect the org |
| `GET /project/tree` | Return the full directory/file tree for the file explorer |
| `GET /project/file?path=...` | Read the full contents of a specific file |
| `PUT /project/file?path=...` | Create or overwrite the full contents of a file (auto-creates parent directories) |
| `DELETE /project/file?path=...` | Delete a file |
| `GET /project/events` | SSE stream of filesystem events (file created, modified, deleted) |

### Project Initialization

`POST /project/init` does two things:

1. **Scaffold the project** — creates the SFDX project directory structure and `sfdx-project.json`. This is essentially what `sf project generate` does: a `force-app/main/default/` directory tree and a small config file declaring the package directory, source API version, and login URL.
2. **Connect the org** — registers the provided auth credentials (token or equivalent) with `@salesforce/core`'s `AuthInfo` so that subsequent sf operations (deploy, retrieve) target the correct org. The credentials are expected to come from the broader VaaS infrastructure (the user has already authenticated through the platform).

Input: an OAuth **access token** and **instance URL** for the target Salesforce org. The VaaS infrastructure is responsible for obtaining these through the user's login flow; the Project Service simply receives and registers them.
Output: 201 Created with confirmation that the project is scaffolded and the org is connected.

### Template System

Templates are pre-built SFDX projects distributed as `.zip` files in the `templates/` directory at the package root. Each zip contains a valid SFDX project structure: `sfdx-project.json` and a `force-app/` directory tree with metadata.

**Current templates:**
- `hello-world-1` — Custom Object (`Hello_World__c`) with custom fields (`Description__c`, `Priority__c`)
- `hello-world-2` — React app bundled as a StaticResource

**How it works:**

- `GET /templates` reads the `templates/` directory, finds all `.zip` files, and returns `[{ id, name }]` for each. The `id` is the filename without the `.zip` extension. The `name` is derived from the `id` by replacing hyphens with spaces and title-casing.
- `POST /projects` accepts `{ "template": "<template-id>" }` in the request body. It validates the template exists, generates a UUID for the new project, creates a directory under `PROJECTS_ROOT`, and unzips the template into it. Returns `{ "id": "<uuid>" }` with status 201.
- `GET /projects/:id/tree` returns the recursive file tree for a specific project, using the same `buildTree()` logic as `GET /project/tree` but scoped to the project's directory.

Projects are identified by UUID and stored as subdirectories of `PROJECTS_ROOT`. The project ID is validated as a UUID pattern to prevent path traversal. A `ProjectNotFoundError` (404) is returned if the project directory does not exist.

### Filesystem Events (SSE)

The `GET /project/events` endpoint is a Server-Sent Events stream that pushes real-time filesystem change notifications to the client. Under the hood, a `chokidar` watcher monitors the SFDX project directory. Because both services run in the same container, `inotify` reliably detects all changes — including those made by the agent.

This lets the UI reactively update the file explorer and refresh open files without polling.

### Metadata Deployment

`POST /projects/:id/deploy` deploys metadata from a project to a Salesforce org using `@salesforce/source-deploy-retrieve` (SDR) as a TypeScript library.

**How it works:**

1. **Credentials** — provided per-request in the body as `{ "accessToken": "...", "instanceUrl": "..." }`. The service is stateless with respect to credentials; no tokens are stored at rest. A `Connection` is built from `@salesforce/core`'s `AuthInfo` for each request.
2. **Project validation** — the project ID from the URL path is validated as a UUID and checked against the filesystem. Returns 404 if the project does not exist.
3. **Metadata** — read from disk using SDR's `ComponentSet.fromSource()`, pointed at the project's `force-app/` directory. This supports any valid SFDX project structure, including CustomObjects, CustomFields, StaticResources, Apex classes, and any other metadata type SDR can resolve.
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
- No write lock integration — deploy writes to the org, not the filesystem
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

An ephemeral Vite+React demo UI lives in the `ui/` directory. It demonstrates the end-to-end flow from template selection through deployment, and serves as both a prototype and a testing tool for the API.

**Features:**
- **OAuth PKCE login** — authenticates directly with Salesforce using the browser-based OAuth 2.0 PKCE flow. The access token and instance URL are held in the browser only.
- **Template selection** — displays available templates as cards via `GET /templates`
- **Project creation** — creates a new project from a selected template via `POST /projects`
- **File tree view** — shows the project's file structure via `GET /projects/:id/tree`
- **Deploy** — deploys the project to the authenticated Salesforce org via `POST /projects/:id/deploy`, passing credentials from the PKCE flow

**Tech stack:** React 18, React Router, Vite, TypeScript.

**Development:** The UI runs its own Vite dev server (`cd ui && npm run dev`) with a proxy that forwards `/templates` and `/projects` requests to the API on port 3000.

**Production:** `cd ui && npm run build` outputs static files to `ui/dist/`. The Express server automatically serves these as static files when the directory exists.

## Definition of Done (Steel Thread)

The steel thread is complete when all endpoints in the API surface above are functional and can be **explored, tested, and demoed using curl** (or a similar HTTP client). No UI is required. A teammate will build the App Studio UI against these endpoints as a separate effort.


## Authentication

**Org auth (connecting to Salesforce):** The Project Service receives an OAuth access token and instance URL via `POST /project/init` and registers them with `@salesforce/core`. The VaaS infrastructure handles the actual OAuth flow with the user upstream via Service Mesh; the Project Service is just a consumer of the resulting token. For the template-based flow (`POST /projects/:id/deploy`), credentials are passed per-request in the body — no server-side token storage.

**Endpoint auth (securing the API):** Not required for the steel thread. The container is a single-user environment behind the VaaS infrastructure, which serves as the trust boundary. Endpoint-level auth can be added later if the deployment model changes.

## Configuration

Environment variables control deployment settings:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Server port |
| `PROJECT_ROOT` | `cwd()` | SFDX project directory (for EFS mount, used by `/project/*` endpoints) |
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
- `warn` — something suspect but handled (e.g., write rejected because agent lock is active)
- `info` — routine operations (request completed, project initialized, SSE client connected)
- `debug` — verbose detail useful during development only

**Request log fields** (emitted automatically by `pino-http` middleware):

| Field | Example |
| :--- | :--- |
| `timestamp` | `2026-02-12T18:30:00.000Z` |
| `level` | `info` |
| `method` | `GET` |
| `path` | `/project/file?path=force-app/main/default/classes/Foo.cls` |
| `statusCode` | `200` |
| `durationMs` | `12` |

For `error`-level logs, include the stack trace.

**Never log customer data.** This includes file contents, auth tokens, and anything the user manually provided. Salesforce does not log customer data — certainly not in plain text. When in doubt, log the *shape* of the data (e.g., file path, byte count) rather than the data itself.

### Testing

The test suite is the **executable specification**. It should be written with enough clarity — descriptive `describe`/`it` blocks, comments where the code isn't self-explanatory — that a reader could reverse-engineer this spec from the tests alone. The tests are the source of truth; this document is the starting point.

**Unit tests** cover internal logic (path resolution, error mapping, request validation). **Integration tests** exercise the real HTTP endpoints using `supertest` against the Express app. Both levels should have thorough coverage.

Integration tests are especially important here: every endpoint in the API surface should have tests that verify the happy path, relevant error cases (missing file, invalid path, etc.), and the correct RFC 9457 error response shape. These tests should read as behavioral statements — e.g., `it('returns 404 with RFC 9457 problem detail when file does not exist')`.
