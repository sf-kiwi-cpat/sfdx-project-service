# API Reference

SF Project Service provides a REST API over `/v1` for templates, projects,
file reads, and metadata deployments, plus SSE streams for deployment
progress and filesystem change events. Unversioned operational endpoints
(`/health`, `/openapi.json`, `/docs`) live outside the `/v1` prefix.

The endpoint subsections below describe the observable contract of the
service — the authoritative source is the `spec/<feature>/contract.md`
files, which are generated from the executable contract tests.

## Base URL

```
http://localhost:3000
```

## Content Negotiation

- JSON endpoints return `application/json`.
- File reads return `text/plain`.
- SSE endpoints return `text/event-stream` and **require** the request
  to send `Accept: text/event-stream`. Requests without this header are
  rejected with `400 Bad Request` before any stream is opened.
- All error responses use `application/problem+json`.

## Error Handling

All error responses follow [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457.html):

```json
{
  "type": "string (optional)",
  "status": 400,
  "title": "Bad Request",
  "detail": "template is required in request body",
  "instance": "string (optional)"
}
```

Content-Type: `application/problem+json`

## Endpoints

### Templates

#### `GET /v1/templates`

List all available project templates.

**Response: 200 OK**

```json
[
  {
    "id": "data-curator",
    "name": "Data Curator",
    "description": "Agent-driven metadata governance with custom objects, Flows, and Agentforce actions",
    "categories": ["Governance", "Administration"]
  },
  {
    "id": "metadata-ownership-tracking",
    "name": "Metadata Ownership Tracking",
    "description": "Custom object for tracking metadata ownership",
    "categories": ["metadata", "governance"]
  }
]
```

Each template has `id`, `name`, `description` (non-empty), and
`categories` (string array). Templates declared `visible: false` in their
`template.json` (e.g., test fixtures) are excluded. The authoritative
list is whatever is present in `templates/dist/` at runtime; built-in
templates currently include `data-curator`, `local-react-test`,
`metadata-ownership-tracking`, and `work-tracking`.

---

#### Template Authoring — Seed Messages

A template's `template.json` may declare two independent message arrays.
Both use the identical element shape `{ "role": string, "content": string }`
and both are **captured into a project at create time** (copied into
`.project-meta.json`) — later edits to the template do not retroactively
change existing projects.

| Field             | Visibility  | Purpose                                                                                  |
| ----------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `initialMessages` | **Visible** | Pre-written opening turns the chat panel renders into the transcript.                    |
| `seedMessages`    | **Hidden**  | Persona-anchoring few-shot turns injected as hidden context (`transcriptVisible: false`). |

`seedMessages` exists so a template author can anchor the agent's persona
and voice with an example exchange the model sees every turn but that
never appears in the user-visible transcript. The consuming mechanism
(App Studio core → agent service) injects them once at chat-session
creation via `POST /v1/agents/:a/chats/:c/messages` with
`{ noReply: true, transcriptVisible: false }` — the array passes through
unchanged. (That hidden-few-shot channel was built under W-22370020; this
field supplies the data for it.)

**Authoring guidance:**

- Use **alternating** `user` / `assistant` turns — that is what makes a
  few-shot example anchor persona well downstream.
- Keep it short and exemplary: a 2–4 turn exchange that demonstrates the
  voice, boundaries, and decision-making you want the agent to mirror.
- Roles are free strings as far as this service is concerned; the agent
  service decides what it accepts.

**Limits (enforced at project-create time):**

- At most **50** messages — surplus entries beyond the 50th are dropped.
- At most **10,000** characters per `content` — an oversized element is
  dropped (the rest are kept).
- Malformed elements (missing/`non-string` `role` or `content`) are
  dropped. If nothing valid remains, the field is omitted entirely (never
  returned as `[]`). A malformed `seedMessages` block never fails project
  creation — it degrades to "no seeds".

Example `template.json` fragment:

