# Development Guide

Instructions for developing, testing, and deploying SFDX Project Service.

## Setup

### Prerequisites

- Node.js ≥ 20
- npm 10+
- Git

### Installation

```bash
git clone <repo>
cd sfdx-project-service
npm install
```

Git hooks will install automatically via the `prepare` script.

## Development Workflow

### Start Dev Server

```bash
npm run dev
```

Starts the server with file watching (reloads on changes). Listen on `http://localhost:3000`.

### Build TypeScript

```bash
npm run build
```

Compiles `src/` to `dist/`. Required before running with `npm start` or building Docker images.

### Format & Lint

```bash
npm run lint          # Check for linting errors
npm run lint:fix      # Auto-fix linting errors
npm run format        # Format with Prettier
```

**Pre-commit hook** runs `prettier` and `eslint --fix` on staged `.ts` files.

## Testing

### Run All Tests

```bash
npm run test          # Run all tests with coverage (90% threshold)
npm test:coverage     # Explicit coverage report
```

### Run Subsets

```bash
npm run test:unit       # Unit tests only (3 files)
npm run test:integration # Integration tests only (4 files)
npm run test:watch      # Watch mode (re-runs on file change)
```

### Coverage

Coverage reports are generated to `coverage/`. Open `coverage/index.html` in a browser to view detailed reports.

**Coverage thresholds** (enforced):
- Global: 90%
- Per-file on branches: 85%

Must run full test suite (not unit-only) for coverage to work correctly — integration tests provide most coverage.

### Test Files

- **Unit tests** (`src/**/*.test.ts`) — Pure functions, no I/O
  - `logger.test.ts`
  - `config.test.ts`
  - `errors.test.ts`

- **Integration tests** (`src/**/*.integration.test.ts`) — Real filesystem, mocked Salesforce API
  - `files.integration.test.ts`
  - `docs.integration.test.ts`
  - `routes.integration.test.ts`
  - `deploy.test.ts` (includes integration tests)

- **Acceptance tests** (`src/**/*.acceptance.test.ts`) — Full flow simulation
  - `projects.acceptance.test.ts`
  - `deploy.acceptance.test.ts`
  - `templates.acceptance.test.ts`

### Test Framework

Uses **Vitest** (configured in `vitest.config.ts`):

```bash
vitest                  # Interactive watch mode
vitest run              # Single run (used by npm test)
vitest run --coverage   # With coverage
```

## Git Hooks

Hooks are installed via Husky. **Do not skip them** (`--no-verify`).

### Pre-commit

Runs on `git commit`:
1. **lint-staged** — Run Prettier + ESLint on staged `.ts` files
2. **Unit tests** — Ensure unit tests pass

Blocks commit if linting fails or tests fail.

### Pre-push

Runs on `git push`:
1. **Build** — Compile TypeScript (`npm run build`)
2. **All tests** — Run full test suite with coverage
3. **Coverage check** — Ensure 90% threshold met

Blocks push if build fails, tests fail, or coverage is insufficient.

## Docker

### Build Image

```bash
npm run build
docker build -t sfdx-project-service .
```

### Run Container

```bash
docker run -p 3000:3000 sfdx-project-service
```

### Environment Variables in Docker

```bash
docker run \
  -p 3000:3000 \
  -e PORT=3000 \
  -e PROJECTS_ROOT=/data/projects \
  -v /mnt/efs:/data \
  sfdx-project-service
```

### Dockerfile

Located at `Dockerfile`:

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

To build:
```bash
npm run build  # Must build before docker build
docker build -t sfdx-project-service .
```

## Git Worktrees

Worktrees create isolated branches with separate `node_modules`:

```bash
git worktree add .claude/worktrees/feature-name feature-branch
cd .claude/worktrees/feature-name
npm install  # Install dependencies for this worktree
npm test
```

**Important:** Each worktree needs its own `npm install`. The `SessionStart` hook in `.claude/settings.json` handles this automatically for Claude Code sessions.

To clean up:
```bash
cd /path/to/main
git worktree remove .claude/worktrees/feature-name
```

## Project Structure

