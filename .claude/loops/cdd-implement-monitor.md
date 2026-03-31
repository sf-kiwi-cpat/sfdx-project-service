# CDD Implementation Monitor Loop

Detects `spec:human-approved` PRs assigned to the local user and runs `/cdd-implement` on each.

## Start

```
/loop 5m Run ME=$(gh api user -q '.login') then fetch ALL open PRs using gh pr list --state open --json number,headRefName,title,labels,assignees and pipe the output to jq with --arg ME "$ME" to filter client-side: '[.[] | select((.assignees | map(.login) | index($ME)) and (.labels | map(.name) | index("spec:human-approved")))]'. Do NOT use gh's --jq flag with --arg (gh doesn't support jq's --arg); always pipe to jq separately. Both --assignee and --label flags are unreliable, so we filter everything client-side. If none found after filtering, do nothing. For each matching PR: extract the issue number from the branch name using sed, find the matching worktree via git worktree list. If no worktree exists for the branch, create one with git worktree add .claude/worktrees/$SLUG $BRANCH where SLUG is the branch name after the user prefix (e.g. for t/user/issue-42-foo the slug is issue-42-foo). Enter the worktree with EnterWorktree, run npm install if node_modules is missing, find the contract spec with find spec -name contract.spec.ts, then run /cdd-implement on it. The /cdd-implement skill handles all label transitions and code changes.
```

## What happens each cycle

1. Get current user: `ME=$(gh api user -q '.login')`
2. Query all open PRs: `gh pr list --state open --json number,headRefName,title,labels,assignees`
3. Filter client-side for assignee `$ME` AND `spec:human-approved` label (both `--assignee` and `--label` flags are unreliable)
4. If no results after filtering, do nothing (wait for next cycle)
5. For each PR found:
   - Extract issue number: `echo "$branch" | sed 's/.*issue-\([0-9]*\).*/\1/'`
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
