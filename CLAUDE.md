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

Humans define _what_ (contracts in `spec/`). Agents implement _how_ (code in
`src/`). Code is a derived artifact; contracts are the durable source of truth.

### Skills (each works standalone)

- **`/cdd-brief`** — Gather context from GitHub, transcripts, local state
- **`/cdd-spec`** — Define executable contracts (`contract.spec.ts` + `contract.md`)
- **`/cdd-spec-review`** — Evaluate spec quality before human approval
- **`/cdd-implement`** — Write code to satisfy contracts. Auto-discovers specs.
- **`/cdd-code-review`** — Blind contract verification and quality audit

If the commit type would be `feat` or the change affects what the API returns,
use CDD. Everything else, just start coding.

### Label lifecycle

```
/cdd-brief or /cdd-spec    → assign user to issue
/cdd-spec                   → spec:agent-reviewing (draft PR)
cdd-spec-review-monitor     → /cdd-spec-review:
                                 SOLID    → spec:agent-approved (PR marked ready)
                                 HAS GAPS → spec:agent-comments
cdd-spec-fix-monitor        → fixes spec → spec:agent-reviewing (re-review)
Human approves              → spec:human-approved
cdd-implement-monitor       → impl:agent-in-progress → impl:agent-reviewing
cdd-code-review-monitor     → /cdd-code-review:
                                 PASS       → impl:agent-approved
                                 NEEDS WORK → impl:agent-comments
cdd-impl-fix-monitor        → fixes code → impl:agent-reviewing (re-review)
Human merges PR
```

Loops are **assignee-scoped** — each local loop only picks up issues/PRs
assigned to the machine's `gh` user. See `.claude/loops/` for setup.

### Guardrails

`spec/` is human-guarded (agents can draft and fix pre-approval, but
nothing ships without human sign-off). `tests/` is agent-mutable.
Test code (`contract.spec.ts`) is source of truth; `contract.md` is always
derived from it. See [docs/workflow-guide.md](docs/workflow-guide.md) for
the full workflow, loop setup, and troubleshooting.

## Directory layout

```
src/       — production code (see src/CLAUDE.md)
spec/      — human-guarded contracts (see spec/CLAUDE.md)
tests/     — agent-mutable tests (see tests/CLAUDE.md)
.claude/   — skills, loops, settings
```

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

**Always assign PRs on creation.** Every `gh pr create` must include
`--assignee @me` (or the equivalent `--assignee "$ME"` after
`ME=$(gh api user -q .login)`). This keeps ownership visible across
all workflows — CDD, docs sync, and ad-hoc.

## Settings

- `.claude/settings.json` — team-shared (checked into git)
- `.claude/settings.local.json` — personal (gitignored)

## Documentation

When modifying documentation, follow the structure defined in
[docs/DOCUMENTATION-ARCHITECTURE.md](docs/DOCUMENTATION-ARCHITECTURE.md).
Run `/docs-standards` to audit compliance.

When modifying CDD skills, loops, or the label lifecycle, also update
[docs/workflow-guide.md](docs/workflow-guide.md) to reflect the changes.
Check for stale references to old labels, removed features, or renamed
monitors before committing.

## Gotchas

- **`gh` CLI `--label` and `--assignee` flags are unreliable.** They silently
  miss results (label color encoding issues, etc.). Always fetch broadly and
  filter client-side with `jq`. This applies to `gh pr list`, `gh issue list`,
  and any loop/skill that queries GitHub. See `.claude/loops/` for the pattern.
- **`gh`'s `--jq` flag does NOT support `jq`'s `--arg`.** The `--jq` flag
  only accepts a single expression string — extra flags like `--arg` are
  parsed as `gh` arguments and cause errors. Always pipe to `jq` separately:
  `gh pr list --json ... | jq --arg ME "$ME" '...'` (not `gh ... --jq --arg`).
- **`gh issue edit` / `gh pr edit` with `--add-label` / `--remove-label`
  silently fails** when the repo has Projects Classic enabled (GraphQL
  deprecation error). Use the REST API instead:
  `gh api "repos/OWNER/REPO/issues/N/labels" -X POST -f "labels[]=name"`
  and `gh api "repos/OWNER/REPO/issues/N/labels/name" -X DELETE`.
- Deleting a GH Actions workflow file does **not** remove its required status
  check. Clean up via: `gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks -X PATCH --input <(echo '{"strict":true,"contexts":[]}')`
