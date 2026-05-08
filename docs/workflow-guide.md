# Workflow Guide

This repo uses a contract-driven development process. You write specs that
describe what the system should do, and agents write the code that makes those
specs pass. Automation handles the handoffs between steps.

You don't have to use this workflow for everything. It's meant for new
features and changes to observable behavior where you want a spec to exist
before code gets written.

| Work type | Use CDD? | Why |
|-----------|----------|-----|
| New endpoint or feature | Yes | New observable behavior needs a contract |
| Changing existing behavior | Yes | Contract should update before code does |
| Bug fix with clear repro | No | Just fix it, add a regression test |
| Refactor (no behavior change) | No | Existing specs already cover it |
| Docs, chores, dependency bumps | No | No observable behavior to contract |
| Test improvements | No | Tests are agent-mutable, no spec needed |

When in doubt: if the commit type would be `feat` or the change affects
what the API returns, use CDD. Everything else, just start coding.

## How it works

There are five skills. Each one is a Claude command you can run directly.

`/cdd-brief` looks at open GitHub issues, your current branch, and recent
activity, then shows you what's available to work on. It can also deep-dive
into a specific issue if you give it one (`/cdd-brief #42`). At the end it
offers to create a worktree and hand off to `/cdd-spec`.

`/cdd-spec` takes your intent and turns it into two files: a
`contract.spec.ts` (executable test code, the actual source of truth) and a
`contract.md` (prose description, auto-generated from the tests). You review
both, edit the test code if needed, and approve when it looks right. The spec
gets pushed and labeled `spec:agent-reviewing`. The PR body includes a
**human spec approval checklist** — downstream automation requires every box
to be ticked before implementation begins.

`/cdd-spec-review` reads the spec and any existing implementation, then
evaluates whether the spec is clear, complete, and testable. It critiques
test-intent alignment, coverage gaps, mock boundaries, and testability.
Posts findings as a PR comment. If there are gaps, the label moves to
`spec:agent-comments` so the fix monitor can address them.

`/cdd-implement` reads the contract spec and writes production code to make
the tests pass. It also creates unit and integration tests, checks coverage
thresholds, and pushes the result. It cannot modify spec files. If a spec
seems wrong, it flags it rather than working around it. Labels move to
`impl:agent-reviewing` when done.

`/cdd-code-review` reviews the implementation using blind contract derivation
(a separate agent reads only the production code and tries to derive what the
contract should be, then compares against the actual spec). The blind agent
is explicitly forbidden from reading the spec, the PR body, the branch name,
the issue text, commit messages, and prior review comments — any of those
would leak the contract and break the independence guarantee. Also checks for
code quality issues. Posts findings as a PR comment with a footer recording
the reviewed SHA. If the verdict is PASS, labels move to `impl:agent-approved`.
If NEEDS WORK, labels move to `impl:agent-comments`.

On re-reviews (when prior "CDD Code Review" comments exist on the PR), the
skill also runs a fix-cycle verification pass: it matches fix commits to the
prior review's findings (via the `— addresses finding: {text}` suffix) and
checks that each claimed fix actually resolved its referenced finding.
Fix-claim mismatches and silently-dropped findings are flagged as Must Fix.

## What you do vs. what agents do

You pick work, write and approve specs, and merge PRs. Agents write code,
run tests, and review implementations. You never need to write production
code, but you can.

The boundary is `spec/`. You own it. Agents can draft and fix specs before
your approval, but nothing ships without your sign-off. Everything in
`src/` and `tests/` is fair game for agents.

## Labels

Labels on GitHub issues and PRs drive the automation. Each label follows
a `{phase}:{actor}-{state}` pattern. Transitions happen when a skill or
monitor completes its work.

```
/cdd-spec              sets   spec:agent-reviewing
/cdd-spec-review       sets   spec:agent-approved      (if solid)
                         or   spec:agent-comments      (if gaps found)
cdd-spec-fix-monitor   sets   spec:agent-reviewing  (after fixing)
You approve            sets   spec:human-approved
                              (checklist in PR body must be fully ticked)
cdd-implement-monitor  validates checklist:
                         pass → runs /cdd-implement
                         fail → reverts to spec:agent-approved + PR comment
/cdd-implement         sets   impl:agent-in-progress, then impl:agent-reviewing
/cdd-code-review       sets   impl:agent-approved      (if passing)
                         or   impl:agent-comments      (if needs work)
cdd-impl-fix-monitor   checks for recurring findings:
                         recurrence → escalates to #app-studio-alerts, no fix
                         new        → sets impl:agent-reviewing (after fixing)
You merge the PR
```

The feedback labels (`spec:agent-comments` and `impl:agent-comments`) trigger
fix monitors that automatically address findings and re-submit for review.
Fix commits follow the format `... — addresses finding: {text}` so re-review
can mechanically verify that each fix actually resolved the finding it
referenced.

