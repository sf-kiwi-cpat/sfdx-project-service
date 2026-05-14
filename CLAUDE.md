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
npm run test:deploy:live   # tier-3: deploy every template to a real org
npm run lint  # eslint
npm run lint:deps  # knip — verify dependencies-vs-devDependencies boundaries
npm run dev   # dev server with watch mode
```

## Deploy / template changes — required live-deploy check

**Changes to any of these paths REQUIRE running `npm run test:deploy:live`
before marking the work complete:**

- `src/domain/deploy.ts`
- `src/domain/deploy-auth.ts`
- `src/domain/build.ts`
- `src/routes/deploy.routes.ts`
- `templates/src/**` (any template source)
- New templates added under `templates/src/`

`npm run test:deploy:live` is a tier-3 suite that deploys every built-in
template to a real Salesforce org (using the sf CLI default target-org,
or `SF_TARGET_ORG=<alias>` if set) and verifies the contract end-to-end:
deploy succeeds, UIBundle ships, `appUrl` populates, wall-clock fits
budget. It is the only way to catch regressions that mocks and
structural tests miss (org preference gating, API-version floors,
metadata-API changes). See `tests/live/README.md`.

If the target org isn't authed locally, the suite auto-skips cleanly.
If it's skipped and you can't run it in your environment, **stop and
surface to the user** rather than shipping the change — a green
`npm test` is necessary but not sufficient for deploy/template edits.

## Git Hooks (husky)

- **pre-commit**: lint-staged (prettier + eslint --fix on staged .ts) + unit tests
- **pre-push**: build + `npm run test:quality` (full suite via `vitest run --coverage`); fails the push if the branch-aware coverage threshold in `tests/CLAUDE.md` is not met. CI enforces the same gate via the `coverage` job in `.github/workflows/ci.yml`.

Hooks run automatically after `npm install` (via `prepare` script).
Do not skip hooks with `--no-verify`.

## Dependency hygiene (knip)

CI runs `knip` as a hard gate. Knip findings matter because they catch two failure modes invisible to lint and tests: (1) entries in `dependencies` only used from `tests/` ship dead code to every consumer of the published package, and (2) entries in `devDependencies` used from runtime `src/` work locally but fail in production where dev deps aren't installed. When knip flags an entry, decide: move to `dependencies`, move to `devDependencies`, remove entirely, or — if it's loaded dynamically (e.g. `require.resolve`) — add it to `ignoreDependencies` in `knip.json` with a comment explaining why static analysis can't see it. Run locally with `npm run lint:deps`.

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
/cdd-spec                   → spec:agent-reviewing (draft PR with approval checklist)
cdd-spec-review-monitor     → /cdd-spec-review:
                                 SOLID    → spec:agent-approved (PR stays draft)
                                 HAS GAPS → spec:agent-comments
cdd-spec-fix-monitor        → fixes spec → spec:agent-reviewing (re-review)
Human approves (ticks all   → spec:human-approved
 checklist items, then
 applies label)
cdd-implement-monitor       → checklist gate:
                                 complete   → impl:agent-in-progress → impl:agent-reviewing
                                 incomplete → reverts to spec:agent-approved + PR comment
cdd-code-review-monitor     → /cdd-code-review:
                                 PASS       → impl:agent-approved (PR marked ready)
                                 NEEDS WORK → impl:agent-comments
cdd-impl-fix-monitor        → recurrence check:
                                 new findings → fixes code → impl:agent-reviewing
                                 recurring    → stops, escalates to Slack
CODEOWNERS → app-studio-reviewers notified
Human reviews + merges PR
```

Loops are **assignee-scoped** — each local loop only picks up issues/PRs
assigned to the machine's `gh` user. See `.claude/loops/` for setup.

### Policies

- **Agent review required:** All PRs need an agent code review before
  being marked ready. CDD PRs get this via `/cdd-code-review`. Non-CDD
  PRs use the `system-agents:code-review` agent + `/gh-comment`. A
  `PostToolUse` hook on `git push` reminds if a review is missing.
- **Draft until reviewed:** PRs stay draft until agent code review passes.
  Only `/cdd-code-review` (PASS verdict) calls `gh pr ready`. No other
  skill or loop unmarks draft.
- **Notify on handoff only:** Slack notifications fire when ownership
  transfers from agent to human (the `gh pr ready` moment). Agent-to-agent
  transitions (label changes, fix pushes, re-reviews) are silent.
- **Max retries:** Fix loops stop after 3 review-fix cycles and escalate
  to `#app-studio-alerts`. The PR stays in its current label state.
- **Recurrence escalation:** Fix loops stop before even attempting a fix
  if a current finding was already flagged in any prior review on the
  same PR. A recurring finding means the last fix missed intent; a human
  decides rather than another LLM cycle. Escalates to `#app-studio-alerts`.
- **Human spec approval checklist:** `/cdd-spec` inserts a checklist into
  the PR body. `cdd-implement-monitor` validates all items are ticked
  before running `/cdd-implement`. If the human applies
  `spec:human-approved` without completing the checklist, the monitor
  reverts the label and posts a PR comment. Mechanically enforces that
  the approval step is not a rubber stamp.
- **Blind review independence:** The code-review subagent that derives
  the contract from production code is explicitly forbidden from reading
  spec files, PR bodies, branch names, issue text, commit messages, or
  prior review comments. Any one of those leaks the contract and breaks
  the independence guarantee.
- **Fix commits reference findings:** Fix-loop commits follow the format
  `{type}({scope}): {description} — addresses finding: {finding text}`.
  Re-review verifies each claimed fix actually resolved its referenced
  finding, and flags fix-claim mismatches as Must Fix.

CODEOWNERS (`.github/CODEOWNERS`) auto-requests review from
`app-studio-reviewers` when a PR is marked ready, and the GitHub Slack
app notifies the team.

### Guardrails

`spec/` is human-guarded (agents can draft and fix pre-approval, but
nothing ships without human sign-off). `tests/` is agent-mutable.
Test code (`contract.spec.ts`) is source of truth; `contract.md` is always
derived from it — regenerate the entire file whenever the spec changes,
never hand-edit or partially update it. See
[docs/workflow-guide.md](docs/workflow-guide.md) for the full workflow,
loop setup, and troubleshooting.

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
- **`gh issue create --body` / `gh pr create --body` with markdown
  breaks permission matching.** The `#` characters in markdown headings
  desync the shell quote tracker in Claude Code's permission matcher,
  causing commands to prompt for approval even when allow-listed. This
  affects inline `--body`, heredocs (`cat <<'EOF'`), and variable
  expansion (`--body "$VAR"`) — any form where `#` appears in the
  command string. Use the `Write` tool to create a uniquely-named temp
  file, then pass it with `--body-file`:
  ```bash
  # 1. Use the Write tool to create /tmp/gh-body-<context>.md
  #    (NOT cat/heredoc — those hit the same parser issue)
  # 2. Then:
  gh issue create --title "..." --body-file /tmp/gh-body-<context>.md
  ```
- Deleting a GH Actions workflow file does **not** remove its required status
  check. Clean up via: `gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks -X PATCH --input <(echo '{"strict":true,"contexts":[]}')`
