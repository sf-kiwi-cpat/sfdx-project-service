# SF Project Service — Claude Code Notes

## Development

```bash
npm install   # install dependencies (required in new worktrees)
npm test      # run tests (vitest)
npm run test:unit          # unit tests only (3 files)
npm run test:integration   # integration tests only (4 files)
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

## SDLC — Spec-Driven Development (prototype)

This repo is a prototype for an AI-native development process where
executable specs are the source of truth for system behavior.

**The idea:** Humans define *what* the system does (contracts). Agents
implement *how*. The contract boundary is enforced so agents can move
fast without drifting from intent.

### Workflow: `/brief` → `/spec` → `/implement` → `/review` (Automated)

1. **`/brief`** — Gathers signals (GitHub issues, transcripts, local git
   state) and helps the human pick work or build context for chosen work.
2. **`/spec`** — Translates intent into executable contracts: a
   `spec/<feature>/contract.spec.ts` (test code, human-guarded) and a
   derived `contract.md` (prose, auto-generated from tests).
3. **`/implement`** — Agent writes production code to make contract tests
   pass. Cannot modify spec files. Freely creates unit/integration tests.
4. **`/review`** — Automated code review and Slack notification (via Loop 2)

### Label lifecycle

```
/brief       → spec:in-progress (+ assign user)
/spec        → spec:ready-for-review
Human approves → spec:approved
Loop 1       → impl:in-progress → impl:ready
Loop 2       → review:complete (+ Slack notification)
Human merges PR
```

### The rules

- **`spec/` is human-guarded.** These files define the external contract.
  Agents must not modify them. If a spec seems wrong, surface it to the human.
- **`tests/` is agent-mutable.** Unit and integration tests are quality
  tools the implementation agent creates and maintains freely.
- **Test code is source of truth.** Prose specs (`contract.md`) are always
  derived from test code, never the reverse.
- **Never edit `contract.md` directly.** Edit `contract.spec.ts`, then
  regenerate. Use `/spec --refresh <feature>` if needed.
- **To change a contract during implementation:** stop, go back to `/spec`,
  make the change, regenerate both artifacts, get human approval, then resume.

## Worktrees

Git worktrees share source files but **not** `node_modules`. Run `npm install`
in every new worktree before running tests or starting the server.

A `SessionStart` hook in `.claude/settings.json` handles this automatically for
Claude Code sessions — it detects a missing `node_modules` directory and runs
`npm install`.

> **Gotcha:** `WorktreeCreate` hooks _replace_ the default git worktree creation
> (designed for non-git VCS). Do not use them for post-creation setup like
> `npm install` — use `SessionStart` instead.

## Automated Workflow Loops

Two monitor scripts poll GitHub for label changes using plain bash (zero
tokens). Claude is only spawned when there's actual work to do.

### Starting the Loops

**Terminal 1 — Implementation Monitor:**
```bash
./.claude/implement-monitor.sh          # polls every 5 min (default)
./.claude/implement-monitor.sh 60       # polls every 60 seconds
CLAUDE_MODEL=sonnet ./.claude/implement-monitor.sh  # override model
```

**Terminal 2 — Review Monitor:**
```bash
./.claude/review-monitor.sh
```

Stop either with **Ctrl+C**.

### How It Works

1. Bash `while` loop calls `gh pr list` every N seconds — no LLM involved
2. When a matching PR is found, spawns `claude --model $MODEL` with the
   prompt from `.claude/loops/*.md`
3. Claude session runs, does the work, exits
4. Script resumes polling

**Architecture:**
- `.claude/loops/*.md` — Source-of-truth prompts (what Claude sees)
- `.claude/*-monitor.sh` — Thin bash wrappers (polling + spawn)
- Default model: `opus` (override with `CLAUDE_MODEL` env var)

### Loop 1: Implementation Monitor

Detects `spec:approved` PRs → spawns Claude to find the worktree and run
`/implement` on the contract spec. See `.claude/loops/implement-monitor.md`.

### Loop 2: Review Monitor

Detects `impl:ready` PRs → spawns Claude to run `/review`, update labels
to `review:complete`, and send Slack notification. See `.claude/loops/review-monitor.md`.

## Gotchas

- Deleting a GitHub Actions workflow file does **not** remove its required status
  check from branch protection. Clean up via: `gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks -X PATCH --input <(echo '{"strict":true,"contexts":[]}')`
