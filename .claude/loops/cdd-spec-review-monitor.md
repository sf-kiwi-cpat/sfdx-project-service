# CDD Spec Review Monitor Loop

Detects `spec:agent-reviewing` PRs assigned to the local user, runs `/cdd-spec-review`, and sends Slack notification.

## Start

```
/loop 5m Run ME=$(gh api user -q '.login') then fetch ALL open PRs using gh pr list --state open --json number,headRefName,title,labels,assignees and pipe the output to jq with --arg ME "$ME" to filter client-side: '[.[] | select((.assignees | map(.login) | index($ME)) and (.labels | map(.name) | index("spec:agent-reviewing")))]'. Do NOT use gh's --jq flag with --arg (gh doesn't support jq's --arg); always pipe to jq separately. Both --assignee and --label flags are unreliable, so we filter everything client-side. If none found after filtering, do nothing. For each matching PR: extract the issue number from the branch name using sed, find the matching worktree via git worktree list. If no worktree exists for the branch, create one with git worktree add .claude/worktrees/$SLUG $BRANCH where SLUG is the branch name after the user prefix (e.g. for t/user/issue-42-foo the slug is issue-42-foo). Enter the worktree with EnterWorktree, run npm install if node_modules is missing, then run /cdd-spec-review. The skill posts findings to the PR as a comment. If assessment is SOLID: transition labels to spec:agent-approved, mark the draft PR as ready for review using gh pr ready, post to #app-studio-alerts (C0ANF2KL5HT) in the PR's thread with "Spec review passed — ready for human approval" and links. If assessment is HAS GAPS: labels transition to spec:agent-comments, post findings summary in the PR's thread.
```

## What happens each cycle

1. Get current user: `ME=$(gh api user -q '.login')`
2. Query all open PRs: `gh pr list --state open --json number,headRefName,title,labels,assignees`
3. Filter client-side for assignee `$ME` AND `spec:agent-reviewing` label (both `--assignee` and `--label` flags are unreliable)
4. If no results after filtering, do nothing (wait for next cycle)
5. For each PR found:
   - Extract issue number: `echo "$branch" | sed 's/.*issue-\([0-9]*\).*/\1/'`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - If no worktree found, create one: `git worktree add .claude/worktrees/$slug $branch` (slug is the branch suffix, e.g. `issue-42-foo` from `t/user/issue-42-foo`)
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Run `/cdd-spec-review`
6. If assessment is SOLID:
   - Transition labels to `spec:agent-approved`
   - Mark draft PR as ready: `gh pr ready $PR_NUMBER`
   - Run `/slack-notify $PR_NUMBER CDD Spec Review :white_check_mark: *SOLID* — {summary}\nLabels: \`spec:agent-reviewing\` → \`spec:agent-approved\`. Ready for human approval.`
7. If assessment is HAS GAPS:
   - Labels transition to `spec:agent-comments`
   - Run `/slack-notify $PR_NUMBER CDD Spec Review :warning: *HAS GAPS* — {summary}\nLabels: \`spec:agent-reviewing\` → \`spec:agent-comments\`. Findings posted to PR.`

## Slack notifications

Use the `/slack-notify` skill for all Slack posts. See
`.claude/skills/slack-notify/SKILL.md` for the full procedure.

## Label transitions

```
spec:agent-reviewing  →  spec:agent-approved   (if /cdd-spec-review passes)
spec:agent-reviewing  →  spec:agent-comments   (if /cdd-spec-review finds gaps)
```
