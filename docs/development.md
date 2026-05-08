# Development Guide

Instructions for developing, testing, and shipping SFDX Project Service.

## Setup

### Prerequisites

- Node.js ≥ 20
- npm 10+
- Git
- Salesforce CLI (`sf`) — required for live deployments; `sf org
  login web --alias <alias>` ahead of time authenticates the zero-
  auth chain used by `POST /v1/projects/:id/deployments`

### Installation

```bash
git clone <repo>
cd sfdx-project-service
npm install
```

Git hooks install automatically via the `prepare` script.

## Development Workflow

### Start dev server

```bash
npm run dev
```

Runs `scripts/zip-templates.js` then `tsx watch src/index.ts`.
Listening on `http://localhost:3000`. The watcher re-runs on
`src/**` changes; edits under `templates/src/` require rerunning
`npm run build:templates` manually (the watcher does not re-zip
templates).

### Build

```bash
npm run build           # tsc + build:templates
npm run build:templates # just re-zip templates (scripts/zip-templates.js)
```

Output goes to `dist/` (compiled TS) and `templates/dist/<id>/`
(zipped template content).

### Run in production mode

```bash
npm start  # node dist/index.js
```

### Format & lint

```bash
npm run lint       # eslint (check only)
npm run lint:fix   # eslint --fix
npm run format     # prettier
```

The pre-commit hook runs `prettier` and `eslint --fix` on staged
`.ts` files and unit tests.

## Testing

### Commands

```bash
npm test               # everything (vitest run)
npm run test:unit      # tests/unit/
npm run test:integration # tests/integration/
npm run test:spec      # spec/ (Contract-Driven Development tests)
npm run test:quality   # alias for tests/ (unit + integration)
npm run test:coverage  # coverage for the full suite
npm run test:watch     # watch mode
npm run test:deploy:live # opt-in, hits a real Salesforce org
```

### Tiers

- **Unit tests** (`tests/unit/`) — pure functions, no I/O.
  Vitest, mocked `@salesforce/core` where needed. Files:
  `auth.test.ts`, `build.test.ts`, `config.test.ts`,
  `deploy.test.ts`, `deployments.test.ts`, `errors.test.ts`,
  `logger.test.ts`, `projects.test.ts`, `templates.test.ts`,
  `watcher.test.ts`.
- **Integration tests** (`tests/integration/`) — Fastify app
  instance, real filesystem, mocked Salesforce API.
  Files: `deploy.routes.test.ts`, `docs.test.ts`,
  `files.test.ts`, `fs-events.routes.test.ts`, `routes.test.ts`,
  `templates.deployable.test.ts` (tier-1 deployability check:
  every template runs through the full build+ComponentSet
  pipeline to catch manifest/shape regressions).
- **Spec tests** (`spec/**/*.spec.ts`) — Contract-Driven
  Development executable contracts. Each feature directory
  (`spec/deploy/`, `spec/projects/`, etc.) contains
  `contract.spec.ts` (source of truth) and `contract.md` (derived
  prose). See `spec/CLAUDE.md` for the conventions and
  [workflow-guide.md](./workflow-guide.md) for how CDD works.
- **Live deploy tests** (`tests/live/templates.deploy.live.test.ts`,
  `npm run test:deploy:live`) — opt-in. Deploys every template
  against a real Salesforce org. Requires a pre-authed alias. Uses
  `vitest.live.config.ts` (separate config so the default suite
  stays hermetic).

### Coverage

Thresholds enforced in CI and in the pre-push hook:
- 90% overall
- 85% per file on branches

Coverage **must** be measured against the full suite. Unit-only
coverage is misleading because integration tests drive most of the
route + SSE code paths.

Reports land in `coverage/`. Open `coverage/index.html` for line-
level detail.

### When you must run `test:deploy:live`

Changes under `src/domain/deploy*.ts`, `src/domain/build.ts`, or
`templates/src/**` need a live run before merge — they touch the
production deploy pipeline where mocks can mask real-world failures.
See `CLAUDE.md` for the full guardrail.

## Git Hooks

Installed via Husky. **Do not** skip with `--no-verify`.

### Pre-commit

1. `lint-staged` — prettier + eslint on staged `.ts` files
2. `vitest run tests/unit` — unit tests must pass

### Pre-push

1. `npm run build`
2. `npm run test:coverage` — full suite + coverage thresholds

## Git Worktrees

Worktrees share the working tree but **not** `node_modules`:

```bash
git worktree add .claude/worktrees/feature-name feature-branch
cd .claude/worktrees/feature-name
npm install
npm test
```

Removal:

```bash
git worktree remove .claude/worktrees/feature-name
```

Claude Code sessions auto-run `npm install` via the `SessionStart`
hook in `.claude/settings.json`. If deps seem missing, the hook may
have been skipped — run `npm install` manually.

## Project Structure

