<!-- Auto-generated from contract.spec.ts — do not edit manually -->

# Deployment Contract Specification

## Overview

The deployment system implements an **asynchronous deployment workflow** over
Server-Sent Events (SSE). Deployments are non-blocking: clients initiate a
deployment and receive a unique `deploymentId`, then connect to the SSE
stream for real-time progress. There is no polling endpoint — SSE is the
single channel for deployment status.

The HTTP surface is **zero-auth**: `POST /v1/projects/:id/deployments`
does NOT accept caller-supplied credentials. The service resolves
Salesforce auth server-side from the CLI environment. This mirrors
`sfdx-agent-service` in the `agentic-dx` monorepo.

Templates MAY declare an ordered list of `deployStages` in their
`template.json` to run multiple manifest-based deploys back-to-back.
Templates without `deployStages` use single-pass source deploys
(`ComponentSet.fromSource(force-app)`).

---

## Endpoints

### POST `/v1/projects/:id/deployments` — Initiate a deployment

**Request body** (all fields optional):

```jsonc
{
  "orgAlias": "my-scratch"   // optional: per-request alias override
}
```

Callers do NOT send `Authorization` or `X-Salesforce-Instance-Url` headers.
If present, they are ignored — the contract is zero-auth. Auth is resolved
server-side using this priority chain:

1. **Request body `orgAlias`** — resolved via `StateAggregator` alias map.
2. **Project target-org** — read from `<projectDir>/.sf/config.json`.
3. **Global default org** — read via `ConfigAggregator` property `target-org`.
4. **400 Bad Request** — if none of the above yield a username.

**Responses**

| Status | Condition | Body |
|--------|-----------|------|
| 202 Accepted | Deployment started | `{ deploymentId: "deploy_<unique>", status: "Queued" }` |
| 400 Bad Request | No auth source could be resolved | RFC 9457 Problem Detail — `detail` mentions how to fix it (pass `orgAlias`, set a project target-org, or configure a global default) |
| 400 Bad Request | Provided `orgAlias` does not resolve to a known username | RFC 9457 Problem Detail — `detail` mentions the offending alias |
| 404 Not Found | Project does not exist | RFC 9457 Problem Detail |
| 502 Bad Gateway | Connection to Salesforce failed (invalid/expired token) | RFC 9457 Problem Detail — title `Deployment Failed` |

### GET `/v1/projects/:id/deployments/:deploymentId/events` — Stream events (SSE)

**Response**
- `200 OK`, `Content-Type: text/event-stream`, `Cache-Control: no-cache`
- Streams Server-Sent Events as the deployment progresses
- Each event is a JSON object

**Event types**

- `start` — Deployment started.
  ```json
  { "deploymentId": "deploy_<unique>" }
  ```

- `stage` — Emitted only for staged deploys (when `deployStages` is declared),
  once per stage, as the stage begins.
  ```json
  {
    "deploymentId": "deploy_<unique>",
    "name": "manifest/package.xml",
    "index": 0,
    "total": 3
  }
  ```

- `progress` — Component deployed (delivered by SDR `onUpdate` callback).
  ```json
  {
    "deploymentId": "deploy_<unique>",
    "timestamp": "2026-04-29T10:00:00.000Z",
    "status": "InProgress",
    "numberComponentsDeployed": 2,
    "numberComponentsTotal": 5,
    "components": [{ "fullName": "Hello_World__c", "type": "CustomObject", "state": "Created" }]
  }
  ```

- `warning` — An optional stage failed; deployment continues. Emitted only
  for staged deploys.
  ```json
  {
    "deploymentId": "deploy_<unique>",
    "stage": "manifest/bundle-package.xml",
    "index": 2,
    "total": 3,
    "message": "Stage failed but was optional; continuing",
    "errorMessage": "<error from SDR>"
  }
  ```

- `complete` — Deployment finished (see shape below).

**Error responses**

| Status | Condition |
|--------|-----------|
| 404 Not Found | Project or deployment does not exist |

---

## `complete` event shape

Fields common to all deployments:

| Field | Type | Notes |
|-------|------|-------|
| `deploymentId` | string | The deployment ID. |
| `status` | `"Succeeded"` \| `"SucceededWithWarnings"` \| `"Failed"` | See status rules below. |
| `numberComponentsDeployed` | number | Summed across all stages for staged deploys. |
| `numberComponentsTotal` | number | Summed across all stages for staged deploys. |
| `components` | `ComponentResult[]` | Summed across all stages for staged deploys. |
| `appUrl` | string \| undefined | Present **only** when status ∈ `{Succeeded, SucceededWithWarnings}` AND a `WebApplication` component was deployed. Format: `{instanceUrl}/lwr/application/ai/c-{appFullName}`. |
| `errorMessage` | string \| undefined | Present when status = `Failed`. |
| `failedStage` | string \| undefined | Present when a required stage failed. Value is the failing stage's `manifest` path. |

Fields present only for staged deploys:

| Field | Type | Notes |
|-------|------|-------|
| `stages` | `StageResult[]` | Per-stage breakdown (name, status, component counts). |
| `warnings` | `WarningEvent[]` | Aggregated list of optional-stage failures (same shape as the `warning` events emitted on the stream). |