```
src/
├── index.ts                    # Server entry
├── app.ts                      # Express app
├── config.ts                   # Config (env vars)
├── logger.ts                   # Pino logger
├── errors.ts                   # RFC 9457 error handling
├── templates.ts                # Template operations
├── projects.ts                 # Project CRUD
├── deploy.ts                   # Deployment logic
├── files.ts                    # File tree
├── routes/
│   ├── index.ts               # Route aggregation
│   ├── templates.routes.ts    # GET /templates
│   ├── projects.routes.ts     # POST/GET /projects/*
│   └── deploy.routes.ts       # POST /projects/:id/deploy
├── *.test.ts                  # Unit tests
├── *.integration.test.ts       # Integration tests
└── *.acceptance.test.ts        # Acceptance tests

dist/                           # Compiled JS (generated)
docs/                          # Documentation
templates/                     # Template ZIP files
projects/                      # Created project dirs (generated)
coverage/                      # Test coverage reports (generated)
```

## Configuration

### TypeScript (`tsconfig.json`)

- Strict mode enabled
- ES2020 target
- ESM output
- Module resolution: Node.js

### ESLint (`.eslintrc.js`)

- TypeScript-eslint rules
- Strict type checking
- No `any` unless justified

### Prettier (`.prettierrc`)

- 2-space indentation
- Single quotes
- Trailing commas

## API Documentation

### Swagger UI

Available at `GET /docs` when server is running.

### OpenAPI JSON

Available at `GET /openapi.json`.

Swagger definitions are embedded in route files as JSDoc comments:

```typescript
/**
 * @openapi
 * /templates:
 *   get:
 *     summary: List templates
 *     responses:
 *       '200':
 *         description: List of templates
 */
router.get('/templates', ...)
```

## Debugging

### Enable Debug Logging

```bash
DEBUG=* npm run dev
```

Pino logger will output more verbose logs.

### Use Node Debugger

```bash
node --inspect dist/index.js
```

Open `chrome://inspect` in Chrome to attach debugger.

### VSCode Debug Configuration

Add to `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Launch Program",
      "program": "${workspaceFolder}/dist/index.js",
      "preLaunchTask": "npm: build",
      "outFiles": ["${workspaceFolder}/dist/**/*.js"]
    }
  ]
}
```

## Common Tasks

### Add a New Endpoint

1. Create a new route file in `src/routes/` (e.g., `src/routes/myroute.routes.ts`)
2. Export a function that creates and returns an Express router
3. Add JSDoc `@openapi` comments for Swagger
4. Import and use the router in `src/routes/index.ts`
5. Add tests in `src/myroute.integration.test.ts`
6. Run `npm run lint:fix` to format
7. Run `npm test` to verify coverage

### Add a New Template

1. Create an SFDX project structure in a temporary directory
2. Ensure it includes `sfdx-project.json` with proper `packageDirectories`
3. ZIP the directory: `zip -r templates/mytemplate.zip .`
4. Verify by creating a project: `POST /projects { "template": "mytemplate" }`

### Update Dependencies

```bash
npm outdated         # Check for outdated packages
npm update           # Update to latest versions
npm audit            # Check for vulnerabilities
npm audit fix        # Auto-fix vulnerabilities
```

Always run tests after updating dependencies.

## CI/CD

GitHub Actions workflow runs on every push and PR:

1. Install dependencies
2. Run linting
3. Run tests with coverage
4. Check coverage thresholds (90%)
5. Build Docker image (on main branch)
6. Push image to registry (on main branch)

Workflow file: `.github/workflows/ci.yml`

## Troubleshooting

### Tests fail with "template not found"

Ensure `templates/` directory exists and contains at least one `.zip` file.

### Pre-push hook blocks with coverage error

Run `npm run test:coverage` locally to see full coverage report. Coverage threshold is 90% overall and 85% per file on branches.

### Docker build fails

Ensure TypeScript is compiled first:
```bash
npm run build
docker build -t sfdx-project-service .
```

### Port 3000 already in use

Change port via environment:
```bash
PORT=3001 npm run dev
```

Or kill the process holding port 3000:
```bash
lsof -i :3000
kill -9 <PID>
```

### Node version mismatch

Ensure Node.js ≥ 20:
```bash
node --version
nvm use 20  # If using nvm
```

## Release Process

1. Ensure all tests pass and coverage is sufficient
2. Update version in `package.json`
3. Create a git tag: `git tag v1.0.0`
4. Push tag: `git push origin v1.0.0`
5. GitHub Actions builds and pushes Docker image to registry

See CI/CD workflow for details.
