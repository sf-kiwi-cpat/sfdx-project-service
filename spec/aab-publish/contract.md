<!-- Auto-generated from contract.spec.ts. Edit the spec, then regenerate. -->

# AiAuthoringBundle Publish + Activate Hook Contract

## Overview

When a deploy succeeds and its `componentSuccesses` include one or more `AiAuthoringBundle` components, the service publishes + activates each bundle against the org so the runtime `BotDefinition` / `BotVersion` materialize.

This contract layers on top of the deployment endpoint defined in [`spec/deploy/contract.md`](../deploy/contract.md). The hook is observable through the same Server-Sent Events stream that consumers already subscribe to for deploy progress.

### Why this contract exists

Deploying an `AiAuthoringBundle` ships only the authoring metadata — the `.agent` script and `bundle-meta.xml`. The runtime `BotDefinition` row that the agent invocable resolver looks up does **not** materialize until an explicit Connect API publish call runs. Until that call lands, the deployed agent is not invocable: chat panels return "agent not found" and `Invocable.Action.createCustomAction('generateAiAgentResponse', '<aabName>')` fails with `AgentIAType not found`.

The hook closes that gap automatically as part of every deploy — the user does not need to run `sf agent publish` / `sf agent activate` manually after each deploy.

---

## Scope

This contract pins the **observable** behavior of the hook, not the mechanics. It is intentionally agnostic about HOW the hook executes the publish + activate (subprocess, in-process library call, CLI shell-out). The only facts that bind:

