# CDD Implementation Monitor Loop

Detects `spec:human-approved` PRs assigned to the local user and runs `/cdd-implement` on each.

## Start

```
/loop 5m Run ME=$(gh api user -q '.login') then check for open PRs with the spec:human-approved label assigned to $ME using gh pr list --state open --label spec:human-approved --assignee "$ME" --json number,headRefName. If none found, do nothing. For each PR: extract the issue number from the branch name using sed, find the matching worktree via git worktree list. If no worktree exists for the branch, create one with git worktree add .claude/worktrees/$SLUG $BRANCH where SLUG is the branch name after the user prefix (e.g. for t/user/issue-42-foo the slug is issue-42-foo). Enter the worktree with EnterWorktree, run npm install if node_modules is missing, find the contract spec with find spec -name contract.spec.ts, then run /cdd-implement on it. The /cdd-implement skill handles all label transitions and code changes.
```

## What happens each cycle

1. Get current user: `ME=$(gh api user -q '.login')`
2. Query: `gh pr list --state open --label spec:human-approved --assignee "$ME" --json number,headRefName`
3. If no results, do nothing (wait for next cycle)
4. For each PR found:
   - Extract issue number: `echo "$branch" | sed 's/.*issue-\([0-9]*\).*/\1/'`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - If no worktree found, create one: `git worktree add .claude/worktrees/$slug $branch` (slug is the branch suffix, e.g. `issue-42-foo` from `t/user/issue-42-foo`)
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Find spec: `find spec -name "contract.spec.ts" -type f | head -1`
   - Run `/cdd-implement <path>`
5. `/cdd-implement` handles: `spec:human-approved` → `impl:agent-in-progress` → `impl:agent-reviewing`

## Label transitions

```
spec:human-approved       →  impl:agent-in-progress       (at /cdd-implement start)
impl:agent-in-progress    →  impl:agent-reviewing  (at /cdd-implement end)
```
