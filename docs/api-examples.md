# API Examples

Practical examples for using SF Project Service APIs. See
[api.md](./api.md) for the full endpoint reference.

## Setup

Ensure the server is running:

```bash
npm run dev
# Listening on http://localhost:3000
```

Auth note: deployments use the **zero-auth** model. You don't pass
access tokens to the service — instead, you `sf org login web --alias
<alias>` on the host running the service, then declare that alias
when you deploy.

## Example: Complete Workflow

### 1. List templates

```bash
curl http://localhost:3000/v1/templates
```

**Response:**
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

### 2. Create a project

```bash
curl -X POST http://localhost:3000/v1/projects \
  -H "Content-Type: application/json" \
  -d '{"template":"metadata-ownership-tracking"}'
```

**Response: `201 Created`**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "brave-falcon",
  "lastAccessedAt": "2026-04-27T12:00:00.000Z"
}
```

Save the project ID:
```bash
PROJECT_ID="550e8400-e29b-41d4-a716-446655440000"
```

Optionally pin a deploy target at creation time:

```bash
curl -X POST http://localhost:3000/v1/projects \
  -H "Content-Type: application/json" \
  -d '{"template":"metadata-ownership-tracking","orgAlias":"my-scratch-org"}'
```

### 3. Inspect the project tree

```bash
curl http://localhost:3000/v1/projects/$PROJECT_ID/tree | jq .
```

**Response:**
```json
{
  "name": "550e8400-e29b-41d4-a716-446655440000",
  "type": "directory",
  "children": [
    { "name": "sfdx-project.json", "type": "file" },
    { "name": "force-app", "type": "directory", "children": [] }
  ]
}
```

### 4. Read a specific file

```bash
curl "http://localhost:3000/v1/projects/$PROJECT_ID/file?path=sfdx-project.json"
```

Returns the raw file bytes as `text/plain`.

### 5. Subscribe to filesystem events (in a separate terminal)

```bash
curl -N -H "Accept: text/event-stream" \
  http://localhost:3000/v1/projects/$PROJECT_ID/fs/events
```

Any write under the project directory surfaces here — from agent
tool calls, MCP tools, shell commands, or manual edits.

### 6. Start a deployment

Deployments are asynchronous. The POST returns `202 Accepted` with a
`deploymentId`; progress streams over SSE.

```bash
# Body is empty — auth resolves from (in order) SF_TARGET_ORG, the
# project's pinned target-org, or the global sf default org.
DEPLOYMENT=$(curl -sX POST \
  http://localhost:3000/v1/projects/$PROJECT_ID/deployments \
  -H "Content-Type: application/json" \
  -d '{}')
DEPLOYMENT_ID=$(echo "$DEPLOYMENT" | jq -r '.deploymentId')
echo "$DEPLOYMENT" | jq .
# {
#   "deploymentId": "deploy_1711353600000_a1b2c3d",
#   "status": "Queued"
# }
```

To override the target org for this deploy only:

```bash
curl -X POST http://localhost:3000/v1/projects/$PROJECT_ID/deployments \
  -H "Content-Type: application/json" \
  -d '{"orgAlias":"my-scratch-org"}'
```

### 7. Stream deployment progress

```bash
curl -N -H "Accept: text/event-stream" \
  http://localhost:3000/v1/projects/$PROJECT_ID/deployments/$DEPLOYMENT_ID/events
```

**Example stream (single-pass deploy):**
```
event: start
data: {"deploymentId":"deploy_1711353600000_a1b2c3d"}

event: progress
data: {"deploymentId":"deploy_1711353600000_a1b2c3d","status":"InProgress","numberComponentsDeployed":1,"numberComponentsTotal":3,"components":[...]}

event: complete
data: {"deploymentId":"deploy_1711353600000_a1b2c3d","status":"Succeeded","numberComponentsDeployed":3,"numberComponentsTotal":3,"components":[...]}
```

**Example stream (staged deploy, e.g. `data-curator`):**
```
event: start
data: {"deploymentId":"..."}

event: stage
data: {"deploymentId":"...","name":"manifest/package.xml","index":0,"total":4}

