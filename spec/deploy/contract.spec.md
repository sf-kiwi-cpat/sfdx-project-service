# Deployment Contract Specification

## Overview

The deployment system implements an **asynchronous deployment workflow** using HTTP polling and Server-Sent Events (SSE) streaming. Deployments no longer block; clients initiate deployment and receive a unique deployment ID for tracking progress.

## Endpoints

### 1. POST `/v1/projects/:id/deployments`
**Initiate a deployment**

**Request:**
```json
{
  "accessToken": "string (required)",
  "instanceUrl": "string (required, valid URL)"
}
```

**Responses:**

- **202 Accepted** — Deployment started successfully
  ```json
  {
    "deploymentId": "deploy_<unique>",
    "status": "InProgress"
  }
  ```

- **400 Bad Request** — Invalid input
  - Missing `accessToken` or `instanceUrl`
  - `instanceUrl` is not a valid URL
  - Response: RFC 9457 Problem Detail

- **404 Not Found** — Project does not exist
  - Response: RFC 9457 Problem Detail

- **502 Bad Gateway** — Connection to Salesforce failed
  - Response: RFC 9457 Problem Detail

---

### 2. GET `/v1/projects/:id/deployments/:deploymentId`
**Poll deployment status**

**Responses:**

- **200 OK** — Returns current deployment state (works at any point in deployment lifecycle)
  ```json
  {
    "deploymentId": "deploy_<unique>",
    "status": "InProgress | Succeeded | Failed",
    "numberComponentsDeployed": 3,
    "numberComponentsTotal": 5,
    "components": [
      {
        "fullName": "Hello_World__c",
        "type": "CustomObject",
        "state": "Created"
      },
      ...
    ],
    "errorMessage": "string (optional, only if Failed)"
  }
  ```

- **404 Not Found** — Project or deployment does not exist
  - Response: RFC 9457 Problem Detail

---

### 3. GET `/v1/projects/:id/deployments/:deploymentId/events`
**Stream deployment events in real-time (SSE)**

**Response:**
- **200 OK** with `Content-Type: text/event-stream`
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
    "status": "InProgress",
    "message": "Deployment started"
  }
  ```

- `progress` — Component deployed
  ```json
  {
    "status": "InProgress",
    "numberComponentsDeployed": 2,
    "numberComponentsTotal": 5,
    "component": {
      "fullName": "Hello_World__c",
      "type": "CustomObject",
      "state": "Created"
    }
  }
  ```

- `complete` — Deployment finished (success)
  ```json
  {
    "status": "Succeeded",
    "numberComponentsDeployed": 5,
    "numberComponentsTotal": 5,
    "components": [...]
  }
  ```

- `error` — Deployment failed
  ```json
  {
    "status": "Failed",
    "errorMessage": "...",
    "numberComponentsDeployed": 0,
    "numberComponentsTotal": 5
  }
  ```

**Error Responses:**
- **404 Not Found** — Project or deployment does not exist
  - Returns HTTP 404 (not SSE, client failed to connect)

---

## Design Principles

### Async-First
- POST returns immediately (202 Accepted) with a deployment ID
- Deployment continues in the background
- Client can poll status or stream events

### Data Fidelity
- All SDR (Salesforce Deployment Retrieve) response data is echoed through SSE events
- Client receives the same component details, counts, and error messages that SDR produces
- No filtering or summarization

### Error Clarity
- Input validation errors (400) are distinguished from connection/deployment errors (502)
- Missing `sfdx-project.json` returns 400 (not 502)
- `instanceUrl` format is validated before attempting connection

### No Persistence Guarantee
- Deployments are tracked in-memory during their lifecycle
- After completion, deployment state may be dropped from the registry
- Clients should poll/stream during active deployments; long-lived polling not supported

---

## Implementation Notes

### Deployment ID Format
- Format: `deploy_<random>` (e.g., `deploy_a1b2c3d4`)
- Uniqueness: Per project, per deployment
- Used for polling and streaming endpoints

### State Machine
```
Request → 202 Accepted (deploymentId issued)
  ↓
Deployment starts (status: InProgress)
  ↓
Components deployed progressively (progress events)
  ↓
Either:
  - Succeeded (all components deployed)
  - Failed (deployment aborted, error message provided)
```

### Timeout Behavior
**Note:** Timeout behavior is **out of scope** pending product guidance.
- What is the acceptable maximum deployment duration?
- Should it be configurable per-environment?
- What should happen on timeout (cancel, disconnect, retry)?

---

## Examples

### Example 1: Initiate and Poll
```bash
# 1. Initiate deployment
POST /v1/projects/proj-123/deployments
{ "accessToken": "...", "instanceUrl": "https://test.salesforce.com" }
# Response: 202 { deploymentId: "deploy_abc123", status: "InProgress" }

# 2. Poll status
GET /v1/projects/proj-123/deployments/deploy_abc123
# Response: 200 { status: "InProgress", numberComponentsDeployed: 2, ... }

# 3. Poll again later
GET /v1/projects/proj-123/deployments/deploy_abc123
# Response: 200 { status: "Succeeded", numberComponentsDeployed: 5, components: [...] }
```

### Example 2: Initiate and Stream
```bash
# 1. Initiate deployment
POST /v1/projects/proj-123/deployments
{ "accessToken": "...", "instanceUrl": "https://test.salesforce.com" }
# Response: 202 { deploymentId: "deploy_abc123" }

# 2. Connect to SSE stream
GET /v1/projects/proj-123/deployments/deploy_abc123/events
# Receive events in real-time as deployment progresses
event: start
data: { "status": "InProgress", "message": "Deployment started" }

event: progress
data: { "status": "InProgress", "numberComponentsDeployed": 1, ... }

event: complete
data: { "status": "Succeeded", "components": [...] }
```

---

## Error Cases

### Input Validation
| Error | HTTP | Title | Detail |
|-------|------|-------|--------|
| Missing `accessToken` or `instanceUrl` | 400 | Bad Request | accessToken and instanceUrl are required |
| `instanceUrl` not a valid URL | 400 | Bad Request | instanceUrl must be a valid URL |
| Project does not exist | 404 | Not Found | Project not found |

### Runtime
| Error | HTTP | Title | Detail |
|-------|------|-------|--------|
| Connection fails (invalid token) | 502 | Deployment Failed | (error from Salesforce) |
| Deployment fails (invalid metadata) | 200* | (included in polling response) | status: Failed, errorMessage: ... |

*Note: Polling endpoint returns 200 even when deployment failed; failure is indicated in the `status` field, not HTTP status.