```
src/
├── index.ts            # entry point
├── app.ts              # Fastify factory
├── config.ts           # env configuration
├── logger.ts           # Pino singleton
├── errors.ts           # RFC 9457 + domain errors
├── deployments.ts      # in-memory deployment store
├── routes/             # Fastify plugin routers
│   ├── index.ts
│   ├── templates.routes.ts
│   ├── projects.routes.ts
│   ├── deploy.routes.ts
│   └── fs-events.routes.ts
└── domain/             # framework-agnostic business logic
    ├── templates.ts
    ├── projects.ts
    ├── deploy.ts
    ├── deploy-auth.ts
    ├── auth.ts
    ├── build.ts
    ├── files.ts
    └── watcher.ts

spec/                   # executable contracts (human-guarded)
tests/
├── unit/
├── integration/
└── live/               # opt-in (npm run test:deploy:live)

templates/
├── src/<id>/           # source templates (checked in)
│   ├── template.json   # listing metadata
│   └── content/        # files shipped into each new project
└── dist/<id>/          # built by scripts/zip-templates.js

scripts/
└── zip-templates.js    # builds templates/dist/ from templates/src/

dist/                   # compiled TS (generated)
coverage/               # test coverage (generated)
docs/                   # documentation
```

## Configuration Files

- `tsconfig.json` — strict mode, ESNext module, ESM output
- `vitest.config.ts` — default test config
- `vitest.live.config.ts` — live-deploy test config
- `eslint.config.js` — typescript-eslint, strict rules
- `.prettierrc` — 2-space indent, single quotes, trailing commas
- `.husky/` — pre-commit and pre-push hooks
- `.sync-docs.json` — inputs to the `/sync-docs` skill
- `.claude/` — team-shared settings, skills, loops

## API Documentation

- **Swagger UI** at `GET /docs` (served by `@fastify/swagger-ui`)
- **OpenAPI JSON** at `GET /openapi.json`

OpenAPI is generated from the Typebox schemas declared inline on
each Fastify route (not from JSDoc). Route-level `schema.body`,
`schema.params`, `schema.querystring`, and `schema.response` drive
both runtime validation and the published spec.

`ROUTING_PREFIX` (env) populates the OpenAPI `servers` array so the
"Try it out" button in Swagger UI routes through reverse proxies
correctly.

## Debugging

### Verbose logs

```bash
LOG_LEVEL=debug npm run dev
```

### Node inspector

```bash
node --inspect-brk dist/index.js
```

Attach via `chrome://inspect` or a VS Code launch configuration.

## Common Tasks

### Add a new endpoint

1. Create a Fastify plugin under `src/routes/foo.routes.ts`.
2. Keep business logic in `src/domain/`. Routes should stay thin.
3. Declare Typebox schemas with `additionalProperties: false` on the
   body and reject unknown fields with 400.
4. Register the plugin in `src/routes/index.ts`.
5. Add an integration test under `tests/integration/`.
6. If the endpoint changes observable behavior, write an executable
   contract in `spec/<feature>/contract.spec.ts` first — see the
   workflow guide.

### Add a new template

1. Create `templates/src/<id>/` with:
   - `template.json` — `{ id, name, description, categories }`
   - `content/` — full SFDX project layout (includes its own
     `sfdx-project.json`; optionally `template.json` with
     `deployStages` for multi-stage deploy, and `initialMessages`
     to seed a new project's chat history).
2. `npm run build:templates` — zips content and copies metadata
   into `templates/dist/<id>/`.
3. Verify: `curl -X POST http://localhost:3000/v1/projects -d
   '{"template":"<id>"}'`.
4. Add tier-1 deployability coverage in
   `tests/integration/templates.deployable.test.ts`.
5. For React/UIBundle-bearing templates, also verify via
   `npm run test:deploy:live`.

### Update dependencies

```bash
npm outdated
npm update
npm audit
npm audit fix
npm test
```

## CI/CD

GitHub Actions run on every push and PR:

1. Install deps
2. Lint
3. Build
4. Full test suite + coverage
5. Enforce 90% / 85% thresholds

The workflow file is `.github/workflows/ci.yml`.

Dependabot opens PRs for npm bumps; the CDD loops do not
auto-review them — humans handle routine bumps.

## Troubleshooting

### Tests fail with "template not found"

`templates/dist/` hasn't been built. Run `npm run build:templates`
or any script that depends on `pretest`.

### Pre-push hook fails coverage

Run `npm run test:coverage` locally to see per-file output. The
threshold is 90% overall and 85% per file on branches.

### Port 3000 in use

```bash
PORT=3001 npm run dev
# or
lsof -i :3000 && kill -9 <PID>
```

### Deploy fails with `UIBundle Metadata API is not enabled`

The target org is missing **Agentforce Vibe for Multi-Framework
(Beta)**. Enable it in Setup → Apps → "React Development with
Agentforce Vibes and Salesforce Multi-Framework (Beta)".

### `orgAlias '...' does not resolve to a Salesforce username`

You haven't logged into that alias on this host. Run
`sf org login web --alias <alias>` and retry. See `docs/api.md`'s
Zero-auth resolution section for the full precedence chain.

### Node version mismatch

```bash
node --version   # must be ≥ 20
nvm use 20       # or install a 20.x line
```
