# Architecture

SF Project Service is a stateless Express REST API that manages SFDX projects and deploys them to Salesforce orgs.

## System Overview

```
┌──────────────────────────────────────────┐
│         Client (IDE, CLI, etc.)          │
└────────────────────┬─────────────────────┘
                     │ HTTP/JSON
                     ▼
┌──────────────────────────────────────────┐
│      Express Application                 │
│  ┌────────────────────────────────────┐  │
│  │ Router                             │  │
│  │ ├─ GET /templates                 │  │
│  │ ├─ POST /projects                 │  │
│  │ ├─ GET /projects/:id/tree         │  │
│  │ └─ POST /projects/:id/deploy      │  │
│  └────────────────────────────────────┘  │
│                   │                       │
│  ┌────────────────▼────────────────────┐  │
│  │ Business Logic (src/*.ts)          │  │
│  │ ├─ templates.ts (list, metadata)  │  │
│  │ ├─ projects.ts (create, get path) │  │
│  │ ├─ deploy.ts (SDR integration)    │  │
│  │ ├─ files.ts (tree building)       │  │
│  │ └─ errors.ts (RFC 9457)           │  │
│  └────────────────┬────────────────────┘  │
│                   │                       │
│  ┌────────────────▼────────────────────┐  │
│  │ Logging & Error Handling           │  │
│  │ ├─ Pino (structured logging)       │  │
│  │ └─ RFC 9457 Problem Details        │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
         │                  │
         ▼                  ▼
┌───────────────────┐ ┌──────────────────────┐
│ File System       │ │ Salesforce Org       │
│                   │ │                      │
│ ├─ templates/    │ │ ├─ Source Retrieve   │
│ ├─ projects/     │ │ └─ Metadata Deploy   │
│ └─ dist/         │ │                      │
└───────────────────┘ └──────────────────────┘
```

## Request Flow

### Project Creation Flow

```
POST /projects { template: "minimal" }
  │
  ├─→ Validate templateId (alphanumeric, hyphens, underscores)
  │   └─→ Throw TemplateNotFoundError if invalid
  │
  ├─→ Check template ZIP exists in templates/
  │   └─→ Throw TemplateNotFoundError if missing
  │
  ├─→ Generate UUID for new project
  │
  ├─→ Create directory in projects/{uuid}/
  │   └─→ Throw error if mkdir fails
  │
  ├─→ Extract template ZIP to projects/{uuid}/
  │   └─→ On failure: delete directory and throw error (cleanup)
  │
  ├─→ Log creation event
  │
  └─→ Return 201 Created { id: "uuid" }
```

### Deployment Flow

```
POST /projects/{id}/deploy { accessToken, instanceUrl }
  │
  ├─→ Validate UUID format
  │   └─→ Throw ProjectNotFoundError if invalid
  │
  ├─→ Check project directory exists
  │   └─→ Throw ProjectNotFoundError if missing
  │
  ├─→ Read sfdx-project.json
  │   └─→ Extract packageDirectories
  │
  ├─→ Build metadata index using @salesforce/source-deploy-retrieve
  │
  ├─→ Execute deploy using Salesforce credentials
  │   ├─→ Poll deployment status
  │   └─→ Return results (deployed components, failures, etc.)
  │
  ├─→ Log deployment metrics
  │
  └─→ Return 200 OK { ok, status, components[], ... }
```

## Module Responsibilities

### `index.ts`
Server entry point. Reads PORT from environment, creates Express app, and starts listening.

### `app.ts`
Express application setup:
- HTTP logging middleware (Pino)
- JSON parsing
- Swagger UI setup
- Route registration
- 404 handler (RFC 9457)
- Global error handler (RFC 9457)

### `config.ts`
Configuration and environment resolution:
- `getProjectPath()` — Main SFDX project root (PROJECT_ROOT env)
- `getProjectsRoot()` — Parent directory for created projects (PROJECTS_ROOT env)
- `getTemplatesDir()` — Directory containing template ZIPs (TEMPLATES_DIR env)

All paths can be overridden via environment for EFS mounting in cloud deployments.

### `logger.ts`
Pino logger configuration. Exported as singleton for use throughout the app.

### `templates.ts`
Template operations:
- `listTemplates()` — Scan `templates/` directory, return array of templates
- Custom errors: `TemplateNotFoundError`

