# Implementation Monitor Loop

Detects `spec:approved` PRs and runs `/cdd-implement` on each.

## Start

```
/loop 5m Check for open PRs with the spec:approved label using gh pr list --state open --label spec:approved --json number,headRefName. If none found, do nothing. For each PR: extract the issue number from the branch name using sed, find the matching worktree via git worktree list, enter it with EnterWorktree, run npm install if node_modules is missing, find the contract spec with find spec -name contract.spec.ts, then run /cdd-implement on it. The /cdd-implement skill handles all label transitions and code changes.
```

## What happens each cycle

1. Query: `gh pr list --state open --label spec:approved --json number,headRefName`
2. If no results, do nothing (wait for next cycle)
3. For each PR found:
   - Extract issue number: `echo "$branch" | sed 's/.*issue-\([0-9]*\).*/\1/'`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Find spec: `find spec -name "contract.spec.ts" -type f | head -1`
   - Run `/cdd-implement <path>`
4. `/cdd-implement` handles: `spec:approved` → `impl:in-progress` → `impl:ready`

## Label transitions

```
spec:approved  →  impl:in-progress  (at /cdd-implement start)
impl:in-progress  →  impl:ready     (at /cdd-implement end)
```
