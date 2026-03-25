# Spec Review Monitor Loop

Detects `spec:ready-for-review` PRs, runs `/cdd-spec-review`, and posts findings to the PR.

## Start

```
/loop 5m Check for open PRs with the spec:ready-for-review label using gh pr list --state open --label spec:ready-for-review --json number,headRefName,title. If none found, do nothing. For each PR: extract the issue number from the branch name using sed, find the matching worktree via git worktree list, enter it with EnterWorktree, run npm install if node_modules is missing, then run /cdd-spec-review. The skill posts findings directly to the PR as a comment.
```

## What happens each cycle

1. Query: `gh pr list --state open --label spec:ready-for-review --json number,headRefName,title`
2. If no results, do nothing (wait for next cycle)
3. For each PR found:
   - Extract issue number: `echo "$branch" | sed 's/.*issue-\([0-9]*\).*/\1/'`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Find spec: `find spec -name "contract.spec.ts" -type f | head -1`
   - Run `/cdd-spec-review`
4. `/cdd-spec-review` posts findings as a PR comment
5. No label transitions — the human decides `spec:approved`

## Label transitions

```
(none — spec review is advisory, does not gate approval)
```
