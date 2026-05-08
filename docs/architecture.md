# Architecture

SF Project Service is a stateless Fastify REST API that manages SFDX
projects and deploys them to Salesforce orgs. All product endpoints are
served under `/v1`; operational endpoints (`/health`, `/openapi.json`,
`/docs`) are unversioned.

## System Overview

```
┌──────────────────────────────────────────┐
│         Client (IDE, CLI, etc.)          │
└────────────────────┬─────────────────────┘
                     │ HTTP/JSON + SSE
                     ▼
┌──────────────────────────────────────────┐
│      Fastify Application (src/app.ts)    │
│  ┌────────────────────────────────────┐  │
│  │ Plugins                            │  │
│  │ ├─ @fastify/cors                   │  │
│  │ ├─ @fastify/sse  (heartbeat 15s)   │  │
│  │ ├─ @fastify/swagger + swagger-ui   │  │
│  │ └─ routes (prefix: /v1)            │  │
│  └────────────────────────────────────┘  │
│                   │                       │
│  ┌────────────────▼────────────────────┐  │
│  │ routes/ (HTTP layer)                │  │
│  │ ├─ templates.routes.ts              │  │
│  │ ├─ projects.routes.ts               │  │
│  │ ├─ deploy.routes.ts                 │  │
│  │ └─ fs-events.routes.ts              │  │
│  └────────────────┬────────────────────┘  │
│                   │                       │
│  ┌────────────────▼────────────────────┐  │
│  │ domain/ (business logic)            │  │
│  │ ├─ templates.ts                     │  │
│  │ ├─ projects.ts                      │  │
│  │ ├─ deploy.ts  (SDR integration)     │  │
│  │ ├─ deploy-auth.ts (zero-auth)       │  │
│  │ ├─ auth.ts                          │  │
│  │ ├─ files.ts                         │  │
│  │ ├─ build.ts  (Vite for React)       │  │
│  │ └─ watcher.ts (fs-events)           │  │
│  └────────────────┬────────────────────┘  │
│                   │                       │
│  ┌────────────────▼────────────────────┐  │
│  │ Cross-cutting                       │  │
│  │ ├─ errors.ts (RFC 9457)             │  │
│  │ ├─ config.ts (env resolution)       │  │
│  │ ├─ logger.ts (Pino)                 │  │
│  │ └─ deployments.ts (in-memory store) │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
         │                  │
         ▼                  ▼
┌───────────────────┐ ┌──────────────────────┐
│ File System       │ │ Salesforce Org       │
│                   │ │                      │
│ ├─ templates/     │ │ ├─ Metadata API      │
│ ├─ projects/      │ │ └─ ConfigAggregator  │
│ └─ dist/          │ │    (local .sf auth)  │
└───────────────────┘ └──────────────────────┘
```

Business logic lives in `src/domain/`; HTTP wiring lives in
`src/routes/`. Routes are thin and delegate to domain functions, which
are framework-agnostic and testable in isolation.

## Request Flow

### Project Creation Flow

```
POST /v1/projects { template?: "...", orgAlias?: "..." }
  │
  ├─→ Validate body (Typebox schema, additionalProperties: false)
  │   └─→ 400 Bad Request on unknown fields
  │
  ├─→ Branch on presence of `template`:
  │   ├─ Template-based: createProject(template)
  │   │   ├─→ Validate templateId against on-disk template dir
  │   │   │   └─→ TemplateNotFoundError → 400
  │   │   ├─→ Generate UUID
  │   │   ├─→ Unzip templates/dist/<id>/content.zip
  │   │   │   into projects/<uuid>/
  │   │   └─→ Write .project-meta.json (creation time,
  │   │       name, initialMessages if template had any)
  │   │
  │   └─ Blank: createBlankProject(orgAlias?)
  │       ├─→ Reject empty-string orgAlias (OrgAliasEmptyError → 400)
  │       ├─→ Scaffold minimal sfdx-project.json + force-app/
  │       └─→ If orgAlias supplied, pin project target-org
  │
  └─→ Return 201 Created { id, name, lastAccessedAt,
                           initialMessages? }
```