**Status rules:**
- `Succeeded` — all stages succeeded (or, for a single-pass deploy, SDR returned `Succeeded`).
- `SucceededWithWarnings` — all required stages succeeded, and at least one optional stage failed.
- `Failed` — a required stage failed, or a single-pass deploy returned `Failed`.

---

## `template.json` `deployStages` schema

Templates MAY declare an ordered list of deploy stages:

```jsonc
{
  "id": "data-curator",
  "name": "Data Curator",
  "description": "...",
  "categories": ["Governance", "Administration"],
  "deployStages": [
    { "manifest": "manifest/package.xml" },
    { "manifest": "manifest/flows-package.xml" },
    { "manifest": "manifest/authoring-bundle-package.xml", "optional": true },
    { "manifest": "manifest/prompts-package.xml", "optional": true }
  ]
}
```

Each stage:
- `manifest` (required) — path (relative to the project root) to a `package.xml`
  that enumerates the metadata for that stage. Loaded with
  `ComponentSet.fromManifest()`.
- `optional` (default: `false`) — if `true`, a failed deploy for this stage
  emits a `warning` event and the deployment continues. Otherwise a failed
  deploy for this stage aborts remaining stages and the complete event
  reports `Failed`.

**Build-time validation:** `scripts/zip-templates.js` (`npm run build:templates`)
MUST fail with a non-zero exit code if any referenced `manifest` path does
not exist inside the template's `content/`. Invalid templates never ship to
`templates/dist/`.

**Backwards compatibility:** templates without `deployStages` (including
`metadata-ownership-tracking`, `work-tracking`, `local-react-test`) use the
single-pass `ComponentSet.fromSource(force-app)` behavior. Nothing about
those templates changes.

---

## Deploy lifecycle (staged)

```
Request → resolve auth (body → project → global → 400)
  ↓
POST 202 Accepted (deploymentId issued)
  ↓
[async] Build step (if React project)
  ↓
For each stage in deployStages:
  emit stage event
  ComponentSet.fromManifest(stage.manifest)
  deploy → pollStatus
  if stage failed:
    if optional: emit warning, continue
    else: abort remaining stages, status = Failed
  else:
    record stage result
  ↓
emit complete event (stages[], warnings[], appUrl if WebApp present)
```

## Deploy lifecycle (single-pass, legacy)

```
Request → resolve auth
  ↓
POST 202 Accepted
  ↓
[async] Build step (React)
  ↓
ComponentSet.fromSource(force-app)
deploy → pollStatus
  ↓
emit complete event (appUrl if WebApp present)
```

---

## Design Principles

### Zero-auth at the edge
No caller-supplied tokens. The service is trusted to resolve auth from its
local CLI environment — consistent with `sfdx-agent-service`. This removes
an entire class of "stale token" and "wrong instance URL" bugs at the HTTP
boundary, and lets tooling that wraps the service (CLIs, IDE extensions)
avoid passing credentials through.

### Staged deploys are declarative
The template author declares ordering once in `template.json`. The service
reads it at deploy time. No code changes needed to support a new template
with deployment ordering constraints.

### Optional stages fail soft
Agentforce and other feature-gated metadata require the target org to have
the feature enabled. Marking those stages `optional` lets the governance
metadata deploy succeed on orgs without Agentforce, while emitting clear
warnings (both per-stage and aggregated) so callers can surface them.

### Required stages fail fast
A failed required stage aborts remaining stages — no partial-mutation
surprises. The `failedStage` field tells the caller which stage failed.

### No caller-supplied auth, period
The `Authorization` and `X-Salesforce-Instance-Url` headers that this
endpoint previously accepted are removed from the contract. The endpoint
does not check for them, does not validate them, does not use them if
sent.

---

## Error Cases

| Error | HTTP | Title | Detail |
|-------|------|-------|--------|
| No auth source configured | 400 | Bad Request | Pass `orgAlias`, set a project target-org, or configure a global default |
| `orgAlias` does not resolve | 400 | Bad Request | Mentions the offending alias |
| Project does not exist | 404 | Not Found | Project not found |
| Connection fails | 502 | Deployment Failed | Error from Salesforce |
| Build fails | — | — | Surfaces in SSE complete event as deployment error |
| Required stage fails | — | — | `complete` event with `status: Failed`, `failedStage`, `errorMessage` |
| Optional stage fails | — | — | `warning` event + `complete` event with `status: SucceededWithWarnings`, `warnings[]` |

---

## Summary

- `POST /v1/projects/:id/deployments` — 1 describe block, 10 tests covering
  auth resolution (7) and basic flow (2) plus an "ignore headers" test (1).
- `GET /v1/projects/:id/deployments/:deploymentId/events (SSE)`:
  - Single-pass: 1 describe block, 6 tests.
  - Staged: 1 describe block, 5 tests.
- `Template deployStages schema` — 1 describe block, 2 sentinel tests; the
  build-time validation is enforced in `scripts/zip-templates.js`.
