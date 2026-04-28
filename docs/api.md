# API Reference

SF Project Service provides core endpoints for template listing, project creation and retrieval, file inspection, and deployment.

## Base URL

```
http://localhost:3000
```

## Error Handling

All error responses follow [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457.html):

```json
{
  "type": "string (optional)",
  "status": 400,
  "title": "Bad Request",
  "detail": "template is required in request body",
  "instance": "string (optional)"
}
```

Content-Type: `application/problem+json`

## Endpoints

### GET /templates

List all available project templates.

**Response: 200 OK**

```json
[
  {
    "id": "minimal",
    "name": "Minimal"
  },
  {
    "id": "standard-package",
    "name": "Standard Package"
  }
]
```

---

### POST /projects

Create a new project from a template.

**Request Body**

```json
{
  "template": "minimal"
}
```

**Response: 201 Created**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "brave-falcon",
  "lastAccessedAt": "2026-04-27T12:00:00.000Z",
  "initialMessages": [
    { "role": "user", "content": "Build me something" },
    { "role": "assistant", "content": "On it!" }
  ]
}
```

The `id` is a UUID that uniquely identifies the created project and is used in subsequent operations. `name` is an auto-generated human-readable identifier that can be renamed via `PATCH /projects/:id`. `lastAccessedAt` is an ISO 8601 timestamp that updates on every access by ID.

`initialMessages` is only present when the project was created from a template whose `template.json` declares a non-empty `initialMessages` array. Blank projects and templates without `initialMessages` omit the field entirely.

**Response: 400 Bad Request**

```json
{
  "status": 400,
  "title": "Bad Request",
  "detail": "template is required in request body"
}
```

**Response: 404 Not Found** (if template doesn't exist)

```json
{
  "status": 404,
  "title": "Not Found",
  "detail": "Template not found: unknown-template"
}
```

---

### GET /projects/:id

Retrieve a project by ID.

**Path Parameters**

- `id` (string, UUID): Project identifier

**Response: 200 OK**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "brave-falcon",
  "lastAccessedAt": "2026-04-27T12:00:00.000Z",
  "initialMessages": [
    { "role": "user", "content": "Build me something" },
    { "role": "assistant", "content": "On it!" }
  ]
}
```

Every retrieval bumps `lastAccessedAt` to the current time. The returned value is strictly greater than the creation time (and any prior rename time).

`initialMessages` is only present when the project was created from a template that defined them. Blank projects and templates without `initialMessages` omit the field entirely. PATCH rename preserves `initialMessages` untouched.

**Response: 404 Not Found** (if project doesn't exist or `id` is not a UUID)

```json
{
  "status": 404,
  "title": "Project Not Found",
  "detail": "Project not found: invalid-id"
}
```

Malformed UUIDs are treated as "not found" — the only answerable question about a project ID is whether the project exists.

---

### GET /projects/:id/tree

Get the file tree structure for a project.

**Path Parameters**

- `id` (string, UUID): Project identifier

**Response: 200 OK**

```json
{
  "name": "550e8400-e29b-41d4-a716-446655440000",
  "type": "directory",
  "children": [
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
                  "name": "classes",
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

**Response: 404 Not Found** (if project doesn't exist)

```json
{
  "status": 404,
  "title": "Not Found",
  "detail": "Project not found: invalid-id"
}
```

---

### POST /projects/:id/deploy

Deploy project metadata to a Salesforce org.

**Path Parameters**

- `id` (string, UUID): Project identifier

**Request Body**

```json
{
  "accessToken": "00D50000000IZ3dEAG!AQcAQG21FjPFfbvpABqyQfGlZT_y-KzHJSzZ...",
  "instanceUrl": "https://org-instance.my.salesforce.com"
}
```

**Response: 200 OK**

```json
{
  "ok": true,
  "status": "Succeeded",
  "numberComponentsDeployed": 5,
  "numberComponentsTotal": 5,
  "components": [
    {
      "fullName": "Account",
      "type": "ApexClass",
      "state": "Created"
    },
    {
      "fullName": "Contact",
      "type": "ApexClass",
      "state": "Created"
    }
  ]
}
```

**Response: 400 Bad Request** (missing credentials)

```json
{
  "status": 400,
  "title": "Bad Request",
  "detail": "accessToken and instanceUrl are required in the request body"
}
```

**Response: 404 Not Found** (project doesn't exist)

```json
{
  "status": 404,
  "title": "Not Found",
  "detail": "Project not found: invalid-id"
}
```

**Response: 502 Bad Gateway** (deployment failed)

```json
{
  "status": 502,
  "title": "Deployment Failed",
  "detail": "Error message from SDR"
}
```

---

## Interactive API Docs

Swagger UI is available at:

```
GET /docs
```

OpenAPI specification (JSON) is available at:

```
GET /openapi.json
```

---

## Example Workflows

### Create and Deploy a Project

```bash
# 1. List templates
curl http://localhost:3000/templates

# 2. Create project from template
RESPONSE=$(curl -X POST http://localhost:3000/projects \
  -H "Content-Type: application/json" \
  -d '{"template":"minimal"}')
PROJECT_ID=$(echo $RESPONSE | jq -r '.id')

# 3. View project tree
curl http://localhost:3000/projects/$PROJECT_ID/tree

# 4. Deploy to org
curl -X POST http://localhost:3000/projects/$PROJECT_ID/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "accessToken": "YOUR_ACCESS_TOKEN",
    "instanceUrl": "https://your-instance.salesforce.com"
  }'
```

### Error Handling

```bash
# Create with missing template field
curl -X POST http://localhost:3000/projects \
  -H "Content-Type: application/json" \
  -d '{}'
# Response: 400 Bad Request (RFC 9457)

# Access non-existent project
curl http://localhost:3000/projects/invalid-id/tree
# Response: 404 Not Found (RFC 9457)
```
