# CDD Implementation Monitor Loop

Detects `spec:human-approved` PRs assigned to the local user and runs `/cdd-implement` on each.

## Start

```
/loop 5m Run .claude/skills/cdd-common/scripts/find-my-prs "spec:human-approved" to get a JSON array of matching PRs (filters by current user and label). If the array is empty, do nothing. For each matching PR: extract the issue number from the branch name using .claude/skills/cdd-common/scripts/get-issue-number "$branch", find the matching worktree via git worktree list. If no worktree exists for the branch, create one with git worktree add .claude/worktrees/$SLUG $BRANCH where SLUG is the branch name after the user prefix (e.g. for t/user/issue-42-foo the slug is issue-42-foo). Enter the worktree with EnterWorktree, run npm install if node_modules is missing, find the contract spec with find spec -name contract.spec.ts, then run /cdd-implement on it. The /cdd-implement skill handles all label transitions and code changes.
```

## What happens each cycle

1. Find matching PRs: `.claude/skills/cdd-common/scripts/find-my-prs "spec:human-approved"` (returns JSON array filtered by current user + label)
2. If empty array, do nothing (wait for next cycle)
3. For each PR found:
   - Extract issue number: `.claude/skills/cdd-common/scripts/get-issue-number "$branch"`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - If no worktree found, create one: `git worktree add .claude/worktrees/$slug $branch` (slug is the branch suffix, e.g. `issue-42-foo` from `t/user/issue-42-foo`)
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Find spec: `find spec -name "contract.spec.ts" -type f | head -1`
   - Run `/cdd-implement <path>`
6. `/cdd-implement` handles: `spec:human-approved` → `impl:agent-in-progress` → `impl:agent-reviewing`

## Label transitions

```
spec:human-approved       →  impl:agent-in-progress       (at /cdd-implement start)
impl:agent-in-progress    →  impl:agent-reviewing  (at /cdd-implement end)
```