event: progress
data: {"deploymentId":"...","status":"Succeeded","numberComponentsDeployed":12,"numberComponentsTotal":12,"components":[...]}

event: stage
data: {"deploymentId":"...","name":"manifest/flows-package.xml","index":1,"total":4}

event: progress
...

event: complete
data: {"deploymentId":"...","status":"Succeeded","stages":[...],"appUrl":"https://test.salesforce.com/lwr/application/ai/c-MyApp"}
```

The stream is reconnect-safe: a fresh subscription replays every
prior `stage`, `progress`, and `warning` event, and if the deploy
has already finished you get `complete` immediately.

## Error Handling Examples

### Unknown property

All product endpoints reject unknown body fields.

```bash
curl -X POST http://localhost:3000/v1/projects \
  -H "Content-Type: application/json" \
  -d '{"template":"metadata-ownership-tracking","typo":"oops"}'
```

**Response: `400 Bad Request`**
```json
{
  "status": 400,
  "title": "Bad Request",
  "detail": "body must NOT have additional properties: 'typo'"
}
```

### Unknown template

```bash
curl -X POST http://localhost:3000/v1/projects \
  -H "Content-Type: application/json" \
  -d '{"template":"does-not-exist"}'
```

**Response: `400 Bad Request`** — `detail: "Template not found: does-not-exist"`.

### Invalid / unknown project ID

```bash
curl http://localhost:3000/v1/projects/invalid-id/tree
```

**Response: `404 Not Found`**

### Empty `orgAlias`

```bash
curl -X POST http://localhost:3000/v1/projects/$PROJECT_ID/deployments \
  -H "Content-Type: application/json" \
  -d '{"orgAlias":""}'
```

**Response: `400 Bad Request`** — explicit empty strings are
rejected on both `POST /v1/projects` and
`POST /v1/projects/:id/deployments`. (The deploy endpoint rejects
at the schema layer via `minLength: 1`; `POST /v1/projects`
rejects in `createBlankProject` via `OrgAliasEmptyError`.)

### `orgAlias` that isn't logged in

```bash
curl -X POST http://localhost:3000/v1/projects/$PROJECT_ID/deployments \
  -H "Content-Type: application/json" \
  -d '{"orgAlias":"not-a-real-alias"}'
```

**Response: `400 Bad Request`**
```json
{
  "status": 400,
  "title": "Bad Request",
  "detail": "orgAlias 'not-a-real-alias' does not resolve to a Salesforce username. Run `sf org login web --alias not-a-real-alias` or use a different alias."
}
```

### No auth available

```bash
# With no SF_TARGET_ORG, no project target-org, and no global default
curl -X POST http://localhost:3000/v1/projects/$PROJECT_ID/deployments \
  -H "Content-Type: application/json" -d '{}'
```

**Response: `400 Bad Request`** — `detail` explains the zero-auth
chain and how to populate it.

### SSE without `Accept` header

```bash
curl http://localhost:3000/v1/projects/$PROJECT_ID/fs/events
```

**Response: `400 Bad Request`** — the stream never opens.

## Scripted Usage (Bash)

### Create and deploy multiple projects

```bash
#!/bin/bash
set -euo pipefail

ORG_ALIAS="my-scratch-org"            # pre-authed via `sf org login web`
TEMPLATES=("metadata-ownership-tracking" "work-tracking")

for template in "${TEMPLATES[@]}"; do
  echo "Creating project from $template..."
  response=$(curl -sX POST http://localhost:3000/v1/projects \
    -H "Content-Type: application/json" \
    -d "{\"template\":\"$template\",\"orgAlias\":\"$ORG_ALIAS\"}")
  project_id=$(echo "$response" | jq -r '.id')
  echo "Created project: $project_id"

  echo "Starting deployment..."
  deployment=$(curl -sX POST \
    http://localhost:3000/v1/projects/$project_id/deployments \
    -H "Content-Type: application/json" -d '{}')
  deployment_id=$(echo "$deployment" | jq -r '.deploymentId')

  echo "Tailing deployment events..."
  curl -N -H "Accept: text/event-stream" \
    http://localhost:3000/v1/projects/$project_id/deployments/$deployment_id/events
  echo "---"
