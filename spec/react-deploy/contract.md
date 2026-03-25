# Vite Build Integration Contract

## Purpose

Defines the contract for integrating a Vite programmatic build step into the deployment pipeline. When a project contains `.tsx` or `.jsx` source files, the service runs `vite.build()` before proceeding with metadata deployment to Salesforce. The service owns the build configuration — the user's project has no build tooling (no `vite.config.ts`).

## Endpoints

### POST /v1/projects/:id/deployments

Initiates a deployment with optional Vite build step. The POST always returns 202 immediately — the build runs asynchronously as part of the deployment pipeline. Build errors surface in the deployment result.

1. **Project has .tsx/.jsx files, build succeeds** → 202 Accepted → deployment proceeds
2. **Project has .tsx/.jsx files, build fails** → 202 Accepted → deployment result contains build error
3. **Project has .tsx/.jsx files, build times out (5 min)** → 202 Accepted → deployment result contains timeout error
4. **No .tsx/.jsx files (metadata-only)** → 202 Accepted → build skipped, deployment proceeds

## Request

```http
POST /v1/projects/{projectId}/deployments HTTP/1.1
Authorization: Bearer {accessToken}
X-Salesforce-Instance-Url: {instanceUrl}
```

**Headers:**
- `Authorization` (required): OAuth 2.0 access token in Bearer scheme
- `X-Salesforce-Instance-Url` (required): Salesforce org instance URL (must be valid URI)

**Path Parameters:**
- `projectId` (required): UUID of the project to deploy

## Responses

### 202 Accepted — Deployment Queued

Always returned for valid requests. Build and deployment run asynchronously.

```json
{
  "deploymentId": "deploy_a1b2c3d4e5f6",
  "status": "Queued"
}
```

Client monitors progress via SSE (`/v1/projects/:id/deployments/:deploymentId/events`) or polling (`GET /v1/projects/:id/deployments/:deploymentId`).

### 400 Bad Request — Missing/Invalid Credentials

```json
{
  "status": 400,
  "title": "Bad Request",
  "detail": "Authorization header is missing"
}
```

### 404 Project Not Found

```json
{
  "status": 404,
  "title": "Project Not Found",
  "detail": "Project 00000000-0000-0000-0000-000000000000 does not exist"
}
```

### 502 Deployment Failed — Salesforce Connection Error

```json
{
  "status": 502,
  "title": "Deployment Failed",
  "detail": "Connection to Salesforce failed: Invalid access token"
}
```

## Build Step Logic

### Detection

The service scans the project directory for `.tsx` or `.jsx` files. If any are found, the Vite build step runs. Detection uses real filesystem checks — no `package.json` inspection.

### Execution

Build uses the Vite programmatic API (`vite.build()`). The service provides the build configuration:

- **Entry:** `index.html` at project root
- **Output:** `force-app/main/default/webapplications/App/dist/`
- **Timeout:** 5 minutes (300,000 ms)
- **Concurrency:** Per-project lock prevents duplicate builds; concurrent requests coalesce

### When Build is Skipped

Build is skipped (deployment proceeds directly) when no `.tsx` or `.jsx` files exist in the project directory. This covers metadata-only SFDX projects.

### Build Output

Vite outputs compiled assets to `force-app/main/default/webapplications/App/dist/`. The `webapplication.json` declares `outputDir: "dist"`. SDR picks up the WebApplication metadata for deployment to Salesforce.

### Timeout Cleanup

If the build exceeds 5 minutes, the output directory is cleaned up to prevent stale artifacts from being deployed by a subsequent attempt.

## Request Processing Order

```
1. Extract and validate credentials          → 400 if missing/invalid
2. Resolve project directory                 → 404 if not found
3. Validate Salesforce connection eagerly     → 502 "Deployment Failed" on error
4. Create deployment record
5. Return 202 Accepted immediately
6. [async] Detect .tsx/.jsx files in project
7. [async] If found: run vite.build()        → error stored in deployment result
8. [async] Deploy metadata via SDR           → result stored in deployment result
```

Build runs **asynchronously** inside the deployment pipeline. The POST returns 202 before the build starts. Build and deploy errors are captured in the deployment result, observable via SSE or polling.

## Design Principles

1. **Non-blocking** — POST returns immediately; build + deploy run in background
2. **Service owns the build** — User writes React; all deployment mechanics are hidden
3. **Detection by content** — `.tsx`/`.jsx` presence, not config files
4. **Programmatic API** — `vite.build()` not shell execution; safer, faster, more control
5. **Coalesced builds** — Concurrent deploys for the same project share a single build
6. **Graceful degradation** — Metadata-only projects deploy without any build step

## Example Flows

### Flow 1: React Project — Build Success

```
POST /v1/projects/{id}/deployments
  ├─ Credentials valid, connection verified
  ├─ Returns 202 Accepted + deploymentId
  │  [async pipeline]
  ├─ Project contains src/App.tsx
  ├─ vite.build() succeeds → assets in webapplications/App/dist/
  ├─ SDR deploys metadata
  └─ Deployment result: Succeeded
```

### Flow 2: React Project — Build Fails

```
POST /v1/projects/{id}/deployments
  ├─ Credentials valid, connection verified
  ├─ Returns 202 Accepted + deploymentId
  │  [async pipeline]
  ├─ Project contains src/App.tsx
  ├─ vite.build() rejects with error
  └─ Deployment error: "Build failed: syntax error in App.tsx"
```

### Flow 3: Metadata-Only Project

```
POST /v1/projects/{id}/deployments
  ├─ Credentials valid, connection verified
  ├─ Returns 202 Accepted + deploymentId
  │  [async pipeline]
  ├─ No .tsx/.jsx files → build skipped
  ├─ SDR deploys metadata
  └─ Deployment result: Succeeded
```

### Flow 4: Build Timeout

```
POST /v1/projects/{id}/deployments
  ├─ Credentials valid, connection verified
  ├─ Returns 202 Accepted + deploymentId
  │  [async pipeline]
  ├─ Project contains src/App.tsx
  ├─ vite.build() exceeds 5 minutes
  ├─ Output directory cleaned up
  └─ Deployment error: "Build timeout after 5 minutes"
```