### Deployment Flow

Deployments are **asynchronous**. The POST returns a `deploymentId`
immediately; progress streams over SSE.

```
POST /v1/projects/:id/deployments { orgAlias? }
  │
  ├─→ Validate body (orgAlias minLength: 1 rejects "")
  │
  ├─→ getProjectDir(id)
  │   └─→ ProjectNotFoundError → 404
  │
  ├─→ resolveDeployAuth(projectDir, body.orgAlias)
  │   zero-auth priority chain:
  │   1. body.orgAlias                  (caller override)
  │   2. SF_TARGET_ORG / SFDX_TARGET_ORG env
  │   3. Project target-org (<projectDir>/.sf/config.json)
  │   4. Global default org ($HOME/.sf/config.json)
  │   5. { type: 'missing' }            → 400 Bad Request
  │   └─→ { type: 'unresolved-alias' }  → 400 Bad Request
  │
  ├─→ buildConnectionFromAuth(auth)
  │   ├─→ AuthInfo.create({ username }) reads local SFDX keychain
  │   ├─→ Connection.refreshAuth() proactively refreshes token
  │   └─→ On failure: DeploymentError → 502 Bad Gateway
  │
  ├─→ createDeployment(projectId) → deploymentId
  │
  ├─→ Kick off deployMetadataAsync(deploymentId, projectDir, auth)
  │   in the background (non-blocking)
  │
  └─→ Return 202 Accepted { deploymentId, status: 'Queued' }

   (async, in background)
   deployMetadataAsync:
     ├─ If hasReactFiles(projectDir): runViteBuild()
     │
     ├─ readDeployStages(projectDir) — from template.json
     │  │
     │  ├─ staged branch (template.json declares deployStages)
     │  │   for each stage (in order):
     │  │     ├─ emit `stage` SSE event
     │  │     ├─ ComponentSet.fromManifest(stage.manifest)
     │  │     ├─ runOneDeploy → emits `progress` events
     │  │     ├─ required stage failure → abort remaining stages
     │  │     └─ optional stage failure → emit `warning`, continue
     │  │
     │  └─ legacy single-pass branch (no deployStages)
     │     ├─ buildComponentSet from sfdx-project.json
     │     │    packageDirectories
     │     └─ runOneDeploy → emits `progress` events
     │
     ├─ setDeploymentResult(id, result)
     │  result.status ∈ { Succeeded, SucceededWithWarnings, Failed }
     │  appUrl set on success if UIBundle present
     │
     └─ ...connected SSE streams observe the result and emit `complete`

GET /v1/projects/:id/deployments/:deploymentId/events
  (Accept: text/event-stream required; missing → 400)
  │
  ├─→ preHandler validates project + deployment existence (→ 404)
  ├─→ Replays all prior `stage` / `progress` / `warning` events
  │   recorded in the in-memory deployments store (reconnect-safe)
  ├─→ If deployment already completed, emit `complete` and close
  └─→ Otherwise poll every 100ms for new events until the deployment
      reaches a terminal state, then emit `complete` and close
```

## Module Responsibilities

### `index.ts`
Server entry point. Calls `createApp()` and `app.listen()`. Excluded
from coverage.

### `app.ts`
Fastify app factory:
- Attaches Pino logger
- Customises Ajv validation (`removeAdditional: false` so `additionalProperties: false` reliably rejects typos)
- Registers `@fastify/cors`, `@fastify/sse` (15-second heartbeat), `@fastify/swagger`, `@fastify/swagger-ui`
- Registers `routes` under `/v1`
- Registers `GET /health` and `GET /openapi.json` outside the prefix
- Installs `setNotFoundHandler` and `setErrorHandler` that emit RFC 9457 problem+json
- Closes filesystem watchers on graceful shutdown (`onClose` hook)

