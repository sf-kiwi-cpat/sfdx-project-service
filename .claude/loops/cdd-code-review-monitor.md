# CDD Code Review Monitor Loop

Detects `impl:agent-reviewing` PRs assigned to the local user, runs `/cdd-code-review`, and sends Slack notification.

## Start

```
/loop 5m Run .claude/skills/cdd-common/scripts/find-my-prs "impl:agent-reviewing" to get a JSON array of matching PRs (filters by current user and label). If the array is empty, do nothing. For each matching PR: extract the issue number from the branch name using .claude/skills/cdd-common/scripts/get-issue-number "$branch", find the matching worktree via git worktree list. If no worktree exists for the branch, create one with git worktree add .claude/worktrees/$SLUG $BRANCH where SLUG is the branch name after the user prefix (e.g. for t/user/issue-42-foo the slug is issue-42-foo). Enter the worktree with EnterWorktree, run npm install if node_modules is missing, then run /cdd-code-review. If review verdict is PASS: labels transition to impl:agent-approved, post to #app-studio-alerts (C0ANF2KL5HT) in the PR's thread with "PR ready for merge" and links. If verdict is NEEDS WORK: labels transition to impl:agent-comments, post review findings in the PR's thread.
```

## What happens each cycle

1. Find matching PRs: `.claude/skills/cdd-common/scripts/find-my-prs "impl:agent-reviewing"` (returns JSON array filtered by current user + label)
2. If empty array, do nothing (wait for next cycle)
3. For each PR found:
   - Extract issue number: `.claude/skills/cdd-common/scripts/get-issue-number "$branch"`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - If no worktree found, create one: `git worktree add .claude/worktrees/$slug $branch` (slug is the branch suffix, e.g. `issue-42-foo` from `t/user/issue-42-foo`)
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Run `/cdd-code-review`
6. If verdict is PASS:
   - Labels transition to `impl:agent-approved`
   - Run `/slack-notify $PR_NUMBER CDD Code Review :white_check_mark: *PASS* — {summary}\nLabels: \`impl:agent-reviewing\` → \`impl:agent-approved\`. Ready for human merge.`
7. If verdict is NEEDS WORK:
   - Labels transition to `impl:agent-comments`
   - Run `/slack-notify $PR_NUMBER CDD Code Review :warning: *NEEDS WORK* — {summary}\nLabels: \`impl:agent-reviewing\` → \`impl:agent-comments\`. Findings posted to PR.`

## Slack notifications

Use the `/slack-notify` skill for all Slack posts. See
`.claude/skills/slack-notify/SKILL.md` for the full procedure.

## Label transitions

```
impl:agent-reviewing  →  impl:agent-approved   (after /cdd-code-review passes)
impl:agent-reviewing  →  impl:agent-comments   (after /cdd-code-review finds issues)
```
