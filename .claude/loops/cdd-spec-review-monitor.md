# CDD Spec Review Monitor Loop

Detects `spec:agent-reviewing` PRs assigned to the local user, runs `/cdd-spec-review`, and sends Slack notification.

## Start

```
/loop 5m Run .claude/skills/cdd-common/scripts/find-my-prs "spec:agent-reviewing" to get a JSON array of matching PRs (filters by current user and label). If the array is empty, do nothing. For each matching PR: extract the issue number from the branch name using .claude/skills/cdd-common/scripts/get-issue-number "$branch", find the matching worktree via git worktree list. If no worktree exists for the branch, create one with git worktree add .claude/worktrees/$SLUG $BRANCH where SLUG is the branch name after the user prefix (e.g. for t/user/issue-42-foo the slug is issue-42-foo). Enter the worktree with EnterWorktree, run npm install if node_modules is missing, then run /cdd-spec-review. The skill posts findings to the PR as a comment. If assessment is SOLID: transition labels to spec:agent-approved, mark the draft PR as ready for review using gh pr ready, post verdict and label transition to the PR's Slack thread via /slack-notify. If assessment is HAS GAPS: labels transition to spec:agent-comments, post verdict and label transition to the PR's Slack thread via /slack-notify.
```

## What happens each cycle

1. Find matching PRs: `.claude/skills/cdd-common/scripts/find-my-prs "spec:agent-reviewing"` (returns JSON array filtered by current user + label)
2. If empty array, do nothing (wait for next cycle)
3. For each PR found:
   - Extract issue number: `.claude/skills/cdd-common/scripts/get-issue-number "$branch"`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - If no worktree found, create one: `git worktree add .claude/worktrees/$slug $branch` (slug is the branch suffix, e.g. `issue-42-foo` from `t/user/issue-42-foo`)
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Run `/cdd-spec-review`
6. If assessment is SOLID:
   - Transition labels to `spec:agent-approved`
   - Mark draft PR as ready: `gh pr ready $PR_NUMBER`
   - Run `/slack-notify $PR_NUMBER CDD Spec Review :white_check_mark: *SOLID* — {summary}\nLabels: \`spec:agent-reviewing\` → \`spec:agent-approved\``
7. If assessment is HAS GAPS:
   - Labels transition to `spec:agent-comments`
   - Run `/slack-notify $PR_NUMBER CDD Spec Review :warning: *HAS GAPS* — {summary}\nLabels: \`spec:agent-reviewing\` → \`spec:agent-comments\``

## Slack notifications

Use the `/slack-notify` skill for all Slack posts. See
`.claude/skills/slack-notify/SKILL.md` for the full procedure.

## Label transitions

```
spec:agent-reviewing  →  spec:agent-approved   (if /cdd-spec-review passes)
spec:agent-reviewing  →  spec:agent-comments   (if /cdd-spec-review finds gaps)
```