### `config.ts`
Environment-backed configuration:
- `getProjectsRoot()` — resolves `PROJECTS_ROOT` or `./projects`
- `getTemplatesDir()` — resolves `TEMPLATES_DIR` or the package-local `templates/dist/`
- `getRoutingPrefix()` — optional reverse-proxy prefix used by Swagger UI's "Try it out"

### `logger.ts`
Pino logger singleton. Attached as the Fastify `loggerInstance`,
producing structured JSON logs for every request.

### `errors.ts`
RFC 9457 Problem Details helpers and error classes:
- `PROBLEM_JSON` — `application/problem+json` content-type constant
- `problemDetail(status, title, detail)` — builds a problem object
- `errorToProblem(err)` — maps custom errors to the correct status
- Error classes: `TemplateNotFoundError` (400), `ProjectNotFoundError` (404), `OrgAliasEmptyError` (400), `DeploymentError` (502), `DeploymentNotFoundError` (404), `BuildError` (500)

### `deployments.ts`
In-memory deployment store. Holds lifecycle state, queued/replayable
SSE events (`stage`, `progress`, `warning`), and terminal results for
each deployment. Shared by `POST /deployments` and `GET
/deployments/:deploymentId/events`.

### `domain/templates.ts`
- `listTemplates()` reads `templates/dist/<id>/template.json` for each
  subdirectory, skipping entries declared `visible: false`
- Returns `{ id, name, description, categories }[]`, sorted by id

### `domain/projects.ts`
- `createProject(templateId)` — unzips `templates/dist/<id>/content.zip`
  into a UUID-named directory, writes `.project-meta.json`
- `createBlankProject(orgAlias?)` — scaffolds a minimal blank project
- `listProjects()` / `getProject(id)` / `renameProject(id, name)`
- `getProjectDir(id)` — validates UUID and returns absolute path
- `updateLastAccessed(projectDir)` — bumps the access timestamp
  with atomic write-then-rename to prevent partial-write corruption

### `domain/deploy-auth.ts`
Zero-auth resolution for deployments.
- `resolveDeployAuth(projectDir, bodyAlias?)` returns one of:
  - `{ type: 'environment', username }` — success
  - `{ type: 'unresolved-alias', alias }` — caller-supplied alias does
    not resolve to a username
  - `{ type: 'missing' }` — no auth source available
- Delegates env/project/global precedence to `ConfigAggregator`
- Lives in its own file so tests can `vi.mock('./auth.js')` to stub
  `resolveAlias`

### `domain/deploy.ts`
Salesforce metadata deployment:
- `buildConnectionFromAuth(auth)` — creates a `@salesforce/core`
  `Connection` from a resolved username, proactively refreshing the
  access token up front
- `readDeployStages(projectDir)` — parses `template.json`'s
  `deployStages`; throws `BuildError` on malformed shape or manifest
  path traversal attempts
- `deployMetadataAsync(deploymentId, projectDir, auth)` — runs
  single-pass or staged deploy in the background, streaming events
  into the deployment store

### `domain/build.ts`
React/Vite build pipeline. `hasReactFiles(projectDir)` triggers
`runViteBuild(projectDir)` before deploy so UIBundle-bearing stages
ship the latest built assets.

### `domain/files.ts`
- `buildTree(name?, dir)` — recursive directory tree
- `readFile(path, projectDir)` — guarded file read (path-traversal,
  restricted path, binary-check)

### `domain/watcher.ts`
Chokidar-based filesystem watcher feeding `fs-events.routes.ts`. A
single `watcherManager` owns active watchers; `app.ts` closes them on
shutdown.

### `domain/auth.ts`
Thin `@salesforce/core` wrapper. `resolveAlias(alias)` maps a
Salesforce alias to a username via the SFDX config.

