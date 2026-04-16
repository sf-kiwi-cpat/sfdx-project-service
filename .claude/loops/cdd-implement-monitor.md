# CDD Implementation Monitor

Poll for `spec:human-approved` PRs and run `/cdd-implement` in each PR's worktree.

## Start

```
/loop 5m Follow the loop preamble (.claude/skills/cdd-common/loop-preamble.md) for label "spec:human-approved". For each ready PR: BEFORE entering the worktree, validate the human spec approval checklist by running .claude/skills/cdd-common/scripts/check-spec-approval "$PR_NUMBER". If it exits non-zero, the human applied spec:human-approved without completing the checklist — revert by removing spec:human-approved and re-adding spec:agent-approved (use the label script), post a PR comment via /gh-comment with name "CDD Approval Gate" explaining which checkboxes are unchecked and that the monitor will not implement until they are (include the unchecked items from the script's stderr), then move to the next PR — do not implement. If the checklist passes, EnterWorktree at its worktree path, find the contract spec, then run /cdd-implement.
```

## Labels

```
spec:human-approved → impl:agent-in-progress → impl:agent-reviewing

spec:human-approved (incomplete checklist) → spec:agent-approved (reverted by monitor)
```

## Why the gate

The human approval step is the single point where all downstream quality
guarantees originate. At scale (many specs per week) it collapses into a
rubber stamp unless there's a forcing function. The checklist in the PR
body is that forcing function; this monitor enforces it mechanically so
the approval is real, not ceremonial.

Humans who want to override can still do so: tick every box without
reading, and the gate passes. That's a human problem, not a tooling
problem — but the checkbox act forces at least a moment of attention per
claim, and the claims can be audited after the fact if a spec ships with
bugs.
