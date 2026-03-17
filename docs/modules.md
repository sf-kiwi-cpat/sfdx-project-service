# Module Reference

Detailed documentation of all modules in SF Project Service.

## Table of Contents

- [templates.ts](#templatests) — Template listing and metadata
- [projects.ts](#projectsts) — Project creation and path resolution
- [deploy.ts](#deployts) — Metadata deployment to Salesforce
- [files.ts](#filests) — File tree building
- [errors.ts](#errorsts) — RFC 9457 error handling
- [config.ts](#configts) — Environment configuration
- [logger.ts](#loggerts) — Structured logging

---

## templates.ts

Template discovery and listing.

### Exports

#### `interface Template`

```typescript
interface Template {
  name: string;  // Display name (e.g., "Minimal", "Standard Package")
  id: string;    // Template ID (filename without .zip)
}
```

#### `async function listTemplates(): Promise<Template[]>`

Scans the templates directory and returns all available templates.

**Returns:** Array of templates sorted by ID (alphabetical).

**Example:**
```typescript
import { listTemplates } from './templates.js';

const templates = await listTemplates();
console.log(templates);
// [
//   { id: 'minimal', name: 'Minimal' },
//   { id: 'standard-package', name: 'Standard Package' }
// ]
```

**Implementation Notes:**
- Looks for `.zip` files in the templates directory
- Converts filename to display name (replaces `-` with space, title case)
- Returns empty array if no templates found
- Throws if templates directory doesn't exist

---

## projects.ts

Project lifecycle management.

### Exports

#### `class TemplateNotFoundError extends Error`

Thrown when a template ID is invalid or doesn't exist.

```typescript
throw new TemplateNotFoundError('unknown-template');
// Error: Template not found: unknown-template
```

#### `class ProjectNotFoundError extends Error`

Thrown when a project ID is invalid or doesn't exist.

```typescript
throw new ProjectNotFoundError('invalid-uuid');
// Error: Project not found: invalid-uuid
```

#### `async function createProject(templateId: string): Promise<string>`

Creates a new project by unzipping a template into a UUID-named directory.

**Parameters:**
- `templateId` — Template ID to use (must match a `.zip` file in templates directory)

**Returns:** UUID of the created project

**Security:**
- Validates templateId against regex `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`
- Checks template ZIP exists before creating directory
- Cleans up directory if extraction fails

**Example:**
```typescript
import { createProject } from './projects.js';

const projectId = await createProject('minimal');
console.log(projectId);
// '550e8400-e29b-41d4-a716-446655440000'
```

**Throws:**
- `TemplateNotFoundError` — If templateId is invalid or template doesn't exist
- `Error` — If directory creation or extraction fails

#### `async function getProjectDir(projectId: string): Promise<string>`

Resolves and validates a project directory path.

**Parameters:**
- `projectId` — Project UUID

**Returns:** Absolute path to project directory

**Security:**
- Validates projectId against UUID regex pattern
- Checks directory exists
- Prevents path traversal attacks

**Example:**
```typescript
import { getProjectDir } from './projects.js';

const dir = await getProjectDir('550e8400-e29b-41d4-a716-446655440000');
console.log(dir);
// '/Users/dev/sf-project-service/projects/550e8400-e29b-41d4-a716-446655440000'
```

**Throws:**
- `ProjectNotFoundError` — If projectId is invalid or project directory doesn't exist

---

## deploy.ts

Metadata deployment to Salesforce orgs.

### Exports

#### `interface OrgCredentials`

```typescript
interface OrgCredentials {
  accessToken: string;   // OAuth access token for Salesforce org
  instanceUrl: string;   // Salesforce instance URL (e.g., https://org.salesforce.com)
}
```

#### `async function deployMetadata(projectDir: string, credentials: OrgCredentials): Promise<DeployResult>`

Deploys project metadata to a Salesforce org.

**Parameters:**
- `projectDir` — Absolute path to project directory
- `credentials` — Salesforce org credentials

**Returns:** Deployment result object with status and components

**Deployment Result Structure:**
```typescript
{
  ok: boolean;
  status: string;  // e.g., "Succeeded", "Failed"
  numberComponentsDeployed: number;
  numberComponentsTotal: number;
  components: Array<{
    fullName: string;
    type: string;
    state: string;  // e.g., "Created", "Updated", "Failed"
  }>;
}
```

**Example:**
```typescript
import { deployMetadata } from './deploy.js';

const result = await deployMetadata('/path/to/project', {
  accessToken: 'YOUR_TOKEN',
  instanceUrl: 'https://org.salesforce.com'
});

console.log(result);
// {
//   ok: true,
//   status: "Succeeded",
//   numberComponentsDeployed: 3,
//   numberComponentsTotal: 3,
//   components: [...]
// }
```

**Implementation Notes:**
- Reads `sfdx-project.json` to extract package directories
- Uses `@salesforce/source-deploy-retrieve` (SDR) for deployment
- Polls deployment status until complete
- Returns full result from SDR, including component details
- Credentials are never stored or logged

**Throws:**
- `Error` — If sfdx-project.json is invalid or deployment fails

---

## files.ts

File tree traversal and building.

### Exports

#### `interface TreeNode`

```typescript
interface TreeNode {
  name: string;
  type: 'file' | 'directory';
  children?: TreeNode[];  // Only present if type is 'directory'
}
```

#### `async function buildTree(name?: string, dir?: string): Promise<TreeNode>`

Recursively builds a file tree structure.

**Parameters:**
- `name` — Display name for root node (defaults to directory name)
- `dir` — Directory path to traverse (defaults to current working directory)

**Returns:** TreeNode representing the directory structure

**Example:**
```typescript
import { buildTree } from './files.js';

const tree = await buildTree(undefined, '/Users/dev/my-project');
console.log(JSON.stringify(tree, null, 2));
// {
//   "name": "my-project",
//   "type": "directory",
//   "children": [
//     { "name": "package.json", "type": "file" },
//     {
//       "name": "src",
//       "type": "directory",
//       "children": [...]
//     }
//   ]
// }
```

**Implementation Notes:**
- Recursively walks directory tree
- Returns files and directories in sorted order
- Includes hidden files (starting with `.`)
- No maximum depth limit (be careful with very large trees)

---

## errors.ts

RFC 9457 Problem Details error handling.

### Exports

#### `const PROBLEM_JSON: string`

Content-Type value for RFC 9457 responses:
```typescript
const PROBLEM_JSON = 'application/problem+json';
```

#### `function problemDetail(status: number, title: string, detail: string): ProblemDetail`

Creates an RFC 9457 Problem Detail object.

**Parameters:**
- `status` — HTTP status code
- `title` — Human-readable error type
- `detail` — Human-readable error description

**Returns:** Problem Detail object

**Example:**
```typescript
import { problemDetail, PROBLEM_JSON } from './errors.js';

res.status(404)
  .contentType(PROBLEM_JSON)
  .json(problemDetail(404, 'Not Found', 'Project not found'));
```

#### `function errorToProblem(err: unknown): ProblemDetail`

Converts any error to an RFC 9457 Problem Detail object.

**Parameters:**
- `err` — Any error object

**Returns:** Problem Detail object

**Behavior:**
- Maps custom errors to appropriate HTTP status codes
- Returns 500 Internal Server Error for unknown errors
- Includes error message in detail field
- Never includes stack traces in response (logged separately)

**Example:**
```typescript
import { errorToProblem, PROBLEM_JSON } from './errors.js';

try {
  await deployMetadata(projectDir, credentials);
} catch (err) {
  const problem = errorToProblem(err);
  res.status(problem.status)
    .contentType(PROBLEM_JSON)
    .json(problem);
}
```

---

## config.ts

Environment configuration and paths.

### Exports

#### `function getProjectPath(): string`

Returns the path to the main SFDX project.

**Returns:** Absolute path from `PROJECT_ROOT` environment variable or current working directory

**Example:**
```typescript
import { getProjectPath } from './config.js';

const projectPath = getProjectPath();
console.log(projectPath);
// '/Users/dev/sf-project-service'
```

#### `function getProjectsRoot(): string`

Returns the root directory for created projects.

**Returns:** Absolute path from `PROJECTS_ROOT` environment variable or `./projects` relative to cwd

**Example:**
```typescript
import { getProjectsRoot } from './config.js';

const projectsRoot = getProjectsRoot();
console.log(projectsRoot);
// '/Users/dev/sf-project-service/projects'
```

#### `function getTemplatesDir(): string`

Returns the directory containing template ZIP files.

**Returns:** Absolute path from `TEMPLATES_DIR` environment variable or `./templates` relative to package root

**Example:**
```typescript
import { getTemplatesDir } from './config.js';

const templatesDir = getTemplatesDir();
console.log(templatesDir);
// '/Users/dev/sf-project-service/templates'
```

**Note:** This path is resolved relative to the package root at runtime (one level up from `dist/`).

---

## logger.ts

Structured logging with Pino.

### Exports

#### `const logger: pino.Logger`

Singleton Pino logger instance.

**Example:**
```typescript
import { logger } from './logger.js';

logger.info({ projectId: 'uuid', templateId: 'minimal' }, 'Project created');
logger.error({ err, stack }, 'Deployment failed');
logger.warn({ status: 409 }, 'Conflict detected');
```

**Configuration:**
- Format: JSON (structured)
- Level: info (default)
- HTTP logging via `pino-http` middleware in Express

---

## Route Modules

### templates.routes.ts

Exports `createTemplatesRouter()` which returns an Express router with:

- `GET /templates` — List templates

### projects.routes.ts

Exports `createProjectsRouter()` which returns an Express router with:

- `POST /projects` — Create project
- `GET /projects/:id/tree` — Get file tree

### deploy.routes.ts

Exports `createDeployRouter()` which returns an Express router with:

- `POST /projects/:id/deploy` — Deploy to Salesforce

All route handlers:
- Validate input
- Call business logic
- Convert errors to RFC 9457 Problem Details
- Use proper HTTP status codes

---

## Integration Points

### Creating a New Route

1. Create new file in `src/routes/` (e.g., `src/routes/custom.routes.ts`)
2. Import and use business logic modules:
   ```typescript
   import { createProject } from '../projects.js';
   import { errorToProblem, PROBLEM_JSON } from '../errors.js';
   ```
3. Create router function that validates and delegates:
   ```typescript
   export function createCustomRouter(): express.Router {
     const router = express.Router();
     router.get('/custom', async (req, res, next) => {
       try {
         // Validate input
         // Call business logic
         res.json(result);
       } catch (err) {
         next(err);
       }
     });
     return router;
   }
   ```
4. Register in `src/routes/index.ts`

### Error Handling Pattern

```typescript
try {
  // Call business logic
  const result = await createProject(templateId);
  res.status(201).json({ id: result });
} catch (err) {
  // Pass to Express error handler
  next(err);
}
```

The global error handler in `app.ts` converts errors to RFC 9457 and sends appropriate responses.
