# API Examples

Practical examples for using SF Project Service APIs.

## Setup

Ensure the server is running:

```bash
npm run dev
# Listening on http://localhost:3000
```

## Example: Complete Workflow

### 1. List Templates

```bash
curl http://localhost:3000/templates
```

**Response:**
```json
[
  {
    "id": "minimal",
    "name": "Minimal"
  },
  {
    "id": "standard-package",
    "name": "Standard Package"
  },
  {
    "id": "enterprise",
    "name": "Enterprise"
  }
]
```

### 2. Create a Project

```bash
curl -X POST http://localhost:3000/projects \
  -H "Content-Type: application/json" \
  -d '{"template":"minimal"}'
```

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000"
}
```

Save the project ID:
```bash
PROJECT_ID="550e8400-e29b-41d4-a716-446655440000"
```

### 3. Inspect Project Tree

```bash
curl http://localhost:3000/projects/$PROJECT_ID/tree | jq .
```

**Response:**
```json
{
  "name": "550e8400-e29b-41d4-a716-446655440000",
  "type": "directory",
  "children": [
    {
      "name": ".gitignore",
      "type": "file"
    },
    {
      "name": "sfdx-project.json",
      "type": "file"
    },
    {
      "name": "force-app",
      "type": "directory",
      "children": [
        {
          "name": "main",
          "type": "directory",
          "children": [
            {
              "name": "default",
              "type": "directory",
              "children": [
                {
                  "name": "aura",
                  "type": "directory",
                  "children": []
                },
                {
                  "name": "classes",
                  "type": "directory",
                  "children": []
                },
                {
                  "name": "staticresources",
                  "type": "directory",
                  "children": []
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

### 4. Deploy to Salesforce Org

First, obtain Salesforce credentials (OAuth access token and instance URL). Example using Salesforce CLI:

```bash
sfdx auth:web:login -a myorg
sfdx org:display -u myorg --json | jq '.result'
# Extract: accessToken and instanceUrl
```

Deploy:

```bash
curl -X POST http://localhost:3000/projects/$PROJECT_ID/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "accessToken": "00D50000000IZ3dEAG!AQcAQG21FjPFfbvpABqyQfGlZT_y-KzHJSzZ...",
    "instanceUrl": "https://org-instance.my.salesforce.com"
  }'
```

**Response:**
```json
{
  "ok": true,
  "status": "Succeeded",
  "numberComponentsDeployed": 3,
  "numberComponentsTotal": 3,
  "components": [
    {
      "fullName": "HelloWorld",
      "type": "ApexClass",
      "state": "Created"
    },
    {
      "fullName": "Account",
      "type": "CustomObject",
      "state": "Created"
    },
    {
      "fullName": "CustomApp",
      "type": "CustomApplication",
      "state": "Created"
    }
  ]
}
```

## Error Handling Examples

### Missing Template Field

```bash
curl -X POST http://localhost:3000/projects \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Response:** 400 Bad Request
```json
{
  "status": 400,
  "title": "Bad Request",
  "detail": "template is required in request body"
}
```

### Invalid Template

```bash
curl -X POST http://localhost:3000/projects \
  -H "Content-Type: application/json" \
  -d '{"template":"does-not-exist"}'
```

**Response:** 404 Not Found
```json
{
  "status": 404,
  "title": "Not Found",
  "detail": "Template not found: does-not-exist"
}
```

### Invalid Project ID

```bash
curl http://localhost:3000/projects/invalid-id/tree
```

**Response:** 404 Not Found
```json
{
  "status": 404,
  "title": "Not Found",
  "detail": "Project not found: invalid-id"
}
```

### Missing Deployment Credentials

```bash
curl -X POST http://localhost:3000/projects/$PROJECT_ID/deploy \
  -H "Content-Type: application/json" \
  -d '{"instanceUrl":"https://org.salesforce.com"}'
```

**Response:** 400 Bad Request
```json
{
  "status": 400,
  "title": "Bad Request",
  "detail": "accessToken and instanceUrl are required in the request body"
}
```

### Deployment Failure

```bash
curl -X POST http://localhost:3000/projects/$PROJECT_ID/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "accessToken": "invalid_token",
    "instanceUrl": "https://org.salesforce.com"
  }'
```

**Response:** 502 Bad Gateway
```json
{
  "status": 502,
  "title": "Deployment Failed",
  "detail": "Invalid access token provided"
}
```

## Scripted Usage (Bash)

### Create and Deploy Multiple Projects

```bash
#!/bin/bash

TEMPLATES=("minimal" "standard-package")
ACCESS_TOKEN="your_access_token"
INSTANCE_URL="https://your-instance.salesforce.com"

for template in "${TEMPLATES[@]}"; do
  echo "Creating project from $template..."
  response=$(curl -s -X POST http://localhost:3000/projects \
    -H "Content-Type: application/json" \
    -d "{\"template\":\"$template\"}")

  project_id=$(echo "$response" | jq -r '.id')
  echo "Created project: $project_id"

  echo "Deploying $project_id..."
  curl -s -X POST http://localhost:3000/projects/$project_id/deploy \
    -H "Content-Type: application/json" \
    -d "{
      \"accessToken\":\"$ACCESS_TOKEN\",
      \"instanceUrl\":\"$INSTANCE_URL\"
    }" | jq .

  echo "---"
done
```

### Wait for Project Tree Availability

```bash
#!/bin/bash

PROJECT_ID="550e8400-e29b-41d4-a716-446655440000"
MAX_RETRIES=10
RETRY_DELAY=1

for i in $(seq 1 $MAX_RETRIES); do
  response=$(curl -s -w "\n%{http_code}" http://localhost:3000/projects/$PROJECT_ID/tree)
  http_code=$(echo "$response" | tail -1)

  if [ "$http_code" = "200" ]; then
    echo "Project tree available!"
    echo "$response" | head -n -1 | jq .
    exit 0
  fi

  echo "Attempt $i/$MAX_RETRIES failed (HTTP $http_code). Retrying in ${RETRY_DELAY}s..."
  sleep $RETRY_DELAY
done

echo "Project not available after $MAX_RETRIES attempts"
exit 1
```

## Using with jq

Filter and format responses:

```bash
# Get first template ID
curl -s http://localhost:3000/templates | jq -r '.[0].id'

# Extract deployment status
curl -s -X POST http://localhost:3000/projects/$PROJECT_ID/deploy ... | jq '.status'

# Count deployed components
curl -s -X POST http://localhost:3000/projects/$PROJECT_ID/deploy ... | jq '.numberComponentsDeployed'

# List component names
curl -s -X POST http://localhost:3000/projects/$PROJECT_ID/deploy ... | jq -r '.components[].fullName'
```

## Using with JavaScript/Node.js

```javascript
const fetch = require('node-fetch');

const BASE_URL = 'http://localhost:3000';

async function listTemplates() {
  const response = await fetch(`${BASE_URL}/templates`);
  return response.json();
}

async function createProject(templateId) {
  const response = await fetch(`${BASE_URL}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: templateId })
  });
  return response.json();
}

async function deployProject(projectId, accessToken, instanceUrl) {
  const response = await fetch(`${BASE_URL}/projects/${projectId}/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, instanceUrl })
  });
  return response.json();
}

// Usage
(async () => {
  const templates = await listTemplates();
  console.log('Templates:', templates);

  const project = await createProject(templates[0].id);
  console.log('Created project:', project.id);

  const result = await deployProject(
    project.id,
    'YOUR_TOKEN',
    'https://your-org.salesforce.com'
  );
  console.log('Deployment result:', result);
})();
```

## Using with Python

```python
import requests
import json

BASE_URL = 'http://localhost:3000'

def list_templates():
    response = requests.get(f'{BASE_URL}/templates')
    return response.json()

def create_project(template_id):
    response = requests.post(
        f'{BASE_URL}/projects',
        json={'template': template_id}
    )
    return response.json()

def deploy_project(project_id, access_token, instance_url):
    response = requests.post(
        f'{BASE_URL}/projects/{project_id}/deploy',
        json={'accessToken': access_token, 'instanceUrl': instance_url}
    )
    return response.json()

# Usage
templates = list_templates()
print('Templates:', templates)

project = create_project(templates[0]['id'])
print('Created project:', project['id'])

result = deploy_project(
    project['id'],
    'YOUR_TOKEN',
    'https://your-org.salesforce.com'
)
print('Deployment result:', json.dumps(result, indent=2))
```

## Performance Considerations

### Deployment Time

Deployments can take 30 seconds to several minutes depending on:
- Number of components
- Org metadata complexity
- Network latency
- Salesforce infrastructure load

Consider implementing client-side timeouts:

```bash
curl --max-time 300 \  # 5 minute timeout
  -X POST http://localhost:3000/projects/$PROJECT_ID/deploy ...
```

### Project Creation

Project creation (template extraction) is typically < 1 second for small templates.

### File Tree Operations

File tree traversal is fast for typical SFDX project sizes (< 100ms for 1000 files).

For very large projects (> 10,000 files), consider implementing pagination or caching on the client side.
