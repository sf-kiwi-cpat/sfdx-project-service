# SF Project Service

A Fastify REST API wrapping an SFDX project for remote IDE-like
operations. This service enables programmatic creation, management,
and deployment of Salesforce projects.

## Quick Start

```bash
npm install
npm run dev          # start dev server with watch (port 3000)
npm run build        # compile TypeScript + zip templates
npm test             # run all tests
npm run lint         # eslint
```

## What Is This?

SF Project Service exposes:

- **Template-based project creation** — bootstrap new projects from
  pre-packaged templates (zipped at build time from
  `templates/src/<id>/content/`).
- **File reads and tree traversal** — inspect a project's file
  structure (`GET /v1/projects/:id/tree`) or read a single file
  (`GET /v1/projects/:id/file?path=...`).
- **Metadata deployment** — asynchronous deploy to a Salesforce org
  using the zero-auth model (no caller-supplied tokens). Progress
  streams back over Server-Sent Events.
- **Filesystem change events** — per-project SSE stream of file
  changes detected under the project directory.

The service is designed for IDE-like integrations, letting remote
clients create and manage SFDX projects without local tooling.

## Key Concepts

### Templates
Source templates live in `templates/src/<id>/`. The build step
(`scripts/zip-templates.js`) zips each `content/` directory into
`templates/dist/<id>/content.zip` alongside the listing metadata.
Creating a project unzips the `.zip` into a new UUID-named directory
under `PROJECTS_ROOT`.

### Projects
Each project is stored in its own UUID-named directory under
`PROJECTS_ROOT`. A `.project-meta.json` tracks the name,
creation/access times, and any template-supplied `initialMessages`.
Meta writes use atomic write-then-rename to avoid partial-write
corruption.

### Deployment
Deployments are asynchronous and use the **zero-auth** model — the
service resolves an alias to a locally-authed Salesforce username
via the SFDX config; callers never supply access tokens. Progress
and stage/warning events stream back over SSE. Templates can declare
`deployStages` in their `template.json` to run multiple manifest
deploys in sequence.

## Technology Stack

- **Runtime**: Node.js ≥ 20 (ESM, `"type": "module"`)
- **Framework**: Fastify
- **Language**: TypeScript (strict mode)
- **Key dependencies**:
  - `@salesforce/core` — authentication + config aggregator
  - `@salesforce/source-deploy-retrieve` — Metadata API deploys
  - `@fastify/sse` — Server-Sent Events plugin
  - `@fastify/swagger` + `@fastify/swagger-ui` — OpenAPI UI
  - `@sinclair/typebox` — schema-first validation & OpenAPI
  - `chokidar` — filesystem watcher for project change events
  - `pino` — structured logging
  - `adm-zip` — template ZIP extraction

## API Endpoints

All product endpoints live under `/v1` and return
`application/json` or `application/problem+json` (RFC 9457).
Operational endpoints (`/health`, `/openapi.json`, `/docs`) live
outside `/v1`.

| Method | Endpoint                                                       | Description                                     |
| ------ | -------------------------------------------------------------- | ----------------------------------------------- |
| GET    | `/v1/templates`                                                | List available templates                        |
| POST   | `/v1/projects`                                                 | Create a project (from template or blank)       |
| GET    | `/v1/projects`                                                 | List projects                                   |
| GET    | `/v1/projects/:id`                                             | Retrieve a single project                       |
| PATCH  | `/v1/projects/:id`                                             | Rename a project                                |
| GET    | `/v1/projects/:id/file?path=...`                               | Read a file's raw contents                      |
| GET    | `/v1/projects/:id/tree`                                        | Get the file tree                               |
| POST   | `/v1/projects/:id/deployments`                                 | Start an async metadata deployment              |
| GET    | `/v1/projects/:id/deployments/:deploymentId/events`            | SSE stream of deployment progress               |
| GET    | `/v1/projects/:id/fs/events`                                   | SSE stream of filesystem change events          |
| GET    | `/health`                                                      | Liveness probe                                  |
| GET    | `/openapi.json`                                                | OpenAPI 3.0 spec                                |
| GET    | `/docs`                                                        | Swagger UI                                      |

See [api.md](./api.md) for detailed request/response shapes and
error codes, and [api-examples.md](./api-examples.md) for curl
recipes.

## Environment Variables

```bash
PORT=3000                      # HTTP port
PROJECTS_ROOT=./projects       # parent dir for created projects
TEMPLATES_DIR=./templates/dist # built templates directory
ROUTING_PREFIX=                # optional reverse-proxy prefix (Swagger UI)
SF_TARGET_ORG=                 # optional per-shell deploy target alias
```

## Architecture

See [architecture.md](./architecture.md) for system design, request
flows, the zero-auth model, and the SSE event catalog.

## Development

See [development.md](./development.md) for setup, testing, git
hooks, and CI.

## Testing

```bash
npm test                 # full suite
npm run test:unit        # unit tests only
npm run test:integration # integration tests only
npm run test:spec        # CDD contract tests
npm run test:coverage    # full suite + coverage (90% threshold)
npm run test:deploy:live # opt-in live deploy against a real org
```

Integration tests drive most route coverage — run the full suite,
not unit-only, when measuring coverage.

## Worktrees

This project uses git worktrees. Worktrees share source but **not**
`node_modules`. After creating a new worktree, run `npm install`
before testing or starting the server.

## Project Structure

```
.
├── src/
│   ├── index.ts              # entry point (excluded from coverage)
│   ├── app.ts                # Fastify factory
│   ├── config.ts             # env configuration
│   ├── logger.ts             # Pino singleton
│   ├── errors.ts             # RFC 9457 + domain errors
│   ├── deployments.ts        # in-memory deployment store
│   ├── routes/               # Fastify plugin routers
│   │   ├── index.ts
│   │   ├── templates.routes.ts
│   │   ├── projects.routes.ts
│   │   ├── deploy.routes.ts
│   │   └── fs-events.routes.ts
│   └── domain/               # framework-agnostic business logic
│       ├── templates.ts
│       ├── projects.ts
│       ├── deploy.ts
│       ├── deploy-auth.ts
│       ├── auth.ts
│       ├── build.ts
│       ├── files.ts
│       └── watcher.ts
├── spec/                     # executable contracts (human-guarded)
├── tests/
│   ├── unit/
│   ├── integration/
│   └── live/                 # opt-in
├── templates/
│   ├── src/<id>/             # source templates (checked in)
│   └── dist/<id>/             # built output (generated)
├── scripts/zip-templates.js   # template build script
├── dist/                      # compiled TS (generated)
├── docs/                      # documentation
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── vitest.live.config.ts
└── .husky/                    # git hooks (pre-commit, pre-push)
```

## Links

- [API Documentation](./api.md)
- [API Examples](./api-examples.md)
- [Architecture](./architecture.md)
- [Development Guide](./development.md)
- [Module Reference](./modules.md)
- [Workflow Guide](./workflow-guide.md)
- [Documentation Architecture](./DOCUMENTATION-ARCHITECTURE.md)

---

Developed by Salesforce.
