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
- Fastify REST API wrapping an SFDX project
- `.claude/settings.json` is team-shared (checked into git); `.claude/settings.local.json` is personal (gitignored)

### Directory layout

```
src/                 # production code
├── app.ts           # Fastify app factory, plugin registration
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

### Skills (each works standalone)

- **`/cdd-brief`** — Gathers signals (GitHub issues, transcripts, local git
  state) and helps the human pick work or build context for chosen work.
- **`/cdd-spec`** — Translates intent into executable contracts: a
  `spec/<feature>/contract.spec.ts` (test code, human-guarded) and a
  derived `contract.md` (prose, auto-generated from tests).
- **`/cdd-implement`** — Agent writes production code to make contract tests
  pass. Cannot modify spec files. Auto-discovers specs if no path given.
- **`/cdd-review`** — Blind contract verification and quality audit.

Use them in any order. The typical flow is `/cdd-brief` → `/cdd-spec` → `/cdd-implement`,
but each skill gathers its own context and sets up its own environment.
Not everything needs a spec — bug fixes and chores can go straight to `/cdd-implement`
or skip the workflow entirely.

### Label lifecycle

```
/cdd-brief   → spec:in-progress (+ assign user)
/cdd-spec    → spec:ready-for-review
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
  regenerate. Use `/cdd-spec --refresh <feature>` if needed.
- **To change a contract during implementation:** stop, go back to `/cdd-spec`,
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

Two loops run inside interactive Claude Code sessions using the `/loop`
command. Each runs in its own terminal. Full tool access, skill invocation,
and interactive permissions — no bash wrapper needed.

### Starting the Loops

**Terminal 1 — Implementation Monitor:**
Copy the `/loop` command from `.claude/loops/implement-monitor.md` into a
Claude Code session. Polls every 5 minutes for `spec:approved` PRs.

**Terminal 2 — Review Monitor:**
Copy the `/loop` command from `.claude/loops/review-monitor.md` into a
Claude Code session. Polls every 5 minutes for `impl:ready` PRs.

Stop either with **Ctrl+C**.

### How It Works

1. `/loop 5m <prompt>` runs the prompt every 5 minutes inside the session
2. Each cycle queries `gh pr list` for matching labels
3. When a PR is found, the loop enters the worktree and runs the skill
4. Skills handle label transitions, code changes, and pushing

**Architecture:**
- `.claude/loops/*.md` — Loop documentation with copy-paste `/loop` commands

### Loop 1: Implementation Monitor

Detects `spec:approved` PRs → enters worktree → runs `/cdd-implement` on
the contract spec. See `.claude/loops/implement-monitor.md`.

### Loop 2: Review Monitor

Detects `impl:ready` PRs → enters worktree → runs `/cdd-review` → sends
Slack notification. See `.claude/loops/review-monitor.md`.

## Git Conventions

### Branch naming

All branches follow: `t/{user}/issue-{N}-{slug}`

- `{user}` — git user name (e.g., `ydarar`)
- `{N}` — GitHub issue number
- `{slug}` — kebab-case description (2-4 words)

Example: `t/ydarar/issue-78-fastify-migration`

For work without a GitHub issue: `t/{user}/{type}-{slug}` (e.g., `t/ydarar/chore-cleanup-labels`)

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
{type}({scope}): {description}

{optional body — why, not what}

Closes #42
```

**Types:** `feat`, `fix`, `refactor`, `chore`, `spec`, `test`, `docs`
**Scopes:** `deploy`, `projects`, `templates`, `workflow`, `deps`

Rules:
- One logical change per commit
- Body explains "why", not "what" (the diff shows "what")
- Reference issues with `Closes #N` or `Part of #N` in the body
- No `(#PR)` in messages — GitHub adds that on merge automatically

### PR titles

Same format as commit messages: `{type}({scope}): {short description}`

Under 70 characters. No issue numbers in the title.

### PR descriptions

Use the template in `.github/pull_request_template.md`:
- Summary (1-3 bullets)
- `Closes #N` to auto-close the linked issue
- Test plan checklist

## Gotchas

- Deleting a GitHub Actions workflow file does **not** remove its required status
  check from branch protection. Clean up via: `gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks -X PATCH --input <(echo '{"strict":true,"contexts":[]}')`
