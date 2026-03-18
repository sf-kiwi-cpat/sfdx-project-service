# SF Project Service — Claude Code Notes

## Development

```bash
npm install   # install dependencies (required in new worktrees)
npm test      # run all tests (spec + unit + integration)
npm run test:spec          # spec tests only (human-guarded contracts)
npm run test:unit          # unit tests only
npm run test:integration   # integration tests only
npm run test:coverage      # all tests + coverage report
npm run lint  # lint with eslint
npm run dev   # start dev server with watch mode
```

## Git Hooks (husky)

Hooks run automatically after `npm install` (via `prepare` script).

- **pre-commit**: lint-staged (prettier + eslint --fix on staged .ts) + unit tests
- **pre-push**: build + all tests with coverage (90% threshold; 85% for branches)

Do not skip hooks with `--no-verify`. Only autonomous agents use this repo,
so the friction is intentional.

Coverage thresholds are in `vitest.config.ts`. Coverage must run against
the full test suite (not unit-only) — integration tests provide most coverage.

## Docker

```bash
npm run build && docker build -t sf-project-service .   # build image (needs dist/ and node_modules/ on host)
docker run -p 3000:3000 sf-project-service               # run container
```

## Architecture

- ESM project (`"type": "module"`), Node.js >= 20, TypeScript strict mode
- Express REST API wrapping an SFDX project
- `.claude/settings.json` is team-shared (checked into git); `.claude/settings.local.json` is personal (gitignored)

### Directory layout

```
src/                 # production code
├── app.ts           # Express app factory, middleware
├── config.ts        # env-backed configuration
├── errors.ts        # error classes, RFC 9457 problem detail
├── logger.ts        # pino logger
├── index.ts         # entry point (excluded from coverage)
├── routes/          # HTTP layer (request/response handling)
└── domain/          # business logic (framework-agnostic)

spec/                # human-guarded contract tests (source of truth)
tests/unit/          # agent-mutable unit tests (quality tools)
tests/integration/   # agent-mutable integration tests (quality tools)
```

## SDLC 2026 — Spec-Driven Development

This project follows the SDLC 2026 process model where spec tests are the
source of truth for system behavior.

### The rules

1. **`spec/` files are human-guarded.** They define the external contract.
   A `PreToolUse` hook in `.claude/settings.json` blocks agent writes to
   `spec/*.spec.ts`. Use `/spec` to create or modify them.

2. **`tests/` files are agent-mutable.** Unit and integration tests are
   quality tools. The implementation agent creates and modifies them freely.

3. **Implementation agents must not modify spec tests.** If a spec test
   seems wrong, stop and surface it to the human. Do not work around it.

4. **The workflow is:** `/brief` → `/spec` → `/implement`
   - `/brief` gathers context (GitHub issues, transcripts, local state)
   - `/spec` translates intent into spec tests (human reviews and commits)
   - `/implement` writes code to make spec tests pass (cannot touch spec/)

## Worktrees

Git worktrees share source files but **not** `node_modules`. Run `npm install`
in every new worktree before running tests or starting the server.

A `SessionStart` hook in `.claude/settings.json` handles this automatically for
Claude Code sessions — it detects a missing `node_modules` directory and runs
`npm install`.

> **Gotcha:** `WorktreeCreate` hooks _replace_ the default git worktree creation
> (designed for non-git VCS). Do not use them for post-creation setup like
> `npm install` — use `SessionStart` instead.

## Development Workflow: Brief → Contract → Implement

This project uses a three-phase workflow for defining and implementing features:

```
/brief [intent]           # Gather context from GitHub, local state, transcripts
  ↓
User picks work
  ↓
/contract [intent]        # AI drafts contract.spec.ts + auto-derives contract.spec.md
  ↓
Human reviews both artifacts
  ↓
Human approves & commits
  ↓
/implement [contract]     # AI writes code to make contract tests pass
```

### Phase 1: Brief

```bash
/brief                    # Landscape mode: show available work
/brief #68                # Context mode: detailed context for issue #68
/brief add SSE streaming  # Context mode: detailed context for description
```

Outputs landscape or focused context. Offers next step: `/contract`

### Phase 2: Contract

AI drafts both simultaneously:
- `spec/<feature>/contract.spec.ts` — executable tests (source of truth)
- `spec/<feature>/contract.spec.md` — auto-derived prose (read-only)

Human reviews both in parallel, edits contract.spec.ts if needed, then approves.
Never edit contract.spec.md — regenerate it from contract.spec.ts.

```bash
/contract #68                    # Draft from issue
/contract add SSE streaming      # Draft from description
/contract --refresh deploy       # Regenerate prose from tests
```

### Phase 3: Implement

AI writes production code to make contract tests pass:
- Cannot modify `spec/**/*.spec.ts` (human-guarded)
- Cannot modify `spec/**/*.spec.md` (human-guarded)
- Can create/edit production code and unit/integration tests
- All contract tests must pass, coverage threshold must be met

```bash
/implement spec/deploy/contract.spec.ts
```

### Key Rules

1. `spec/` files are human-guarded — define the external contract
2. `tests/` files are agent-mutable — quality tools
3. Contract tests must always pass — implementation is constrained by contract
4. Prose spec is derived from code — never hand-edit `.spec.md` files
5. If a spec test seems wrong, surface it to human instead of working around it

## Gotchas

- Deleting a GitHub Actions workflow file does **not** remove its required status
  check from branch protection. Clean up via: `gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks -X PATCH --input <(echo '{"strict":true,"contexts":[]}')`
