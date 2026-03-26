# CDD Spec Review Monitor Loop

Detects `spec:ready-for-agent-review` PRs assigned to the local user, runs `/cdd-spec-review`, and sends Slack notification.

## Start

```
/loop 5m Run ME=$(gh api user -q '.login') then check for open PRs with the spec:ready-for-agent-review label assigned to $ME using gh pr list --state open --label spec:ready-for-agent-review --assignee "$ME" --json number,headRefName,title. If none found, do nothing. For each PR: extract the issue number from the branch name using sed, find the matching worktree via git worktree list, enter it with EnterWorktree, run npm install if node_modules is missing, then run /cdd-spec-review. The skill posts findings to the PR as a comment. If assessment is SOLID: transition labels to spec:agent-approved, mark the draft PR as ready for review using gh pr ready, post to #app-studio-prs (C0ANF2KL5HT) in the PR's thread with "Spec review passed — ready for human approval" and links. If assessment is HAS GAPS: labels transition to spec:agent-comments, post findings summary in the PR's thread.
```

## What happens each cycle

1. Get current user: `ME=$(gh api user -q '.login')`
2. Query: `gh pr list --state open --label spec:ready-for-agent-review --assignee "$ME" --json number,headRefName,title`
3. If no results, do nothing (wait for next cycle)
4. For each PR found:
   - Extract issue number: `echo "$branch" | sed 's/.*issue-\([0-9]*\).*/\1/'`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Run `/cdd-spec-review`
5. If assessment is SOLID:
   - Transition labels to `spec:agent-approved`
   - Mark draft PR as ready: `gh pr ready $PR_NUMBER`
   - Post to #app-studio-prs in the PR's thread
6. If assessment is HAS GAPS:
   - Labels transition to `spec:agent-comments`
   - Post findings summary in the PR's thread

## Slack threading in #app-studio-prs

Each PR gets its own thread in channel C0ANF2KL5HT:

1. Search channel for existing thread containing "PR #N" or the PR URL
2. If found: reply in that thread (set `thread_ts` to the parent message's timestamp)
3. If not found: post a new top-level message:
   `"PR #N - title\nLink: https://github.com/REPO/pull/N"`
   Then reply in that thread with the spec review status

## Label transitions

```
spec:ready-for-agent-review  →  spec:agent-approved   (if /cdd-spec-review passes)
spec:ready-for-agent-review  →  spec:agent-comments   (if /cdd-spec-review finds gaps)
```
