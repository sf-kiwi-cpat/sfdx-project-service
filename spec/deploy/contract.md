# Deployment Contract Specification

## Overview

The deployment system implements an **asynchronous deployment workflow** using Server-Sent Events (SSE) streaming. Deployments are non-blocking: clients initiate a deployment and receive a unique deployment ID, then connect to the SSE stream for real-time progress updates. There is no polling endpoint — SSE is the single channel for deployment status.

## Endpoints

### 1. POST `/v1/projects/:id/deployments`
**Initiate a deployment**

**Request Headers:**
- `Authorization` (required): OAuth 2.0 access token in Bearer scheme
- `X-Salesforce-Instance-Url` (required): Salesforce org instance URL (must be valid URI)

**Responses:**

- **202 Accepted** — Deployment started successfully
  ```json
  {
    "deploymentId": "deploy_<unique>",
    "status": "Queued"
  }
  ```

- **400 Bad Request** — Invalid input
  - Missing `Authorization` or `X-Salesforce-Instance-Url`
  - `instanceUrl` is not a valid URL
  - Response: RFC 9457 Problem Detail

- **404 Not Found** — Project does not exist
  - Response: RFC 9457 Problem Detail

- **502 Bad Gateway** — Connection to Salesforce failed
  - Response: RFC 9457 Problem Detail

---

### 2. GET `/v1/projects/:id/deployments/:deploymentId/events`
**Stream deployment events in real-time (SSE)**

**Response:**
- **200 OK** with `Content-Type: text/event-stream` and `Cache-Control: no-cache`
- Streams Server-Sent Events as deployment progresses
- Each event is a JSON object containing full SDR data for that moment

**Event Format:**
```
event: <type>
data: <JSON>

```

**Event Types and Content:**
- `start` — Deployment initiated
  ```json
  {
    "deploymentId": "deploy_<unique>"
  }
  ```

- `progress` — Component deployed
  ```json
  {
    "deploymentId": "deploy_<unique>",
    "timestamp": "2026-03-25T10:00:00.000Z",
    "status": "InProgress",
    "numberComponentsDeployed": 2,
    "numberComponentsTotal": 5,
    "components": [
      {
        "fullName": "Hello_World__c",
        "type": "CustomObject",
        "state": "Created"
      }
    ]
  }
  ```

- `complete` — Deployment finished (success or failure)
  ```json
  {
    "deploymentId": "deploy_<unique>",
    "status": "Succeeded",
    "numberComponentsDeployed": 5,
    "numberComponentsTotal": 5,
    "components": [...],
    "appUrl": "https://example.salesforce.com/lwr/application/ai/c-App"
  }
  ```

  **`appUrl`** (optional): Present only when the deployment succeeds AND includes
  a `WebApplication` component. Format: `{instanceUrl}/lwr/application/ai/c-{appName}`,
  where `appName` is the `fullName` of the deployed WebApplication component.
  Omitted when:
  - The deployment fails
  - No `WebApplication` component is in the deployment

**Error Responses:**
- **404 Not Found** — Project or deployment does not exist
  - Returns HTTP 404 (not SSE, client failed to connect)

---

## Design Principles

### Async-First
- POST returns immediately (202 Accepted) with a deployment ID
- Deployment continues in the background (build + deploy pipeline)
- Client connects to SSE stream for real-time updates

### Single Event Channel
- All deployment events (build, deploy, completion, errors) flow through one SSE endpoint
- No separate polling endpoint — SSE is the only way to track deployment status
- Simplifies client implementation and reduces API surface

### Data Fidelity
- All SDR (Salesforce Deployment Retrieve) response data is echoed through SSE events
- Client receives the same component details, counts, and error messages that SDR produces
- No filtering or summarization

### Error Clarity
- Input validation errors (400) are distinguished from connection/deployment errors (502)
- `instanceUrl` format is validated before attempting connection
- Build and deploy errors surface as deployment results in the SSE stream

### No Persistence Guarantee
- Deployments are tracked in-memory during their lifecycle
- After completion, deployment state may be dropped from the registry
- Clients should stream during active deployments

---

## Implementation Notes

### Deployment ID Format
- Format: `deploy_<timestamp>_<random>` (e.g., `deploy_1711353600000_a1b2c3d`)
- Uniqueness: Per project, per deployment
- Used for the SSE streaming endpoint

### State Machine
```
Request → 202 Accepted (deploymentId issued)
  ↓
[async] Build step (if React project)
  ↓
[async] Metadata deployment (SDR)
  ↓
Either:
  - Succeeded (all components deployed)
  - Failed (build error, deployment error, or timeout)
```

---

## Examples

### Initiate and Stream
```bash
# 1. Initiate deployment
POST /v1/projects/proj-123/deployments
Authorization: Bearer <token>
X-Salesforce-Instance-Url: https://test.salesforce.com
# Response: 202 { deploymentId: "deploy_abc123", status: "Queued" }

# 2. Connect to SSE stream
GET /v1/projects/proj-123/deployments/deploy_abc123/events
# Receive events in real-time as deployment progresses
event: start
data: {"deploymentId":"deploy_abc123"}

event: progress
data: {"deploymentId":"deploy_abc123","status":"InProgress","numberComponentsDeployed":1,...}

event: complete
data: {"deploymentId":"deploy_abc123","status":"Succeeded","components":[...],"appUrl":"https://test.salesforce.com/lwr/application/ai/c-App"}
```

---

## Error Cases

### Input Validation
| Error | HTTP | Title | Detail |
|-------|------|-------|--------|
| Missing credentials | 400 | Bad Request | Authorization header is missing |
| `instanceUrl` not a valid URL | 400 | Bad Request | instanceUrl must be a valid URL |
| Project does not exist | 404 | Not Found | Project not found |

### Runtime
| Error | HTTP | Title | Detail |
|-------|------|-------|--------|
| Connection fails (invalid token) | 502 | Deployment Failed | (error from Salesforce) |
| Build fails | — | — | Surfaces in SSE complete event as deployment error |
| Deploy fails | — | — | Surfaces in SSE complete event with status: Failed |
