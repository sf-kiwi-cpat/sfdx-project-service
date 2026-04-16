# CDD Implementation Fix Monitor

Poll for `impl:agent-comments` PRs, fix code issues from review findings, and resubmit for review.

## Start

```
/loop 5m Follow the loop preamble (.claude/skills/cdd-common/loop-preamble.md) for label "impl:agent-comments" with max-retries 3 and review-header "CDD Code Review". For each ready PR: EnterWorktree at its worktree path. Read all prior "CDD Code Review" comments on the PR (not just the latest) — the latest is what you act on, the prior ones are context for detecting recurrences. Before fixing, check each finding in the latest review: if the same issue was flagged in any prior review on this PR, stop fixing, post a top-level message to #app-studio-alerts (C0ANF2KL5HT) tagging the PR assignee explaining the recurrence, and move on to the next PR — do not attempt another fix. Otherwise, fix each finding in the latest review. Make one commit per finding addressed, with the commit message format: "fix({scope}): {short description} — addresses finding: {exact finding text, truncated to 80 chars}". Run npm test to confirm all tests pass. Sync the PR description. Push. Then transition labels from impl:agent-comments to impl:agent-reviewing on issue and PR.
```

## Labels

```
impl:agent-comments → impl:agent-reviewing (fixed) | stays (max retries → alert | recurrence → alert)
```

## Why this shape

The fix loop is the most dangerous part of the pipeline: three cycles of
LLM-generated patches against LLM-generated findings can erode working code
if the fix addresses symptoms rather than intent. Two guardrails:

1. **Recurrence detection** — if a finding reappears after a prior fix
   attempt, the fix clearly missed intent. Escalating to a human is cheaper
   than another cycle and preserves cleaner state for their review.
2. **One commit per finding, referenced by text** — makes it auditable which
   commit addressed which finding, so a human can unwind a specific
   regression without reverting the whole fix batch. Also forces the fix
   agent to scope each change narrowly instead of drifting into adjacent
   cleanup.