```json
{
  "id": "data-curator",
  "name": "Data Curator",
  "description": "...",
  "categories": ["Governance"],
  "initialMessages": [
    { "role": "user", "content": "Help me build a governance app." },
    { "role": "assistant", "content": "Done — here's your workspace." }
  ],
  "seedMessages": [
    { "role": "user", "content": "We have 312 custom objects and nobody knows which are used. Where do I start?" },
    { "role": "assistant", "content": "Start with risk, not volume — triage stale + unowned first…" }
  ]
}
```

---

### Projects

#### `POST /v1/projects`

Create a new project.

**Request Body**

| Field      | Type   | Required | Description                                                                                                          |
| ---------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `template` | string | No       | Template identifier. When omitted, a minimal blank SFDX project is scaffolded.                                       |
| `orgAlias` | string | No       | Salesforce org alias to pin as the project's `target-org`. Must be non-empty when supplied — explicit `""` → `400`. |

Any other properties are rejected with `400 Bad Request` citing the
offending key.

**Response: 201 Created**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "brave-falcon",
  "lastAccessedAt": "2026-04-27T12:00:00.000Z",
  "initialMessages": [
    { "role": "user", "content": "Build me something" },
    { "role": "assistant", "content": "On it!" }
  ],
  "seedMessages": [
    { "role": "user", "content": "How should I phrase a failure?" },
    { "role": "assistant", "content": "Lead with the cause and the next action." }
  ]
}
```

- `id` — project UUID, used in all subsequent `/v1/projects/:id/*` calls.
- `name` — auto-generated human-readable name. Change via `PATCH /v1/projects/:id`.
- `lastAccessedAt` — ISO 8601 timestamp. Equals the creation time on create.
- `initialMessages` — present only when the template's `template.json`
  declares a non-empty `initialMessages` array. Omitted entirely (not
  returned as `[]`) for blank projects or templates without
  `initialMessages`. **Visible** starter turns meant to be rendered into
  the chat transcript.
- `seedMessages` — present only when the template's `template.json`
  declares a non-empty `seedMessages` array. Omitted entirely (not
  returned as `[]`) for blank projects or templates without
  `seedMessages`. **Hidden** persona-anchoring few-shot turns — distinct
  from `initialMessages`; meant to be injected into a chat session as
  hidden context (`transcriptVisible: false`), not displayed. See
  [Template Authoring](#template-authoring--seed-messages) below.

**Response: 400 Bad Request** — unknown template identifier. Problem-detail body.

---

#### `GET /v1/projects`

List all projects.

**Response: 200 OK**

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "brave-falcon",
    "lastAccessedAt": "2026-04-27T12:00:00.000Z"
  }
]
```

- Returns `[]` when no projects exist.
- No pagination — all projects are returned; the client decides sort order.
- `initialMessages` and `seedMessages` are intentionally not included in
  the list response (detail-only; fetch per-project via
  `GET /v1/projects/:id`).

---

#### `GET /v1/projects/:id`

Retrieve a single project.

**Path Parameters**

- `id` (string, UUID) — values that do not match the UUID shape are
  treated as "not found".

**Response: 200 OK**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "brave-falcon",
  "lastAccessedAt": "2026-04-27T12:00:00.000Z",
  "initialMessages": [
    { "role": "user", "content": "Build me something" },
    { "role": "assistant", "content": "On it!" }
  ],
  "seedMessages": [
    { "role": "user", "content": "How should I phrase a failure?" },
    { "role": "assistant", "content": "Lead with the cause and the next action." }
  ]
}
```

- Every retrieval bumps `lastAccessedAt` to the current time. The
  returned value is the post-bump value and is strictly greater than the
  creation time (and any prior PATCH rename time).
- `initialMessages` is present only when seeded from a template that
  declared it, and is preserved across PATCH rename.
- `seedMessages` is present only when the source template declared it,
  and is likewise preserved across PATCH rename.

**Response: 404 Not Found** — project does not exist, or `id` is not a
well-formed UUID. Problem-detail body.

---

#### `PATCH /v1/projects/:id`

Rename a project.

**Request Body**

| Field  | Type   | Required | Description                   |
| ------ | ------ | -------- | ----------------------------- |
| `name` | string | Yes      | New name. Must be non-empty. |

**Response: 200 OK**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "my-custom-name",
  "lastAccessedAt": "2026-04-27T12:05:00.000Z"
}
```

- `lastAccessedAt` is bumped to the rename time.
- `initialMessages` and `seedMessages`, when set at creation, are preserved.

**Response: 400 Bad Request** — `name` missing or empty. Problem-detail body.

**Response: 404 Not Found** — project does not exist. Problem-detail body.

---

#### `GET /v1/projects/:id/file?path=...`

Read a file's contents from a project. Returns raw bytes as `text/plain`.

**Query Parameters**

- `path` (string, required) — file path relative to the project root.

**Response: 200 OK** — `Content-Type: text/plain` with the raw file contents.

**Response: 400 Bad Request**

- `path` query parameter missing.
- Path traversal attempt (e.g., `../../etc/passwd`).
- Restricted path (`.git/`, `.sf/`, `node_modules/`, dotfiles).
- Path resolves to a directory rather than a file.

**Response: 404 Not Found**

- Project does not exist.
- File does not exist.

---

#### `GET /v1/projects/:id/tree`

Return the file tree for a project.

**Response: 200 OK**

```json
{
  "name": "550e8400-e29b-41d4-a716-446655440000",
  "type": "directory",
  "children": [
    { "name": "sfdx-project.json", "type": "file" },
    {
      "name": "force-app",
      "type": "directory",
      "children": []
    }
  ]
}
```

Accessing the tree updates the project's `lastAccessedAt`. Works
identically for template-based and blank projects.

**Response: 404 Not Found** — project does not exist. Problem-detail body.

---

### Deployments

Deployments are **asynchronous**: `POST /v1/projects/:id/deployments`
returns immediately with a `deploymentId`, and the client connects to
the SSE events endpoint for progress. There is no polling endpoint.

#### Org preconditions for React-based templates

Templates that ship a `UIBundle` component (React apps hosted inside
Salesforce) require the target org to have **Agentforce Vibe for
Multi-Framework (Beta)** enabled. Deployments will fail with
`UIBundle Metadata API is not enabled …` otherwise.

To enable it: **Setup → Apps → React Development with Agentforce Vibes
and Salesforce Multi-Framework (Beta)**, and toggle the preference on.

This is an org-level configuration managed in Setup, not something the
service can toggle. All built-in templates (`data-curator`,
`local-react-test`, `metadata-ownership-tracking`, `work-tracking`)
currently ship a UIBundle, so every one of them depends on this
preference.

#### `POST /v1/projects/:id/deployments`

Start a metadata deployment to a Salesforce org.

**Request Body**

| Field      | Type   | Required | Description                                                                                             |
| ---------- | ------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `orgAlias` | string | No       | Salesforce org alias. Must be non-empty when present — explicit empty strings are rejected with `400`. |

**Zero-auth resolution** (first match wins — caller-supplied tokens
are not part of the contract):

1. Request body `orgAlias`.
2. `SF_TARGET_ORG` / `SFDX_TARGET_ORG` environment variables.
3. Project `target-org` (pinned at creation via `orgAlias`).
4. Global SF CLI default org.

If none of the above resolve to a locally-authed username, the
request is rejected with `400`. `Authorization` and
`X-Salesforce-Instance-Url` request headers are silently ignored.

**Response: 202 Accepted**

```json
{
  "deploymentId": "deploy_1711353600000_a1b2c3d",
  "status": "Queued"
}
```

The deployment continues in the background. Subscribe to
`GET /v1/projects/:id/deployments/:deploymentId/events` for progress.

**Response: 400 Bad Request**

- No authentication source resolved.
- `orgAlias` was supplied but does not resolve to a locally-authed
  username. Problem-detail mentions the offending alias.
- `orgAlias` was an explicit empty string. Problem-detail body.

**Response: 404 Not Found** — project does not exist. Problem-detail body.

**Response: 502 Bad Gateway** — connection to Salesforce failed (e.g.,
expired access token that cannot be refreshed). Problem-detail body.

---

#### `GET /v1/projects/:id/deployments/:deploymentId/events`

SSE stream of deployment progress.

**Required header:** `Accept: text/event-stream`.

**Response: 200 OK** — `Content-Type: text/event-stream`, `Cache-Control: no-cache`.

**Event types:**

| Event      | Payload                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| `start`    | `{ "deploymentId": "..." }` — emitted immediately on connection.                        |
| `stage`    | `{ deploymentId, name, index, total }` — emitted before each stage of a multi-stage deploy. Not emitted for single-pass (non-staged) deploys. |
| `progress` | Deployment tick: `{ deploymentId, timestamp, status, numberComponentsDeployed, numberComponentsTotal, components[] }`. |
| `warning`  | `{ stage, errorMessage }` — emitted when an **optional** stage in a staged deploy fails. The deployment continues; the `complete` event's status will be `SucceededWithWarnings` if no required stage fails. |
| `complete` | Terminal: `{ deploymentId, status, numberComponentsDeployed, numberComponentsTotal, components[], stages?, warnings?, failedStage?, appUrl? }`. The stream closes after this event. |

**`complete.status`** is one of `Succeeded`, `SucceededWithWarnings`
(a required stage succeeded but an optional stage failed), or
`Failed` (a required stage failed). `failedStage` names the required
stage that aborted the deploy. `stages` is included for staged
deploys and summarises per-stage status.

**`complete.appUrl`** is present only when the deployment succeeded
**and** included a `UIBundle` component. Format:
`{instanceUrl}/lwr/application/ai/c-{appName}`, where `appName` is the
`UIBundle`'s `fullName`. For staged deploys, `appUrl` is taken from
the last stage that surfaced a `UIBundle`.

The stream is **reconnect-safe**: on reconnect the server replays all
previously recorded `stage`, `progress`, and `warning` events, and if
the deployment already finished it emits `complete` immediately and
closes.

**Example stream (single-pass deploy):**

```
event: start
data: {"deploymentId":"deploy_abc123"}

event: progress
data: {"deploymentId":"deploy_abc123","status":"InProgress","numberComponentsDeployed":1,"numberComponentsTotal":5,"components":[...]}

event: complete
data: {"deploymentId":"deploy_abc123","status":"Succeeded","components":[...],"appUrl":"https://test.salesforce.com/lwr/application/ai/c-MyApp"}
```

**Example stream (staged deploy with one optional-stage warning):**

```
event: start
data: {"deploymentId":"deploy_abc123"}

event: stage
data: {"deploymentId":"deploy_abc123","name":"manifest/package.xml","index":0,"total":3}

event: progress
data: {"deploymentId":"deploy_abc123","status":"Succeeded","numberComponentsDeployed":8,"numberComponentsTotal":8,"components":[...]}

event: stage
data: {"deploymentId":"deploy_abc123","name":"manifest/flows-package.xml","index":1,"total":3}

event: warning
data: {"stage":"manifest/flows-package.xml","errorMessage":"..."}

event: complete
data: {"deploymentId":"deploy_abc123","status":"SucceededWithWarnings","stages":[...],"warnings":[...]}
```

**Response: 400 Bad Request** — `Accept` header missing or not
`text/event-stream`. Problem-detail body (stream never opens).

**Response: 404 Not Found** — project or deployment does not exist.
Problem-detail body.

---

### Filesystem Events

#### `GET /v1/projects/:id/fs/events`

SSE stream of filesystem change events inside a project. Any write —
from agent tool calls, MCP tools, shell commands, or manual edits —
surfaces here, because the service watches the filesystem itself rather
than a specific tool taxonomy.

**Required header:** `Accept: text/event-stream`.

**Response: 200 OK** — `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.

**Event types:**

| Event          | Emitted when                          | Payload                                                   |
| -------------- | ------------------------------------- | --------------------------------------------------------- |
| `connected`    | Immediately on subscription.          | `{ "projectId": "<uuid>" }`                                |
| `file-added`   | A file is created.                    | `{ path, type: "add", content? }`                          |
| `file-changed` | A file's contents are modified.       | `{ path, type: "change", content? }`                       |
| `file-removed` | A file is deleted.                    | `{ path, type: "unlink" }` (no `content`)                  |

- `path` is relative to the project root, POSIX-style.
- `content` is included on `file-added` / `file-changed` when the file
  is (a) not a binary extension (deny list: `.png .jpg .gif .webp .pdf
  .zip .woff .woff2 .ttf`) **and** (b) smaller than 100 KiB. Decoded as
  UTF-8; non-UTF-8 bytes become `U+FFFD`.
- Renames emit **two** events: `file-removed` for the old path and
  `file-added` for the new. They are not coalesced into a synthetic
  `file-changed`.
- Writes to `node_modules/`, `.git/`, `.sf/`, `.project-meta.json`, and
  any dotfile are silently ignored.
- Rapid successive writes to the same path are debounced and flushed as
  a single event carrying the latest content (last-write-wins).
- Pre-existing files produce **no** `file-added` events for new
  subscribers — only writes made after subscription are surfaced.

**Example stream:**

```
event: connected
data: {"projectId":"550e8400-e29b-41d4-a716-446655440000"}

event: file-added
data: {"path":"src/App.js","type":"add","content":"export default ..."}

event: file-changed
data: {"path":"src/App.js","type":"change","content":"...new..."}

event: file-removed
data: {"path":"src/App.js","type":"unlink"}
```

**Response: 400 Bad Request** — `Accept` header missing or not
`text/event-stream`. Problem-detail body (stream never opens).

**Response: 404 Not Found** — project does not exist, or `id` is not a
well-formed UUID. Problem-detail body.

---

## Operational Endpoints

These live outside the `/v1` prefix. They describe or monitor the
service itself rather than the product API.

### `GET /health`

Liveness probe for the reverse proxy. No authentication, no side effects,
no deep dependency checks.

**Response: 200 OK**

```json
{ "status": "ok" }
```

Also supports `HEAD /health`. Other methods (`POST`, `PUT`, ...) return
`404`. The endpoint is **not** available at `/v1/health`.

### `GET /openapi.json`

Returns the OpenAPI 3.0 specification for the `/v1` API as JSON.

### `GET /docs`

Swagger UI — interactive API explorer. Available while the server is running.

---

## Example Workflow

### Create a project, stream filesystem events, deploy

```bash
# 1. List templates
curl http://localhost:3000/v1/templates

# 2. Create project from a template
RESPONSE=$(curl -X POST http://localhost:3000/v1/projects \
  -H "Content-Type: application/json" \
  -d '{"template":"metadata-ownership-tracking"}')
PROJECT_ID=$(echo "$RESPONSE" | jq -r '.id')

# 3. Subscribe to filesystem events (in a separate terminal)
curl -N -H "Accept: text/event-stream" \
  http://localhost:3000/v1/projects/$PROJECT_ID/fs/events

# 4. View the project tree
curl http://localhost:3000/v1/projects/$PROJECT_ID/tree

# 5. Start a deployment (project's target-org resolves auth)
DEPLOYMENT=$(curl -X POST http://localhost:3000/v1/projects/$PROJECT_ID/deployments)
DEPLOYMENT_ID=$(echo "$DEPLOYMENT" | jq -r '.deploymentId')

# 6. Stream deployment progress
curl -N -H "Accept: text/event-stream" \
  http://localhost:3000/v1/projects/$PROJECT_ID/deployments/$DEPLOYMENT_ID/events
```

### Error Handling

```bash
# POST with unknown template → 400
curl -X POST http://localhost:3000/v1/projects \
  -H "Content-Type: application/json" \
  -d '{"template":"does-not-exist"}'

# Access non-existent project → 404
curl http://localhost:3000/v1/projects/invalid-id/tree

# SSE without Accept header → 400 (stream never opens)
curl http://localhost:3000/v1/projects/$PROJECT_ID/fs/events
```