done
```

### Poll for project tree availability

```bash
#!/bin/bash
PROJECT_ID="550e8400-e29b-41d4-a716-446655440000"
for i in $(seq 1 10); do
  http_code=$(curl -so /dev/null -w "%{http_code}" \
    http://localhost:3000/v1/projects/$PROJECT_ID/tree)
  if [ "$http_code" = "200" ]; then
    curl -s http://localhost:3000/v1/projects/$PROJECT_ID/tree | jq .
    exit 0
  fi
  echo "Attempt $i: HTTP $http_code. Retrying..."
  sleep 1
done
echo "Project not available"
exit 1
```

## Using with jq

```bash
# First template id
curl -s http://localhost:3000/v1/templates | jq -r '.[0].id'

# Just the deployment id
curl -sX POST http://localhost:3000/v1/projects/$PROJECT_ID/deployments \
  -H "Content-Type: application/json" -d '{}' | jq -r '.deploymentId'
```

## Using with JavaScript/Node.js

```javascript
const BASE_URL = 'http://localhost:3000';

async function listTemplates() {
  const res = await fetch(`${BASE_URL}/v1/templates`);
  return res.json();
}

async function createProject(template, orgAlias) {
  const res = await fetch(`${BASE_URL}/v1/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template, orgAlias }),
  });
  return res.json();
}

async function startDeployment(projectId, orgAlias) {
  const res = await fetch(
    `${BASE_URL}/v1/projects/${projectId}/deployments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orgAlias ? { orgAlias } : {}),
    },
  );
  return res.json(); // { deploymentId, status: 'Queued' }
}

async function streamDeployment(projectId, deploymentId, onEvent) {
  const res = await fetch(
    `${BASE_URL}/v1/projects/${projectId}/deployments/${deploymentId}/events`,
    { headers: { Accept: 'text/event-stream' } },
  );
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop();
    for (const block of events) onEvent(parseSseBlock(block));
  }
}

function parseSseBlock(block) {
  const lines = block.split('\n');
  const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
  const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
  return { event, data: data ? JSON.parse(data) : undefined };
}
```

## Using with Python

```python
import json
import requests

BASE_URL = 'http://localhost:3000'

def list_templates():
    return requests.get(f'{BASE_URL}/v1/templates').json()

def create_project(template, org_alias=None):
    body = {'template': template}
    if org_alias:
        body['orgAlias'] = org_alias
    return requests.post(f'{BASE_URL}/v1/projects', json=body).json()

def start_deployment(project_id, org_alias=None):
    body = {'orgAlias': org_alias} if org_alias else {}
    return requests.post(
        f'{BASE_URL}/v1/projects/{project_id}/deployments',
        json=body,
    ).json()  # {'deploymentId': ..., 'status': 'Queued'}

def stream_deployment(project_id, deployment_id):
    url = (f'{BASE_URL}/v1/projects/{project_id}'
           f'/deployments/{deployment_id}/events')
    with requests.get(url,
                      headers={'Accept': 'text/event-stream'},
                      stream=True) as r:
        event = None
        for raw in r.iter_lines(decode_unicode=True):
            if not raw:
                continue
            if raw.startswith('event: '):
                event = raw[len('event: '):]
            elif raw.startswith('data: '):
                yield event, json.loads(raw[len('data: '):])
                event = None
```

## Performance Considerations

### Deployment time

Deployments can take 30 seconds to several minutes depending on:
- Component count and metadata complexity
- Network latency
- Salesforce infrastructure load
- Number of stages for staged deploys (e.g., `data-curator` ships
  four stages)

Prefer the SSE stream over polling. Since the stream is
reconnect-safe, you can drop and reconnect freely without losing
history.

### Project creation

Template extraction is typically sub-second for small templates.

### File tree

Tree traversal is fast for typical SFDX projects (< 100ms for
~1,000 files). For very large trees, consider client-side caching —
the service does not paginate.