### `projects.ts`
Project lifecycle:
- `createProject(templateId)` — Unzip template, create UUID directory, return project ID
- `getProjectDir(projectId)` — Validate UUID, return absolute path to project directory
- Custom errors: `ProjectNotFoundError`

Security: UUID validation prevents path traversal attacks.

### `deploy.ts`
Salesforce metadata deployment:
- `deployMetadata(projectDir, credentials)` — Read sfdx-project.json, extract packages, deploy using @salesforce/source-deploy-retrieve
- Type: `OrgCredentials` — { accessToken, instanceUrl }
- Returns: deployment result object with ok flag, component status, etc.

### `files.ts`
File tree traversal:
- `buildTree(name?, dir)` — Recursively walk directory, return TreeNode structure
- TreeNode: { name, type: "file" | "directory", children? }

### `errors.ts`
RFC 9457 Problem Details error handling:
- `errorToProblem(err)` — Convert any error to Problem Detail object
- `problemDetail(status, title, detail)` — Create Problem Detail
- Exports PROBLEM_JSON content type constant

### Routes (`routes/*.ts`)
Express route handlers. Each module creates a router and defines one or more endpoints:
- `templates.routes.ts` — GET /templates
- `projects.routes.ts` — POST /projects, GET /projects/:id/tree
- `deploy.routes.ts` — POST /projects/:id/deploy

## Security Architecture

### Input Validation

1. **Template ID validation** (`projects.ts`)
   - Regex: `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`
   - Prevents invalid filenames and path traversal

2. **Project ID (UUID) validation** (`projects.ts`)
   - Regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
   - Prevents path traversal and invalid UUIDs
   - Enforced before any filesystem operations

3. **Request body validation**
   - `template` field required in POST /projects
   - `accessToken` and `instanceUrl` required in POST /projects/:id/deploy

### Error Handling

- RFC 9457 Problem Details for all errors (consistent JSON responses)
- Sensitive stack traces only logged (not returned to client)
- Custom error classes with meaningful messages
- Global error handler catches unexpected errors and returns 500

### Filesystem Operations

- Directory creation with recursive flag
- Cleanup on failure (failed template extraction deletes created directory)
- File existence checks before operations
- Permissions inherited from Node.js process

### Credentials Handling

- Access tokens and instance URLs passed in request body (HTTPS in production)
- Never logged or cached
- Immediately forwarded to Salesforce API
- No local credential storage

## Data Flow

### Project Storage

```
projects/
├── 550e8400-e29b-41d4-a716-446655440000/
│   ├── sfdx-project.json
│   ├── force-app/
│   │   └── main/
│   │       └── default/
│   │           ├── classes/
│   │           ├── aura/
│   │           └── staticresources/
│   └── .gitignore
└── 660f9500-f30c-52e5-b827-557766551111/
    └── ... (another project)
```

Each project is isolated in its own directory. No shared state.

### Template Structure

```
templates/
├── minimal.zip          → Unzips to contain sfdx-project.json + force-app/
├── standard-package.zip → Unzips to contain multiple packages
└── enterprise.zip       → Unzips to contain complex structure
```

Templates are ZIP files representing complete SFDX project structures.

## Deployment Architecture

Deployment uses **@salesforce/source-deploy-retrieve** (SDR):

1. Read `sfdx-project.json` from project directory
2. Extract `packageDirectories` list
3. Index source code in each package
4. Create deployment container with metadata components
5. Deploy to Salesforce org using provided credentials
6. Poll deployment status
7. Return results (component list, status, ok flag)

SDR handles:
- Metadata API calls
- Component resolution
- Deployment polling
- Error conversion

## Testing Architecture

- **Unit tests** — Pure functions, no filesystem/network (3 files)
- **Integration tests** — Real filesystem, mocked Salesforce API (4 files)
- **Acceptance tests** — Full flow including deployment simulation

Coverage threshold: 90% overall, 85% per file on branches.

See [development.md](./development.md) for test running and coverage details.

## Deployment Considerations

### Horizontal Scaling

The service is stateless. All state is in the filesystem:
- `projects/` can be on shared EFS
- `templates/` can be on shared read-only storage
- Multiple instances can run concurrently

### Environment Variables

```bash
PORT=3000                         # HTTP port
PROJECT_ROOT=./project            # Main SFDX project (for /project/init)
PROJECTS_ROOT=/mnt/efs/projects   # EFS mount for projects
TEMPLATES_DIR=/app/templates      # Read-only template location
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
COPY templates/ ./templates/
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

See [development.md](./development.md) for build instructions.
