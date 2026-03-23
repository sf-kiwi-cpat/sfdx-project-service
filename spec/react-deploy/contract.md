# Vite Build Integration Contract

## Purpose

Defines the contract for integrating a Vite programmatic build step into the deployment pipeline. When a project contains `.tsx` or `.jsx` source files, the service runs `vite.build()` before proceeding with metadata deployment to Salesforce. The service owns the build configuration — the user's project has no build tooling (no `package.json`, no `vite.config.ts`).

## Endpoints

### POST /v1/projects/:id/deployments

Initiates a deployment with optional Vite build step. Behavior depends on project contents:

1. **Project has .tsx/.jsx files, build succeeds** -> Deployment proceeds -> 202 Accepted
2. **Project has .tsx/.jsx files, build fails** -> Deployment aborted -> 502 Build Failed
3. **Project has .tsx/.jsx files, build times out (5 min)** -> Deployment aborted -> 502 Build Failed
4. **No .tsx/.jsx files (metadata-only)** -> Build skipped, deployment proceeds -> 202 Accepted

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

### 202 Accepted — Build and/or Deployment Queued

Returned when build succeeds (or is skipped) and deployment is queued.

```json
{
  "deploymentId": "deploy_a1b2c3d4e5f6",
  "status": "Queued"
}
```

**Conditions:**
- Build completed successfully (if applicable) or was skipped (no tsx/jsx)
- Deployment queued for async execution
- Client can poll `/v1/projects/:id/deployments/:deploymentId` for status

### 502 Build Failed

Returned when `vite.build()` fails or times out. Deployment is not queued.

```json
{
  "status": 502,
  "title": "Build Failed",
  "detail": "Build failed: syntax error in App.tsx"
}
```

Content-Type: `application/problem+json` (RFC 9457)

**Build Timeout Variant:**
```json
{
  "status": 502,
  "title": "Build Failed",
  "detail": "Build timed out after 5 minutes"
}
```

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
- **Output:** `force-app/main/default/staticresources/App/`
- **Timeout:** 5 minutes (300,000 ms) via AbortSignal
- **Framework:** React (JSX transform configured by service)

The user's project contains only source files (`.tsx`, `.jsx`, `index.html`). No `package.json`, `vite.config.ts`, or `node_modules` exist in the project — the service owns all build infrastructure.

### When Build is Skipped

Build is skipped (deployment proceeds directly) when no `.tsx` or `.jsx` files exist in the project directory. This covers metadata-only SFDX projects.

### Build Output

Vite outputs compiled assets to `force-app/main/default/staticresources/App/`. SDR then picks up these files as part of the normal metadata deployment to Salesforce.

## Request Processing Order

```
1. Extract and validate credentials          -> 400 if missing/invalid
2. Resolve project directory                 -> 404 if not found
3. Detect .tsx/.jsx files in project
4. If found: run vite.build() synchronously  -> 502 "Build Failed" on error/timeout
5. Validate Salesforce connection eagerly     -> 502 "Deployment Failed" on error
6. Create deployment record
7. Start async metadata deployment
8. Return 202 Accepted
```

Build is **synchronous** — it runs in the POST handler before 202 is returned. Build failure returns 502 immediately (fast failure). Don't queue a deployment if the code doesn't compile.

## Design Principles

1. **Service owns the build** — User vibecodes React; all deployment mechanics are hidden
2. **Detection by content** — `.tsx`/`.jsx` presence, not `package.json` or config files
3. **Programmatic API** — `vite.build()` not shell execution; safer, faster, more control
4. **Build gates deployment** — No metadata is deployed if build fails
5. **Fast failure** — 5-minute timeout enforced via AbortSignal
6. **Graceful degradation** — Metadata-only projects deploy without any build step

## Example Flows

### Flow 1: React Project — Build Success

```
POST /v1/projects/{id}/deployments
  |- Credentials valid
  |- Project found, contains src/App.tsx
  |- vite.build() succeeds -> assets in staticresources/App/
  |- Salesforce connection validated
  |- Deployment queued
  '- Returns 202 Accepted + deploymentId
```

### Flow 2: React Project — Build Fails

```
POST /v1/projects/{id}/deployments
  |- Credentials valid
  |- Project found, contains src/App.tsx
  |- vite.build() rejects with error
  '- Returns 502 Build Failed (deployment never queued)
```

### Flow 3: Metadata-Only Project

```
POST /v1/projects/{id}/deployments
  |- Credentials valid
  |- Project found, no .tsx/.jsx files
  |- Build skipped
  |- Salesforce connection validated
  |- Deployment queued (metadata only)
  '- Returns 202 Accepted
```

### Flow 4: Build Timeout

```
POST /v1/projects/{id}/deployments
  |- Credentials valid
  |- Project found, contains src/App.tsx
  |- vite.build() exceeds 5 minutes -> AbortError
  '- Returns 502 Build Failed (detail contains "timeout")
```
