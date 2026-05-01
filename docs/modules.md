# Module Reference

Detailed documentation of the modules in SF Project Service.
Production code lives under `src/`:

```
src/
├── index.ts           # entry point (excluded from coverage)
├── app.ts             # Fastify app factory
├── config.ts          # environment-backed configuration
├── logger.ts          # Pino logger singleton
├── errors.ts          # RFC 9457 helpers + error classes
├── deployments.ts     # in-memory deployment store
├── routes/            # HTTP layer (Fastify plugins)
│   ├── index.ts
│   ├── templates.routes.ts
│   ├── projects.routes.ts
│   ├── deploy.routes.ts
│   └── fs-events.routes.ts
└── domain/            # framework-agnostic business logic
    ├── templates.ts
    ├── projects.ts
    ├── deploy.ts
    ├── deploy-auth.ts
    ├── auth.ts
    ├── build.ts
    ├── files.ts
    └── watcher.ts
```

## Table of Contents

### Domain (`src/domain/`)
- [templates.ts](#domaintemplatests) — template listing
- [projects.ts](#domainprojectsts) — project lifecycle
- [deploy-auth.ts](#domaindeploy-authts) — zero-auth resolution
- [deploy.ts](#domaindeployts) — metadata deployment
- [auth.ts](#domainauthts) — `@salesforce/core` shim
- [build.ts](#domainbuildts) — React/Vite build
- [files.ts](#domainfilests) — file tree + guarded reads
- [watcher.ts](#domainwatcherts) — chokidar-backed watcher manager

### Cross-cutting (`src/`)
- [errors.ts](#errorsts) — RFC 9457 error helpers + classes
- [deployments.ts](#deploymentsts) — in-memory deployment store
- [config.ts](#configts) — environment configuration
- [logger.ts](#loggerts) — Pino logger

### Routes (`src/routes/`)
- [templates.routes.ts](#templatesroutests)
- [projects.routes.ts](#projectsroutests)
- [deploy.routes.ts](#deployroutests)
- [fs-events.routes.ts](#fs-eventsroutests)

---

## domain/templates.ts

Template discovery and listing. Templates live on disk at
`templates/dist/<id>/` (produced by `scripts/zip-templates.js`). Each
directory contains a `template.json` metadata file and a
`content.zip` (zipped at build time from `templates/src/<id>/content/`).

### Exports

```typescript
interface Template {
  id: string;
  name: string;
  description: string;
  categories: string[];
}

async function listTemplates(): Promise<Template[]>
```

`listTemplates()` reads each `templates/dist/<id>/template.json`,
skips entries with `visible: false`, and returns the rest sorted by
`id`. Directories without a parseable `template.json` are silently
skipped.

---

## domain/projects.ts

Project lifecycle: create (from template or blank), list, retrieve,
rename, resolve on-disk directory.

### Exports (selected)

```typescript
interface Message { role: 'user' | 'assistant'; content: string }

async function createProject(templateId: string): Promise<{
  id: string;
  name: string;
  lastAccessedAt: string;
  initialMessages?: Message[];
}>;

async function createBlankProject(orgAlias?: string): Promise<{
  id: string;
  name: string;
  lastAccessedAt: string;
}>;

async function listProjects(): Promise<Array<{
  id: string;
  name: string;
  lastAccessedAt: string;
}>>;

async function getProject(id: string): Promise<{
  id: string;
  name: string;
  lastAccessedAt: string;
  initialMessages?: Message[];
}>;

async function renameProject(id: string, name: string): Promise<...>;

async function getProjectDir(projectId: string): Promise<string>;
async function updateLastAccessed(projectDir: string): Promise<void>;
```

Behavior notes:
- `createProject` unzips `templates/dist/<templateId>/content.zip`
  into a new UUID-named directory under `PROJECTS_ROOT` and writes
  `.project-meta.json`. If the template's `content/template.json`
  declares a non-empty `initialMessages`, they're copied into project
  meta and surfaced in the response.
- `createBlankProject(orgAlias?)` scaffolds a minimal
  `sfdx-project.json` + `force-app/` layout. An empty-string
  `orgAlias` throws `OrgAliasEmptyError` (HTTP 400).
- `getProject` and `updateLastAccessed` bump `lastAccessedAt` using
  an atomic write-then-rename to prevent meta-file corruption.
- `getProjectDir` validates the UUID shape and that the directory
  exists; otherwise throws `ProjectNotFoundError` (HTTP 404).

### Errors
`TemplateNotFoundError`, `ProjectNotFoundError`, `OrgAliasEmptyError`
(defined in [errors.ts](#errorsts)).

---

## domain/deploy-auth.ts

Zero-auth resolution for deployments. The service never accepts
caller-supplied access tokens — it resolves an alias to a locally-
authed Salesforce username server-side.

### Exports

```typescript
type ResolvedAuth = { type: 'environment'; username: string };

type AuthResolution =
  | ResolvedAuth
  | { type: 'missing' }
  | { type: 'unresolved-alias'; alias: string };

async function resolveDeployAuth(
  projectDir: string,
  bodyAlias?: string,
): Promise<AuthResolution>;
```

Priority chain:

1. `bodyAlias` (caller-supplied per-request override)
2. `SF_TARGET_ORG` / `SFDX_TARGET_ORG` env var
3. Project `target-org` (`<projectDir>/.sf/config.json`)
4. Global default org (`$HOME/.sf/config.json`)
5. `{ type: 'missing' }` — caller returns 400

Priority 2–4 is delegated to `ConfigAggregator`, which applies
`Environment > Local > Global` precedence natively. If `bodyAlias`
is supplied but doesn't resolve to a username, the function
short-circuits with `{ type: 'unresolved-alias', alias }` rather than
falling through — so the HTTP layer can name the offending alias in
the problem+json response.

`resolveDeployAuth` lives in its own module (not in `auth.ts`) so
tests can `vi.mock('./auth.js')` to stub `resolveAlias` while keeping
the real resolver wired up in `deploy.routes.ts`.

---

## domain/deploy.ts

Salesforce metadata deployment using
`@salesforce/source-deploy-retrieve` (SDR).

### Exports

```typescript
interface DeployStage {
  manifest: string;
  optional?: boolean;
}

async function buildConnectionFromAuth(
  auth: ResolvedAuth,
): Promise<Connection>;

async function buildComponentSet(projectDir: string): Promise<ComponentSet>;

async function readDeployStages(
  projectDir: string,
): Promise<DeployStage[] | undefined>;

async function deployMetadataAsync(
  deploymentId: string,
  projectDir: string,
  auth: ResolvedAuth,
): Promise<void>;

function mapStatusToProgressEvent(
  deploymentId: string,
  statusUpdate: Record<string, unknown>,
): ProgressEvent;
```

Behavior notes:
- `buildConnectionFromAuth` creates an `AuthInfo` + `Connection` and
  proactively calls `refreshAuth()`, turning stale-token failures
  into one clean synchronous error (502) rather than a mid-deploy
  401 that SDR's auto-retry might hide.
- `readDeployStages` parses `template.json` for a `deployStages`
  array. Returns `undefined` if the file is missing or empty; throws
  `BuildError` if the file is present but malformed or if any
  `stage.manifest` path traverses outside `projectDir`.
- `deployMetadataAsync` is never awaited by the POST handler — it
  runs in the background:
  1. Runs Vite build if the project has React sources.
  2. If `deployStages` is declared, runs each manifest-based
     deploy in order via `ComponentSet.fromManifest`. Required-stage
     failures abort remaining stages; optional-stage failures emit a
     `warning` SSE event and continue.
  3. Otherwise, runs a single-pass `ComponentSet.fromSource()`
     deploy over the project's `packageDirectories`.
  4. Writes the final `DeploymentResult` into the deployments store.
- `DeploymentResult.status` is one of `Succeeded`,
  `SucceededWithWarnings`, or `Failed`.
- `appUrl` is set on success when a `UIBundle` component was
  deployed. For staged deploys, it comes from the last stage that
  surfaced a `UIBundle`.

### Errors
`BuildError`, `DeploymentError` (502).

---

## domain/auth.ts

Thin wrapper around `@salesforce/core` authentication helpers.

```typescript
async function resolveAlias(alias: string): Promise<string | undefined>;
```

Returns the username for a given SFDX alias, or `undefined` if the
alias is unknown. Used by [`deploy-auth.ts`](#domaindeploy-authts).

---

## domain/build.ts

React/Vite build pipeline used by deployments.

```typescript
async function hasReactFiles(projectDir: string): Promise<boolean>;
async function runViteBuild(projectDir: string): Promise<void>;
```

`deployMetadataAsync` calls `hasReactFiles` before deploying; if
true, it runs `runViteBuild` so UIBundle-bearing stages ship the
latest built assets. Both functions are no-ops when the template
doesn't ship React sources.

---

## domain/files.ts

File tree traversal and guarded reads.

### Exports

```typescript
interface TreeNode {
  name: string;
  type: 'file' | 'directory';
  children?: TreeNode[]; // directory only
}

async function buildTree(
  name: string | undefined,
  dir: string,
): Promise<TreeNode>;

async function readFile(
  relPath: string,
  projectDir: string,
): Promise<string>;
```

Behavior notes:
- `buildTree` recursively walks `dir` and returns a `TreeNode`.
  Returns children sorted.
- `readFile` rejects:
  - Missing `path` query parameter (at the route layer)
  - Path traversal (`..`) attempts
  - Restricted paths: `.git/`, `.sf/`, `node_modules/`, dotfiles
  - Paths that resolve to a directory rather than a file

---

## domain/watcher.ts

Chokidar-backed filesystem watcher manager, used by
`fs-events.routes.ts` to stream per-project change events.

The module exports a singleton `watcherManager` with a
`closeAll()` method. `app.ts` registers an `onClose` hook that calls
`watcherManager.closeAll()` to avoid leaked watchers between test
runs and during SIGTERM.

---

## errors.ts

RFC 9457 Problem Details helpers and domain error classes.

### Exports

```typescript
const PROBLEM_JSON = 'application/problem+json';

interface ProblemDetail {
  status: number;
  title: string;
  detail: string;
  type?: string;
  instance?: string;
}

function problemDetail(
  status: number,
  title: string,
  detail: string,
): ProblemDetail;

function errorToProblem(err: unknown): ProblemDetail;

class TemplateNotFoundError extends Error   // → 400
class ProjectNotFoundError extends Error    // → 404
class OrgAliasEmptyError extends Error      // → 400
class DeploymentError extends Error         // → 502
class DeploymentNotFoundError extends Error // → 404
class BuildError extends Error              // → 502
```

`errorToProblem` is the single source of truth for mapping custom
errors to HTTP status codes. Unknown errors become `500 Internal
Server Error`. Stack traces are never returned to clients — the
`app.setErrorHandler` in [`app.ts`](#architecture) logs them via
Pino.

---

## deployments.ts

In-memory deployment store. Shared by `POST /deployments` (the
producer) and the SSE `GET /deployments/:deploymentId/events`
endpoint (the consumer).

### Exports (selected)

```typescript
interface DeploymentComponentResult {
  fullName: string;
  type: string;
  state: string;
}

interface ProgressEvent {
  deploymentId: string;
  timestamp: string;
  status: string;
  numberComponentsDeployed: number;
  numberComponentsTotal: number;
  components: DeploymentComponentResult[];
}

interface DeploymentStageSummary {
  name: string;
  status: string;
  numberComponentsDeployed: number;
  numberComponentsTotal: number;
  errorMessage?: string;
}

interface DeploymentWarning {
  stage: string;
  errorMessage: string;
}

interface DeploymentResult {
  deploymentId: string;
  status: string; // Succeeded | SucceededWithWarnings | Failed
  numberComponentsDeployed: number;
  numberComponentsTotal: number;
  components: DeploymentComponentResult[];
  stages?: DeploymentStageSummary[];
  warnings?: DeploymentWarning[];
  failedStage?: string;
  appUrl?: string;
  errorMessage?: string;
}

function createDeployment(projectId: string): string;
function deploymentExists(deploymentId: string): boolean;
function setDeploymentResult(id: string, r: DeploymentResult): void;
function setDeploymentError(id: string, message: string): void;
function getDeploymentResult(id: string): DeploymentResult | undefined;
function addProgressEvent(id: string, e: ProgressEvent): void;
function getProgressEvents(id: string): ProgressEvent[];
function addStageEvent(id: string, e: DeploymentStageSummary): void;
function getDeploymentStageEvents(id: string): DeploymentStageSummary[];
function addWarningEvent(id: string, e: DeploymentWarning): void;
function getDeploymentWarningEvents(id: string): DeploymentWarning[];
function setDeploymentPollPromise(id: string, p: Promise<void>): void;
```

All state is per-process. Running multiple instances behind a
reverse proxy requires pinning the SSE stream to the same instance
that created the deployment, or externalising this store.

---

## config.ts

Environment-backed configuration. All paths can be overridden via
environment variables (useful for EFS-mounted deployments).

```typescript
function getProjectsRoot(): string;    // PROJECTS_ROOT or ./projects
function getTemplatesDir(): string;    // TEMPLATES_DIR or package-local templates/dist/
function getRoutingPrefix(): string | undefined; // ROUTING_PREFIX
```

---

## logger.ts

```typescript
const logger: pino.Logger;
```

Singleton Pino logger, attached as Fastify's `loggerInstance` in
`app.ts`. Every request is logged in structured JSON. The
`setErrorHandler` also uses it to log unhandled `5xx` errors with
their stack traces.

---

## Routes

All routers are Fastify plugins registered in
`src/routes/index.ts` under the `/v1` prefix. They validate request
shape via `@sinclair/typebox` schemas with
`additionalProperties: false`, delegate to `domain/`, and translate
thrown errors through `errors.ts` into problem+json responses.

### templates.routes.ts

- `GET /templates` — `listTemplates()` → 200 JSON array

### projects.routes.ts

- `POST /projects` — body `{ template?, orgAlias? }`
  - `template` present → `createProject(template)` → 201
  - omitted → `createBlankProject(orgAlias?)` → 201
  - unknown property or empty `orgAlias` → 400
- `GET /projects` — `listProjects()` → 200
- `GET /projects/:id` — `getProject(id)` → 200 or 404
- `PATCH /projects/:id` — body `{ name }` → `renameProject` → 200 or 400/404
- `GET /projects/:id/file?path=...` — `readFile` → 200 `text/plain` or 400/404
- `GET /projects/:id/tree` — `buildTree` → 200 or 404

### deploy.routes.ts

- `POST /projects/:id/deployments` — body `{ orgAlias? }`
  (minLength: 1). Resolves auth via
  [`resolveDeployAuth`](#domaindeploy-authts), builds a connection
  eagerly to surface stale-token errors, creates a deployment
  record, starts `deployMetadataAsync` in the background, returns
  `202 { deploymentId, status: 'Queued' }`.
- `GET /projects/:id/deployments/:deploymentId/events` — SSE.
  `preHandler` runs resource-existence checks (project +
  deployment) so missing-deployment → `404` takes precedence over
  missing-`Accept` → `400`, even through `@fastify/sse`'s route
  wrapper. Replays all recorded `stage`, `progress`, and `warning`
  events on connect; emits `complete` immediately if the deploy
  already finished; otherwise polls every 100 ms until terminal
  state, then closes.

### fs-events.routes.ts

- `GET /projects/:id/fs/events` — SSE. Streams `file-added`,
  `file-changed`, and `file-removed` events from `watcherManager`.
  Rejects missing/wrong `Accept` with `400`. Restricted paths
  (`.git/`, `.sf/`, `node_modules/`, dotfiles, `.project-meta.json`)
  and binary files > 100 KiB are filtered out of events.

---

## Integration Points

### Adding a new route

1. Create a Fastify plugin in `src/routes/foo.routes.ts`:
   ```typescript
   import { FastifyInstance } from 'fastify';
   import { Type } from '@sinclair/typebox';

   export async function fooRoutes(app: FastifyInstance): Promise<void> {
     app.get('/foo', { schema: { querystring: Type.Object({ q: Type.String() }) } },
       async (request) => {
         const { q } = request.query as { q: string };
         return await doSomething(q);
       });
   }
   ```
2. Keep business logic in `src/domain/`. No Fastify imports there.
3. Register the plugin in `src/routes/index.ts`:
   ```typescript
   app.register(fooRoutes);
   ```
4. Let domain functions throw domain-specific errors;
   `errorToProblem` maps them to HTTP status codes automatically.
5. Add unit tests under `tests/unit/` and integration tests under
   `tests/integration/`.

### Error handling pattern

Throw semantic errors from `domain/`:

```typescript
if (!exists) throw new ProjectNotFoundError(id);
```

`app.setErrorHandler` catches the throw, runs it through
`errorToProblem`, and responds with `application/problem+json` at
the correct status. Routes don't need try/catch boilerplate for
expected error cases.
