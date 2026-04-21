# CDD Spec Fix Monitor

Poll for `spec:agent-comments` PRs, fix spec issues from review findings, and resubmit for review.

## Start

```
/loop 5m Follow the loop preamble (.claude/skills/cdd-common/loop-preamble.md) for label "spec:agent-comments" with max-retries 3 and review-header "CDD Spec Review". For each ready PR: EnterWorktree at its worktree path. Read all prior "CDD Spec Review" comments on the PR (not just the latest) — the latest is what you act on, the prior ones are context for detecting recurrences. Before fixing, check each finding in the latest review: if the same issue was flagged in any prior review on this PR, stop fixing, post a top-level message to #app-studio-alerts (C0ANF2KL5HT) tagging the PR assignee explaining the recurrence, and move on to the next PR — do not attempt another fix. Otherwise, fix each finding in the latest review. Make one commit per finding addressed, with the commit message format: "spec({scope}): {short description} — addresses finding: {exact finding text, truncated to 80 chars}". Run contract tests to confirm they pass. Sync the PR description. Push. Then transition labels from spec:agent-comments to spec:agent-reviewing on issue and PR.
```

## Labels

```
spec:agent-comments → spec:agent-reviewing (fixed) | stays (max retries → alert | recurrence → alert)
```

## Why this shape

Spec fix cycles have the same risk profile as impl fix cycles: an LLM
patching LLM-generated spec critiques can drift from the human's original
intent. Two guardrails:

1. **Recurrence detection** — a finding resurfacing after a fix attempt
   means the previous patch didn't resolve the underlying concern. A human
   should weigh in rather than the loop patching again.
2. **One commit per finding, referenced by text** — makes each spec change
   auditable against the specific feedback that motivated it.
