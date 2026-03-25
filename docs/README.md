# SF Project Service

A REST API wrapping an SFDX project for remote IDE-like operations. This service enables programmatic creation, management, and deployment of Salesforce projects.

## Quick Start

```bash
npm install
npm run dev          # Start dev server with watch mode (port 3000)
npm run build        # Build TypeScript to dist/
npm test             # Run all tests with coverage
npm run lint         # Lint with ESLint
```

## What Is This?

SF Project Service is a Node.js Express API that provides remote operations on Salesforce SFDX projects:

- **Template-based project creation** — Bootstrap new projects from pre-packaged templates (`.zip` files)
- **File tree traversal** — Explore project file structure and organization
- **Metadata deployment** — Deploy project metadata to Salesforce orgs using SFDX credentials

The service is designed for IDE-like integrations, allowing remote clients to create and manage SFDX projects without local tooling.

## Key Concepts

### Templates
Templates are packaged SFDX projects stored as `.zip` files in the `templates/` directory. When you create a new project, the template is extracted into a UUID-named directory.

### Projects
Each project is stored in its own UUID-named directory under `projects/`. The UUID is returned when the project is created and used as the project identifier for subsequent operations.

### Deployment
Projects are deployed using Salesforce credentials (access token + instance URL). The service uses the `@salesforce/source-deploy-retrieve` library to handle the deployment process.

## Technology Stack

- **Runtime**: Node.js ≥ 20 (ESM)
- **Framework**: Express 4
- **Language**: TypeScript (strict mode)
- **Dependencies**:
  - `@salesforce/core` — Salesforce API
  - `@salesforce/source-deploy-retrieve` — SDR for metadata deployment
  - `pino` — Structured logging
  - `swagger-jsdoc` + `swagger-ui-express` — API documentation
  - `adm-zip` — ZIP file extraction

## API Endpoints

All endpoints return `application/json` or `application/problem+json` (RFC 9457).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/templates` | List available templates |
| POST | `/projects` | Create new project from template |
| GET | `/projects/:id/tree` | Get file tree for a project |
| POST | `/projects/:id/deploy` | Deploy project to Salesforce org |

See [api.md](./api.md) for detailed specifications.

## Environment Variables

```bash
PORT=3000              # HTTP server port (default: 3000)
PROJECT_ROOT=./project # Path to main SFDX project (default: cwd)
PROJECTS_ROOT=./projects # Root directory for created projects (default: ./projects)
TEMPLATES_DIR=./templates # Directory containing template ZIPs (default: ./templates)
```

## Architecture

See [architecture.md](./architecture.md) for detailed system design, data flow, and security model.

## Development

See [development.md](./development.md) for testing, linting, and CI/CD information.

## Testing

```bash
npm run test           # All tests with coverage (90% threshold)
npm run test:unit      # Unit tests only
npm run test:integration # Integration tests only
npm run test:watch     # Watch mode
```

Coverage must run against the full test suite (integration tests provide most coverage).

## Worktrees

This project uses git worktrees. Git worktrees share source but **not** `node_modules`. After creating a new worktree, run `npm install` before testing or starting the server.

## Project Structure

```
.
├── src/                          # Source TypeScript
│   ├── index.ts                  # Server entry point
│   ├── app.ts                    # Express app setup
│   ├── config.ts                 # Configuration (env vars)
│   ├── logger.ts                 # Pino logger setup
│   ├── errors.ts                 # Error handling (RFC 9457)
│   ├── templates.ts              # Template operations
│   ├── projects.ts               # Project CRUD
│   ├── deploy.ts                 # Deployment logic
│   ├── files.ts                  # File tree building
│   └── routes/                   # Express route handlers
│       ├── index.ts              # Route aggregation
│       ├── templates.routes.ts   # GET /templates
│       ├── projects.routes.ts    # POST/GET /projects/*
│       └── deploy.routes.ts      # POST /projects/:id/deploy
├── dist/                         # Compiled JavaScript (generated)
├── templates/                    # Template ZIP files
├── projects/                     # Created project directories (generated)
├── docs/                         # Documentation
├── package.json                  # Dependencies and scripts
├── tsconfig.json                 # TypeScript config
├── vitest.config.ts              # Test configuration
└── .husky/                       # Git hooks (pre-commit, pre-push)
```

## Links

- [API Documentation](./api.md)
- [Architecture](./architecture.md)
- [Development Guide](./development.md)
- [Module Reference](./modules.md)

---

Developed by Salesforce.