### Routes (`routes/*.ts`)
Fastify plugin routers. Each one is registered in `routes/index.ts`:
- `templates.routes.ts` — `GET /templates`
- `projects.routes.ts` — `POST/GET/PATCH /projects`, `GET /projects/:id/file`, `GET /projects/:id/tree`
- `deploy.routes.ts` — `POST /projects/:id/deployments`, `GET /projects/:id/deployments/:deploymentId/events` (SSE)
- `fs-events.routes.ts` — `GET /projects/:id/fs/events` (SSE)

Routes validate request shape via Typebox schemas, delegate to
`domain/`, and translate domain errors into problem+json responses.

## Security Architecture

### Input Validation

1. **Typebox schemas** on every route with `additionalProperties:
   false`. The Ajv instance is configured with `removeAdditional:
   false` so unknown fields surface as `400 Bad Request` instead of
   being silently dropped.
2. **UUID validation** in `getProjectDir` — non-UUID IDs are treated
   as "not found", preventing path traversal via crafted IDs.
3. **`orgAlias` minLength: 1** on both `POST /v1/projects` and `POST
   /v1/projects/:id/deployments` — empty strings are rejected at the
   schema layer with `400 Bad Request`.
4. **Manifest-path traversal guard** in `readDeployStages` —
   `template.json`'s `deployStages[i].manifest` must resolve to a
   path inside the project directory.
5. **File-read restrictions** in `GET /projects/:id/file` — rejects
   path traversal, restricted paths (`.git/`, `.sf/`,
   `node_modules/`), dotfiles, and directory targets.

### Error Handling

- RFC 9457 Problem Details for every error response.
- Stack traces logged (Pino) but never returned to the client.
- Custom error classes map to specific HTTP status codes via
  `errorToProblem`.
- Fastify `setErrorHandler` catches anything else and returns `500
  Internal Server Error` (with stack logged).

### Authentication

Zero-auth model (no caller-supplied tokens):
- Callers either declare `orgAlias` in the body or rely on the
  env/project/global precedence chain.
- The service resolves the alias to a username via SFDX config files
  and builds a `@salesforce/core` `Connection` server-side.
- `Authorization` and `X-Salesforce-Instance-Url` request headers are
  **not** part of the contract. They are ignored.
- Access tokens are read from the local SFDX keychain, never from
  the wire, never logged, never cached by this service.

### Filesystem Operations

- Project directories are created under `PROJECTS_ROOT` only.
- Project-meta writes go through atomic write-then-rename so a
  crash mid-write cannot corrupt the metadata file.
- Template extraction failures clean up the created project
  directory (best-effort).

## Data Flow

### Project Storage

```
projects/
├── 550e8400-e29b-41d4-a716-446655440000/
│   ├── .project-meta.json         # creation time, name, initialMessages?
│   ├── sfdx-project.json
│   ├── force-app/
│   │   └── main/default/
│   │       ├── classes/
│   │       └── ...
│   └── template.json              # optional, declares deployStages
└── 660f9500-f30c-52e5-b827-557766551111/
    └── ...
```

Each project is isolated in its own directory. No shared state across
projects.

### Template Structure

```
templates/
├── src/                             # checked-in source templates
│   ├── data-curator/
│   │   ├── template.json            # { id, name, description, categories }
│   │   └── content/                 # files that ship to projects/<id>/
│   │       ├── template.json        # { deployStages: [...] } (optional)
│   │       ├── sfdx-project.json
│   │       ├── force-app/
│   │       ├── manifest/
│   │       └── ...
│   ├── local-react-test/
│   ├── metadata-ownership-tracking/
│   └── work-tracking/
└── dist/                            # built by scripts/zip-templates.js
    └── <id>/
        ├── template.json            # listing metadata
        └── content.zip              # extracted into each new project
```

