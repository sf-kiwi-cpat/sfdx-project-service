# SFDX Project Service

Fastify REST API wrapping SFDX project operations. AI-native development
using Contract-Driven Development (CDD).

## Commands

```bash
npm install   # install deps (required in new worktrees)
npm test      # run tests (vitest)
npm run test:unit          # unit tests only
npm run test:integration   # integration tests only
npm run test:coverage      # all tests + coverage report
npm run lint  # eslint
npm run dev   # dev server with watch mode
```

## Git Hooks (husky)

- **pre-commit**: lint-staged (prettier + eslint --fix on staged .ts) + unit tests
- **pre-push**: build + all tests with coverage (thresholds in `tests/CLAUDE.md`)

Hooks run automatically after `npm install` (via `prepare` script).
Do not skip hooks with `--no-verify`.

## CDD — Contract-Driven Development

Humans define *what* (contracts in `spec/`). Agents implement *how* (code in
`src/`). Code is a derived artifact; contracts are the durable source of truth.

### Skills (each works standalone)

- **`/cdd-brief`** — Gather context from GitHub, transcripts, local state
- **`/cdd-spec`** — Define executable contracts (`contract.spec.ts` + `contract.md`)
- **`/cdd-spec-review`** — Evaluate spec quality before human approval
- **`/cdd-implement`** — Write code to satisfy contracts. Auto-discovers specs.
- **`/cdd-code-review`** — Blind contract verification and quality audit

Use CDD for `feat` commits and changes to observable behavior (new endpoints,
response shape changes). Skip it for `fix`, `refactor`, `chore`, `docs`, and
`test` work — just start coding.

### Label lifecycle

```
/cdd-brief       → spec:in-progress
/cdd-spec        → spec:ready-for-review
Loop 3           → /cdd-spec-review:
                      SOLID    → stays spec:ready-for-review
                      HAS GAPS → spec:comments (fix → spec:ready-for-review)
Human approves   → spec:approved
Loop 1           → impl:in-progress → impl:ready
Loop 2           → /cdd-code-review:
                      PASS       → review:complete
                      NEEDS WORK → impl:comments (fix → impl:ready)
Human merges PR
```

### The rules

`spec/` is human-guarded (agents cannot modify). `tests/` is agent-mutable.
Test code (`contract.spec.ts`) is source of truth; `contract.md` is always
derived from it.

See [docs/workflow-guide.md](docs/workflow-guide.md) for the full workflow,
loop setup, and troubleshooting. Loop prompts live in `.claude/loops/`.

## Directory layout

```
src/       — production code (see src/CLAUDE.md)
spec/      — human-guarded contracts (see spec/CLAUDE.md)
tests/     — agent-mutable tests (see tests/CLAUDE.md)
.claude/   — skills, loops, settings
```

## Worktrees

Git worktrees share source files but **not** `node_modules`. A `SessionStart`
hook runs `npm install` automatically in new worktrees.

> **Gotcha:** `WorktreeCreate` hooks _replace_ default worktree creation.
> Use `SessionStart` for post-creation setup, not `WorktreeCreate`.

## Git Conventions

### Branches

`t/{user}/issue-{N}-{slug}` (e.g., `t/ydarar/issue-78-fastify-migration`)

Without an issue: `t/{user}/{type}-{slug}`

### Commits

[Conventional Commits](https://www.conventionalcommits.org/):
`{type}({scope}): {description}`

**Types:** `feat`, `fix`, `refactor`, `chore`, `spec`, `test`, `docs`
**Scopes:** `deploy`, `projects`, `templates`, `workflow`, `deps`

One logical change per commit. Body explains "why". Reference issues
with `Closes #N` or `Part of #N`.

### PRs

Title: same as commit format, under 70 chars. Template in `.github/pull_request_template.md`.

## Settings

- `.claude/settings.json` — team-shared (checked into git)
- `.claude/settings.local.json` — personal (gitignored)

## Documentation

When modifying documentation, follow the structure defined in
[docs/DOCUMENTATION-ARCHITECTURE.md](docs/DOCUMENTATION-ARCHITECTURE.md).
Run `/docs-standards` to audit compliance.

## Gotchas

- Deleting a GH Actions workflow file does **not** remove its required status
  check. Clean up via: `gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks -X PATCH --input <(echo '{"strict":true,"contexts":[]}')`
