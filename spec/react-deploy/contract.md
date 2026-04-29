<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->

# Vite Build Integration Contract

## Purpose

Defines the contract for the Vite programmatic build step layered on top of the metadata deployment pipeline. When a project contains `.tsx` or `.jsx` source files, the service runs `vite.build()` before proceeding with deployment to Salesforce. The service owns the build configuration — the user's project has no build tooling (no `vite.config.ts`).

**Scope of this spec:** build-step behavior only (when Vite runs, how its outcomes surface, what happens on timeout). **Out of scope:** auth, SSE streaming, staged deploys. Those are defined in [`spec/deploy/contract.md`](../deploy/contract.md) and apply in parallel to this spec.

## Endpoint

### POST `/v1/projects/:id/deployments`

Initiates a deployment. Always returns 202 immediately — the build and deployment run asynchronously.

**Request body** (same shape as the deploy endpoint):

```jsonc
{
  "orgAlias": "my-scratch"   // optional: per-request alias override
}
```

Callers do NOT send `Authorization` or `X-Salesforce-Instance-Url` headers. Auth resolves server-side per the zero-auth contract defined in `spec/deploy/contract.md`.

**Build behavior matrix:**

| Scenario | HTTP | Build step | Deployment result |
|----------|------|------------|-------------------|
| Project has `.tsx`/`.jsx`, build succeeds | 202 Accepted | runs asynchronously | proceeds to metadata deploy |
| Project has `.tsx`/`.jsx`, build fails | 202 Accepted | runs, throws | deployment result stores the build error |
| Project has `.tsx`/`.jsx`, build times out | 202 Accepted | runs, hits 5 min timeout | deployment result stores a timeout error |
| Project has no `.tsx`/`.jsx` | 202 Accepted | **skipped** — `vite.build()` never called | proceeds to metadata deploy |

## Responses

- **202 Accepted** — deployment queued. Body: `{ deploymentId, status: "Queued" }`. Client monitors progress via the SSE stream.
- **404 Not Found** — project ID does not exist. RFC 9457 Problem Detail.
- **502 Bad Gateway** — Salesforce connection failed. RFC 9457 Problem Detail, title `Deployment Failed`.

Error cases for auth (e.g. 400 when no auth source is resolvable) are covered by `spec/deploy/contract.md` and not duplicated here.

## Build Step Logic

### Detection
The service scans the project directory for `.tsx` or `.jsx` files. If any are found, the Vite build step runs. Detection uses real filesystem checks — no `package.json` inspection.

### Execution
Build uses the Vite programmatic API (`vite.build()`). The service provides the build configuration:
- **Entry:** `index.html` at project root
- **Output:** `force-app/main/default/webapplications/App/dist/`
- **Timeout:** 5 minutes (300,000 ms)
- **Concurrency:** per-project lock prevents duplicate builds; concurrent requests coalesce

### When Build is Skipped
Build is skipped (deployment proceeds directly) when no `.tsx` or `.jsx` files exist. This covers metadata-only SFDX projects.

### Build Output
Vite outputs compiled assets to `force-app/main/default/webapplications/App/dist/`. The `webapplication.json` declares `outputDir: "dist"`. SDR picks up the `WebApplication` metadata for deployment to Salesforce.

### Timeout Cleanup
If the build exceeds 5 minutes, the output directory is cleaned up to prevent stale artifacts from being deployed by a subsequent attempt.

## Request Processing Order

```
1. Resolve auth (body orgAlias → project target-org → global default)  → 400 if none resolve
2. Resolve project directory                                           → 404 if not found
3. Validate Salesforce connection eagerly                              → 502 "Deployment Failed" on error
4. Create deployment record
5. Return 202 Accepted immediately
6. [async] Detect .tsx/.jsx files in project
7. [async] If found: run vite.build()                                  → error stored in deployment result
8. [async] Deploy metadata via SDR                                     → result stored in deployment result
```

Build runs **asynchronously** inside the deployment pipeline. The POST returns 202 before the build starts. Build and deploy errors are captured in the deployment result, observable via the SSE events stream.

## Design Principles

1. **Non-blocking** — POST returns immediately; build + deploy run in background.
2. **Service owns the build** — user writes React; all deployment mechanics are hidden.
3. **Detection by content** — `.tsx`/`.jsx` presence, not config files.
4. **Programmatic API** — `vite.build()` not shell execution; safer, faster, more control.
5. **Coalesced builds** — concurrent deploys for the same project share a single build.
6. **Graceful degradation** — metadata-only projects deploy without any build step.

## Example Flows

### Flow 1: React Project — Build Success

```
POST /v1/projects/{id}/deployments  body: { "orgAlias": "my-scratch" }
  ├─ Auth resolves, connection verified
  ├─ Returns 202 Accepted + deploymentId
  │  [async pipeline]
  ├─ Project contains src/App.tsx
  ├─ vite.build() succeeds → assets in webapplications/App/dist/
  ├─ SDR deploys metadata
  └─ Deployment result: Succeeded
```

### Flow 2: React Project — Build Fails

```
POST /v1/projects/{id}/deployments  body: { "orgAlias": "my-scratch" }
  ├─ Auth resolves, connection verified
  ├─ Returns 202 Accepted + deploymentId
  │  [async pipeline]
  ├─ Project contains src/App.tsx
  ├─ vite.build() rejects with error
  └─ Deployment error: "Build failed: syntax error in App.tsx"
```

### Flow 3: Metadata-Only Project

```
POST /v1/projects/{id}/deployments  body: { "orgAlias": "my-scratch" }
  ├─ Auth resolves, connection verified
  ├─ Returns 202 Accepted + deploymentId
  │  [async pipeline]
  ├─ No .tsx/.jsx files → build skipped
  ├─ SDR deploys metadata
  └─ Deployment result: Succeeded
```

### Flow 4: Build Timeout

```
POST /v1/projects/{id}/deployments  body: { "orgAlias": "my-scratch" }
  ├─ Auth resolves, connection verified
  ├─ Returns 202 Accepted + deploymentId
  │  [async pipeline]
  ├─ Project contains src/App.tsx
  ├─ vite.build() exceeds 5 minutes
  ├─ Output directory cleaned up
  └─ Deployment error: "Build timeout after 5 minutes"
```

## Summary

- 1 describe block: `POST /v1/projects/:id/deployments with Vite build step`
- 3 nested describes: `project with .tsx source files` (3 tests), `metadata-only project` (1 test), `error cases` (2 tests)
- **6 tests total**
