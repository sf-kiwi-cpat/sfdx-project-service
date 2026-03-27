# CDD Code Review Monitor Loop

Detects `impl:agent-reviewing` PRs assigned to the local user, runs `/cdd-code-review`, and sends Slack notification.

## Start

```
/loop 5m Run ME=$(gh api user -q '.login') then check for open PRs with the impl:agent-reviewing label assigned to $ME using gh pr list --state open --label impl:agent-reviewing --assignee "$ME" --json number,headRefName,title. If none found, do nothing. For each PR: extract the issue number from the branch name using sed, find the matching worktree via git worktree list. If no worktree exists for the branch, create one with git worktree add .claude/worktrees/$SLUG $BRANCH where SLUG is the branch name after the user prefix (e.g. for t/user/issue-42-foo the slug is issue-42-foo). Enter the worktree with EnterWorktree, run npm install if node_modules is missing, then run /cdd-code-review. If review verdict is PASS: labels transition to impl:agent-approved, post to #app-studio-alerts (C0ANF2KL5HT) in the PR's thread with "PR ready for merge" and links. If verdict is NEEDS WORK: labels transition to impl:agent-comments, post review findings in the PR's thread.
```

## What happens each cycle

1. Get current user: `ME=$(gh api user -q '.login')`
2. Query: `gh pr list --state open --label impl:agent-reviewing --assignee "$ME" --json number,headRefName,title`
3. If no results, do nothing (wait for next cycle)
4. For each PR found:
   - Extract issue number: `echo "$branch" | sed 's/.*issue-\([0-9]*\).*/\1/'`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - If no worktree found, create one: `git worktree add .claude/worktrees/$slug $branch` (slug is the branch suffix, e.g. `issue-42-foo` from `t/user/issue-42-foo`)
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Run `/cdd-code-review`
5. If verdict is PASS:
   - Labels transition to `impl:agent-approved`
   - Post to #app-studio-alerts in the PR's thread
6. If verdict is NEEDS WORK:
   - Labels transition to `impl:agent-comments`
   - Post review findings in the PR's thread

## Slack threading in #app-studio-alerts

Each PR gets its own thread in channel C0ANF2KL5HT:

1. Search channel for existing thread containing "PR #N" or the PR URL
2. If found: reply in that thread (set `thread_ts` to the parent message's timestamp)
3. If not found: post a new top-level message:
   `"PR #N - title\nLink: https://github.com/REPO/pull/N"`
   Then reply in that thread with the review status

## Label transitions

```
impl:agent-reviewing  →  impl:agent-approved   (after /cdd-code-review passes)
impl:agent-reviewing  →  impl:agent-comments   (after /cdd-code-review finds issues)
```