You can also fix things manually — push your changes and move the label back
to `spec:agent-reviewing` or `impl:agent-reviewing`.

You can always override. If a spec review says HAS GAPS but you disagree,
set `spec:human-approved` directly (but the checklist gate still applies).

### The human approval checklist

When `/cdd-spec` creates the draft PR, the body includes a section:

```
## Human spec approval (required before applying spec:human-approved)
- [ ] I read each `it()` assertion in contract.spec.ts, not just the names
- [ ] The error cases cover the failure modes I want to handle in production
- [ ] The mock boundary matches reality (not mocking away bugs)
- [ ] No aspirational fields in contract.md that aren't tested
- [ ] I traced through at least one request/response end-to-end mentally
```

Before applying `spec:human-approved`, tick every box. If you apply the
label with any box unchecked, `cdd-implement-monitor` reverts the label
and posts a comment listing the unchecked items. This is the one
mechanical forcing function that keeps spec approval from becoming a
rubber stamp as volume grows. You can still pencil-whip the boxes, but
ticking them is at least one moment of attention per claim.

## Monitor loops

Five loops run in the background and trigger skills automatically when
labels change. Each one is a `/loop` command you paste into a Claude Code
terminal. The prompt lives in a markdown file under `.claude/loops/`.

All loops are **assignee-scoped** — they only pick up issues/PRs assigned
to the local machine's `gh` user, preventing duplicate work across
contributors.

Open five terminals and paste one command into each:

**cdd-spec-review-monitor** polls for `spec:agent-reviewing` and runs
`/cdd-spec-review`. Copy the command from
`.claude/loops/cdd-spec-review-monitor.md`.

**cdd-spec-fix-monitor** polls for `spec:agent-comments`, reads review
findings, fixes the spec, and relabels for re-review. Copy the command from
`.claude/loops/cdd-spec-fix-monitor.md`.

**cdd-implement-monitor** polls for `spec:human-approved` and runs
`/cdd-implement`. Copy the command from
`.claude/loops/cdd-implement-monitor.md`.

**cdd-code-review-monitor** polls for `impl:agent-reviewing` and runs
`/cdd-code-review`. Copy the command from
`.claude/loops/cdd-code-review-monitor.md`.

**cdd-impl-fix-monitor** polls for `impl:agent-comments`, reads review
findings, fixes the code, and relabels for re-review. Copy the command from
`.claude/loops/cdd-impl-fix-monitor.md`.

Each loop polls every 5 minutes using `gh pr list`. No LLM tokens are spent
on polling. Claude is only invoked when there's actual work to do. Review
and fix loops post results to the `#app-studio-alerts` Slack channel.

You can stop any loop with Ctrl+C.

## Walkthrough: a feature from start to finish

1. Run `/cdd-brief` or `/cdd-brief #42`. Pick work and create a worktree.
2. Run `/cdd-spec`. Review the generated contract, edit if needed, approve.
3. The spec gets pushed. If loops are running, `cdd-spec-review-monitor`
   reviews the spec. Any gaps get auto-fixed by `cdd-spec-fix-monitor`.
4. Set `spec:human-approved`. `cdd-implement-monitor` picks it up and runs
   `/cdd-implement`.
5. Implementation gets pushed. `cdd-code-review-monitor` runs
   `/cdd-code-review`. Any issues get auto-fixed by `cdd-impl-fix-monitor`.
6. You get a Slack notification. Review the PR and merge.

Steps 3 through 6 happen automatically if the loops are running. You just
wait for the Slack ping.

## Rules

Guardrails are defined in `CLAUDE.md` and enforced every agent session.
Two things worth expanding on here:

Never edit `contract.md` directly. It's derived from `contract.spec.ts`.
If you need to update it, edit the test code and re-run `/cdd-spec` on
the feature to regenerate it.

To change a contract during implementation: stop, go back to `/cdd-spec`,
make the change, get it approved, then resume. Don't hack around a spec
that feels wrong.

## Troubleshooting

**Loop isn't picking up PRs.** Check `gh auth status`. Verify the PR has
the right label and is assigned to your `gh` user. Make sure the loop
terminal is still running.

**Need to re-run implementation.** Remove `impl:agent-in-progress` or
`impl:agent-reviewing` from the PR, re-add `spec:human-approved`.
`cdd-implement-monitor` picks it up next cycle.

**Need to re-run a review after fixes.** Move the label from
`spec:agent-comments` back to `spec:agent-reviewing`, or from
`impl:agent-comments` back to `impl:agent-reviewing`.

**Worktree problems.** Git worktrees share source files but not
`node_modules`. The `SessionStart` hook runs `npm install` automatically
for Claude Code sessions. If deps are missing, the hook may not have
fired — run `npm install` manually.