- When the hook fires (and when it doesn't).
- What SSE events are emitted on success and on failure.
- What status the deploy reports when bundles fail to publish or activate.
- What context the hook hands the publish step (auth, project location, bundle name).

---

## Endpoint surface

The hook is invoked as part of the existing deploy lifecycle defined in [`spec/deploy/contract.md`](../deploy/contract.md):

```
POST /v1/projects/:id/deployments
GET  /v1/projects/:id/deployments/:deploymentId/events  (SSE)
```

It does not introduce a new endpoint. It surfaces:
- New `warning` SSE events with stage `agent-publish` or `agent-activate`.
- A potential downgrade of the `complete` event's `status` from `Succeeded` to `SucceededWithWarnings`.

---

## When the hook fires

| Deploy status | `componentSuccesses` includes `AiAuthoringBundle`? | Hook fires? |
|---|---|---|
| `Succeeded` / `SucceededWithWarnings` | Yes (one or more) | Yes — once per unique bundle name |
| `Succeeded` / `SucceededWithWarnings` | No | No — hook is a no-op |
| `Failed` | Either | No — bundles are not in the org, nothing to publish |

### Deduplication

If `componentSuccesses` contains the same bundle name multiple times (which staged deploys produce when more than one stage touches the same bundle), the hook collapses duplicates and invokes the publish step **exactly once** per unique bundle name.

---

## What the hook hands the publish step

For each unique bundle, the hook supplies:

| Input | Source |
|---|---|
| `username` | The deploying user, resolved through the zero-auth chain (body alias → project target-org → `SF_TARGET_ORG` env → global default). Same identity the deploy ran against. |
| `projectDir` | The resolved project directory on disk for the deployment (under the project store). Always an absolute path of the form `<projectsRoot>/<projectId>` — not a substring or sibling. |
| `aabName` | The bundle's `fullName` from `componentSuccesses`. |

The publish step uses `username` to (re)derive an org `Connection` from the SFDX keychain and `projectDir` to locate the bundle's source on disk.

---

## What the publish step returns

The publish step returns a result envelope with one of two shapes. The shape is part of the contract because it determines what the hook can surface as warnings — but **success-path fields are not observable on the SSE stream**. They exist for parent-side logging (deployment record, structured logs) so an operator can correlate a successful publish with the org-side IDs.

### Success

```jsonc
{
  "ok": true,
  "botId": "0Xx...",            // BotDefinition row id created/found in the org
  "botVersionId": "0XV...",     // BotVersion row id created by publish
  "botVersionStatus": "Active"  // Status reported by activate (typically "Active")
}
```

When `ok: true`, the hook does **not** emit any SSE event. The IDs and status are logged but not surfaced — SSE consumers are expected to assume success in the absence of a warning.

### Failure

```jsonc
{
  "ok": false,
  "stage": "agent-publish" | "agent-activate",
  "errorMessage": "..."
}
```

When `ok: false`, the hook emits a `warning` event with the supplied `stage` and `errorMessage`. See [SSE event contract](#sse-event-contract) below for the wire shape.

The `stage` value the publish step returns is preserved on the wire when it equals `agent-activate`; every other failure mode (including transport-level errors and unexpected stage values) is collapsed to `agent-publish`. This keeps the SSE warning surface tight — consumers handle exactly two stage values.

---

## SSE event contract

### Success path

When the publish step succeeds, **no warning event is emitted**. The `complete` event reports the deploy's underlying status (`Succeeded` or `SucceededWithWarnings`, unchanged by the hook).

### Failure path

When the publish step reports a failure, the hook emits one `warning` SSE event per failed bundle:

```
event: warning
data: { "stage": "agent-publish" | "agent-activate", "errorMessage": "..." }
```

| `stage` | Meaning |
|---|---|
| `agent-publish` | The publish call (or any pre-publish step: child spawn, connection setup, project resolution) failed. The bundle's runtime `BotDefinition` may not exist on the org. |
| `agent-activate` | Publish succeeded but the subsequent activate call failed. The `BotDefinition` exists; the `BotVersion` may be in a non-Active state. |

Lower-level transport failures (e.g. the hook cannot spawn its publish step at all) are surfaced as `agent-publish` warnings — SSE consumers only ever see those two `stage` values.

### `errorMessage` shape

Always references the affected `aabName` so consumers don't have to correlate by event order.

---

## Deploy outcome interaction

The hook is **best-effort**. The metadata-API deploy itself has already succeeded by the time the hook runs — the bundle source is on the org. A publish/activate failure means the runtime entities are missing or inactive, but the user can recover via `sf agent publish` / `sf agent activate` manually.

| Deploy SDR result | Any AAB warnings emitted? | Final `complete.status` |
|---|---|---|
| `Succeeded` | No | `Succeeded` |
| `Succeeded` | Yes (one or more) | `SucceededWithWarnings` |
| `Succeeded` (with optional-stage warnings already) | Yes | `SucceededWithWarnings` (combined) |
| `Failed` | N/A — hook does not fire | `Failed` |

---

## Independence within the hook

When multiple bundles are present, an early failure on one bundle does **not** strand the others. Each bundle is processed independently:

- AgentA failure → `agent-publish` warning + AgentB still attempted.
- AgentB success → no warning; `BotDefinition` materialized.
- The `complete` event aggregates: `SucceededWithWarnings` with the AgentA warning.

---

## Design principles

### Best-effort, not blocking

The deploy is the durable contract — the metadata is in place. Publish + activate is a recovery convenience. Failing the deploy on a publish error would regress every deploy that doesn't ship an AAB and add a spurious failure mode to the success path.

### Two stage names, no leakage

SSE consumers see only `agent-publish` and `agent-activate` for this hook. Every internal failure mode (child spawn, project resolve, connection build) maps to one of those two — keeping the surface tight prevents the warning enum from drifting as the implementation evolves.

### Independent of execution mechanism

The contract pins inputs (username + projectDir + aabName) and outputs (warning SSE events + complete-event status). Implementations are free to evolve — in-process library call, child process, CLI shell-out, vendored fork — without breaking this contract.

---

## Cross-references

- Deploy lifecycle and `complete` event shape: [`spec/deploy/contract.md`](../deploy/contract.md).
- React/Vite build step (also layers on top of the same deploy endpoint): [`spec/react-deploy/contract.md`](../react-deploy/contract.md).
