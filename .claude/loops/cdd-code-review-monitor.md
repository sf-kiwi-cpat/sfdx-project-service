# CDD Code Review Monitor

Poll for `impl:agent-reviewing` PRs and run `/cdd-code-review` in each PR's worktree.

## Start

```
/loop 5m Follow the loop preamble (.claude/skills/cdd-common/loop-preamble.md) for label "impl:agent-reviewing". For each ready PR: EnterWorktree at its worktree path, then run /cdd-code-review.
```

## Labels

```
impl:agent-reviewing → impl:agent-approved (PASS) | impl:agent-comments (NEEDS WORK)
```