`scripts/zip-templates.js` zips `src/<id>/content/` into
`dist/<id>/content.zip` at build time (run via `npm run build` /
`npm run dev` / `pretest`).

## Deployment Architecture

Deployment uses **`@salesforce/source-deploy-retrieve`** (SDR):

1. The POST handler validates auth and hands work off to
   `deployMetadataAsync` in the background. Clients get a
   `deploymentId` immediately.
2. `deployMetadataAsync` reads the project's `template.json`:
   - If `deployStages` is present, runs each manifest-based deploy in
     order (multi-stage). Optional stages that fail emit a `warning`
     event; required failures abort the rest.
   - Otherwise, builds a `ComponentSet.fromSource()` from the
     `packageDirectories` in `sfdx-project.json` and runs a single
     deploy.
3. As SDR polls status updates, the handler records `stage`,
   `progress`, and `warning` events into the in-memory deployments
   store.
4. On terminal state, the store receives a result and any open SSE
   stream emits `complete`.

The SSE endpoint is **reconnect-safe** — reconnecting replays all
recorded events and, if the deploy is already finished, emits
`complete` and closes immediately. Tests rely on this to poll for
completion by reopening the stream.

For React-based templates (those whose content includes `.tsx`/`.jsx`
files), `runViteBuild` produces the built assets on disk before the
deploy runs, so UIBundle-bearing stages ship the latest bundle. React
templates also require the target org to have **Agentforce Vibe for
Multi-Framework (Beta)** enabled (see `docs/api.md`).

### SSE Events

| Event      | When                                                | Payload                                                                                            |
| ---------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `start`    | Immediately on subscription                         | `{ deploymentId }`                                                                                 |
| `stage`    | Before each stage of a staged deploy                | `{ deploymentId, name, index, total }`                                                             |
| `progress` | On every SDR status update                          | `{ deploymentId, timestamp, status, numberComponentsDeployed, numberComponentsTotal, components }` |
| `warning`  | After an **optional** stage fails                   | `{ stage, errorMessage }`                                                                          |
| `complete` | Terminal state. Stream closes after this event.     | `{ deploymentId, status, numberComponents*, components, stages?, warnings?, failedStage?, appUrl? }` |

## Testing Architecture

Three tiers:
- **Unit tests** (`tests/unit/`) — pure functions, no I/O
- **Integration tests** (`tests/integration/`) — Fastify app, real
  filesystem, mocked `@salesforce/core`/SDR
- **Spec tests** (`spec/**/*.spec.ts`) — executable contracts
  (Contract-Driven Development)
- **Live tests** (`tests/live/`, `test:deploy:live`) — opt-in, hits a
  real Salesforce org, deploys every template end-to-end

Coverage threshold: 90% overall, 85% per file on branches. See
`tests/CLAUDE.md` for per-tier conventions and
[development.md](./development.md) for the commands.

## Deployment Considerations

### Horizontal Scaling

The service is stateless apart from the in-memory deployments store:
- `projects/` can be on shared EFS.
- `templates/dist/` can be on shared read-only storage (built in CI).
- The **deployments store is per-process** — an individual deployment
  ID is only visible to the instance that created it. A reverse
  proxy must pin the SSE stream to the same instance as the POST, or
  the deployments store must be externalised before running multi-instance.

### Environment Variables

```bash
PORT=3000                         # HTTP port
PROJECTS_ROOT=/mnt/efs/projects   # Parent dir for created projects
TEMPLATES_DIR=/app/templates/dist # Built templates directory
ROUTING_PREFIX=/project-service   # Optional — populates Swagger UI's
                                  # OpenAPI `servers` entry when proxied
SF_TARGET_ORG=<alias>             # Optional — per-shell deploy target
                                  # (step 2 in the zero-auth chain)
```

### npm Package

The service is distributed as an npm tarball (`npm pack`). Consumers
install it and start via `node dist/index.js`. See the `npm-package`
contract spec for tarball shape requirements.
