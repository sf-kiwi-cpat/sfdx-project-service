# CDD Spec Review Monitor

Poll for `spec:agent-reviewing` PRs and run `/cdd-spec-review` in each PR's worktree.

## Start

```
/loop 5m Follow the loop preamble (.claude/skills/cdd-common/loop-preamble.md) for label "spec:agent-reviewing". For each ready PR: EnterWorktree at its worktree path, then run /cdd-spec-review.
```

## Labels

```
spec:agent-reviewing → spec:agent-approved (SOLID) | spec:agent-comments (HAS GAPS)
```
