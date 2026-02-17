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

### Project Initialization

`POST /project/init` does two things:

1. **Scaffold the project** — creates the SFDX project directory structure and `sfdx-project.json`. This is essentially what `sf project generate` does: a `force-app/main/default/` directory tree and a small config file declaring the package directory, source API version, and login URL.
2. **Connect the org** — registers the provided auth credentials (token or equivalent) with `@salesforce/core`'s `AuthInfo` so that subsequent sf operations (deploy, retrieve) target the correct org. The credentials are expected to come from the broader VaaS infrastructure (the user has already authenticated through the platform).

Input: an OAuth **access token** and **instance URL** for the target Salesforce org. The VaaS infrastructure is responsible for obtaining these through the user's login flow; the Project Service simply receives and registers them.
Output: 201 Created with confirmation that the project is scaffolded and the org is connected.

### Filesystem Events (SSE)

The `GET /project/events` endpoint is a Server-Sent Events stream that pushes real-time filesystem change notifications to the client. Under the hood, a `chokidar` watcher monitors the SFDX project directory. Because both services run in the same container, `inotify` reliably detects all changes — including those made by the agent.

This lets the UI reactively update the file explorer and refresh open files without polling.

### Deferred (Post-Steel Thread)

These operations are valuable but can wait. In the near term, the agent can handle them via its own toolchain.

- Deploy to org
- Retrieve from org
- Run tests
- Rename / move file
- Create directory (if not handled by auto-creating parents on write)

## Definition of Done (Steel Thread)

The steel thread is complete when all endpoints in the API surface above are functional and can be **explored, tested, and demoed using curl** (or a similar HTTP client). No UI is required. A teammate will build the App Studio UI against these endpoints as a separate effort.

For OAuth specifically: the flow is end-to-end testable (authorize → browser login → callback → status shows authenticated) and no sensitive data (tokens, client secret) is logged.

## Authentication

**Org auth (connecting to Salesforce):** The Project Service supports two flows for connecting to a Salesforce org:

1. **Direct token flow** (for programmatic callers): The Project Service receives an OAuth access token and instance URL via `POST /project/init` and registers them with `@salesforce/core`. The VaaS infrastructure handles the actual OAuth flow with the user; the Project Service is just a consumer of the resulting token.

2. **Interactive OAuth flow** (for manual testing and UI): Users can authenticate via `GET /oauth/authorize` → browser login → `GET /oauth/callback`. The OAuth flow implements Authorization Code with PKCE (RFC 7636) for security. After successful authentication, the service automatically calls `connectOrg()` to register credentials with `@salesforce/core`. The session is stored in-memory (lost on restart).

   - `GET /oauth/authorize` — Returns the authorization URL for the user to open in a browser
   - `GET /oauth/callback` — Salesforce redirects here after login with an authorization code
   - `GET /oauth/status` — Check if currently authenticated and get org/user details
   - `POST /oauth/disconnect` — Clear the OAuth session (logout)

**Endpoint auth (securing the API):** Not required for the steel thread. The container is a single-user environment behind the VaaS infrastructure, which serves as the trust boundary. Endpoint-level auth can be added later if the deployment model changes.

## Configuration

Environment variables control OAuth and deployment settings:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `SF_CLIENT_ID` | (none) | Connected App consumer key (required for OAuth) |
| `SF_CLIENT_SECRET` | (none) | Connected App consumer secret (required for OAuth) |
| `SF_CALLBACK_URL` | `http://localhost:{PORT}/oauth/callback` | OAuth callback URL |
| `SF_LOGIN_URL` | `https://login.salesforce.com` | Salesforce login URL (use `https://test.salesforce.com` for sandbox) |
| `SF_SCOPES` | `api refresh_token` | OAuth scopes to request |
| `PORT` | `3000` | Server port |
| `PROJECT_ROOT` | `cwd()` | SFDX project directory (for EFS mount) |

To enable OAuth, set `SF_CLIENT_ID` and `SF_CLIENT_SECRET` from a Connected App in your Salesforce org (Setup → App Manager → New Connected App → Enable OAuth Settings).

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
