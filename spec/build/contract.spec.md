# React Build Integration Contract

## Purpose

Defines the contract for integrating a React build step into the deployment pipeline. When a project has a `package.json` file with a `scripts.build` field, the service must execute `npm run build` before proceeding with metadata deployment to Salesforce.

## Endpoints

### POST /v1/projects/:id/deployments

Initiates a deployment with optional React build step. The behavior depends on project structure:

1. **Build runs and succeeds** → Deployment proceeds → 202 Accepted
2. **Build fails** → Deployment is aborted → 502 Build Failed
3. **Build times out (5 min)** → Deployment is aborted → 502 Build Failed
4. **No package.json** → Skips build, proceeds to deployment → 202 Accepted
5. **package.json exists but no build script** → Skips build, proceeds to deployment → 202 Accepted

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

Returned immediately when build and deployment are successfully initiated.

```json
{
  "deploymentId": "deploy_a1b2c3d4e5f6",
  "status": "Queued"
}
```

**Conditions:**
- Build succeeded (if applicable) or was skipped
- Deployment queued for async execution
- Client can poll `/v1/projects/:id/deployments/:deploymentId` for status

### 502 Build Failed — Build Step Failed

Returned when:
- `npm run build` exits with non-zero status, or
- `npm run build` times out after 5 minutes

```json
{
  "status": 502,
  "title": "Build Failed",
  "detail": "npm run build exited with code 1: [build output]"
}
```

Content-Type: `application/problem+json` (RFC 9457)

**Build Timeout Variant:**
```json
{
  "status": 502,
  "title": "Build Failed",
  "detail": "Build process timeout after 5 minutes"
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

**Conditions:**
- Authorization header missing or malformed
- X-Salesforce-Instance-Url header missing
- X-Salesforce-Instance-Url is not a valid URI

### 404 Project Not Found

```json
{
  "status": 404,
  "title": "Project Not Found",
  "detail": "Project 00000000-0000-0000-0000-000000000000 does not exist"
}
```

**Conditions:**
- Project directory does not exist on server

### 502 Deployment Failed — Salesforce Connection Error

```json
{
  "status": 502,
  "title": "Deployment Failed",
  "detail": "Connection to Salesforce failed: Invalid access token"
}
```

**Conditions:**
- Authentication to Salesforce org failed
- Org is unreachable

## Build Step Logic

### When Build Runs

Build is executed if:
1. `package.json` exists at project root, AND
2. `scripts.build` field is present in package.json

### Build Execution

```bash
npm run build
```

- Executed in project root directory
- Timeout: 5 minutes (300,000 ms)
- Inherits process environment variables
- Build output captured for error reporting

### When Build is Skipped

Build is skipped (deployment proceeds directly) if:
1. `package.json` does not exist, OR
2. `scripts.build` field is absent from package.json

## Deployment Status Polling

After 202 Accepted, client polls deployment status:

```http
GET /v1/projects/{projectId}/deployments/{deploymentId}
```

This endpoint is unchanged by build integration and returns deployment progress/results.

## Error Handling

### Build Errors Take Priority

If build fails, deployment does not proceed. The 502 error includes:
- Build exit code (if available)
- Last 1000 characters of build output (stderr + stdout)
- Timestamp of failure

### Salesforce Errors

If build succeeds but Salesforce connection fails:
- Returns 502 "Deployment Failed" (not "Build Failed")
- Build output is not included (build succeeded, network issue occurred)

## Design Principles

1. **Build gates deployment** — No metadata is deployed if build fails
2. **Fast failure** — Build timeout (5 min) is enforced to prevent indefinite hangs
3. **Graceful degradation** — Projects without build scripts deploy normally
4. **Clear error reporting** — Build failures distinguish from Salesforce connection errors
5. **Async execution** — Build + deployment run in background; client polls for status
6. **No build output streaming** — Build runs silently; only final status reported (future: SSE for build progress)

## Example Flows

### Flow 1: Build Success → Deployment Success

```
POST /v1/projects/proj-123/deployments
  ├─ package.json exists with scripts.build ✓
  ├─ npm run build succeeds ✓
  ├─ Connection to Salesforce validated ✓
  └─ Returns 202 Accepted + deploymentId

Client polls GET /v1/projects/proj-123/deployments/{deploymentId}
  └─ Eventually returns 200 with Succeeded status
```

### Flow 2: Build Fails

```
POST /v1/projects/proj-123/deployments
  ├─ package.json exists with scripts.build ✓
  ├─ npm run build fails (exit code 1) ✗
  └─ Returns 502 Build Failed
     (deployment never reaches Salesforce)
```

### Flow 3: No Build Script, Deploy Only

```
POST /v1/projects/proj-123/deployments
  ├─ package.json does not exist (or no scripts.build)
  ├─ Build skipped (not applicable)
  ├─ Metadata deployment proceeds normally ✓
  └─ Returns 202 Accepted
```

### Flow 4: Build Timeout

```
POST /v1/projects/proj-123/deployments
  ├─ package.json exists with scripts.build ✓
  ├─ npm run build hangs > 5 minutes
  ├─ Build process killed ✗
  └─ Returns 502 Build Failed (timeout)
```

## Related Endpoints

- **GET /v1/projects/:id/deployments/:deploymentId** — Poll deployment status (existing endpoint, unchanged)
- **GET /v1/projects/:id/deployments/:deploymentId/events** — SSE stream of deployment events (existing endpoint, unchanged)

## Future Enhancements

- Build progress streaming via SSE (similar to deployment events)
- Configurable build timeout (override 5 min default)
- Build artifact caching across deployments
- Custom build script support (not just `npm run build`)
