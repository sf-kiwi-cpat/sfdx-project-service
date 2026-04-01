# CDD Spec Fix Monitor Loop

Detects `spec:agent-comments` PRs assigned to the local user, reads spec review findings, fixes the spec, and relabels for re-review.

## Start

```
/loop 5m Run .claude/skills/cdd-common/scripts/find-my-prs "spec:agent-comments" to get a JSON array of matching PRs (filters by current user and label). If the array is empty, do nothing. For each matching PR: extract the issue number from the branch name using .claude/skills/cdd-common/scripts/get-issue-number "$branch", find the matching worktree via git worktree list. If no worktree exists for the branch, create one with git worktree add .claude/worktrees/$SLUG $BRANCH where SLUG is the branch name after the user prefix (e.g. for t/user/issue-42-foo the slug is issue-42-foo). Enter the worktree with EnterWorktree, run npm install if node_modules is missing. Count how many CDD Spec Review comments exist on the PR — if 3 or more, do NOT fix; instead post to #app-studio-alerts (C0ANF2KL5HT) in the PR's thread with "Spec fix loop hit max retries (3) — human intervention needed" and skip this PR. Otherwise: read the most recent CDD Spec Review comment on the PR to understand what needs fixing. Find the spec files in spec/ for the feature. Address each finding from the review — fix ambiguities, add missing scenarios, tighten assertions, improve mock boundaries. Run the contract spec tests to confirm they still pass. Commit the fixes, push, then transition labels: remove spec:agent-comments and add spec:agent-reviewing on both the issue and PR. Post to #app-studio-alerts (C0ANF2KL5HT) in the PR's thread with "Spec fixes pushed — ready for re-review".
```

## Max retry safety

Before fixing, count how many `CDD Spec Review` comments exist on the PR
(each review→fix cycle adds one). If there are already **3 or more**, stop
auto-fixing: leave the label as `spec:agent-comments` and post to the PR's
Slack thread asking the human to intervene.

## What happens each cycle

1. Find matching PRs: `.claude/skills/cdd-common/scripts/find-my-prs "spec:agent-comments"` (returns JSON array filtered by current user + label)
2. If empty array, do nothing (wait for next cycle)
3. For each PR found:
   - Extract issue number: `.claude/skills/cdd-common/scripts/get-issue-number "$branch"`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - If no worktree found, create one: `git worktree add .claude/worktrees/$slug $branch` (slug is the branch suffix, e.g. `issue-42-foo` from `t/user/issue-42-foo`)
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Count `CDD Spec Review` comments on the PR — if ≥ 3, skip and notify human
   - Read the most recent `CDD Spec Review` comment on the PR for findings
   - Find spec files: `find spec -name "contract.spec.ts" -type f`
   - Fix each finding from the review
   - Run contract spec tests to confirm they pass
   - Commit, push
6. Transition labels:
   - Remove `spec:agent-comments`, add `spec:agent-reviewing` (on issue and PR)
7. Run `/slack-notify $PR_NUMBER CDD Spec Fix :wrench: Spec fixes pushed — ready for re-review\n{bullet list of fixes applied}\nLabels: \`spec:agent-comments\` → \`spec:agent-reviewing\``
   - If max retries hit: `/slack-notify $PR_NUMBER CDD Spec Fix :rotating_light: Max retries (3) — human intervention needed`

## Slack notifications

Use the `/slack-notify` skill for all Slack posts. See
`.claude/skills/slack-notify/SKILL.md` for the full procedure.

## Label transitions

```
spec:agent-comments  →  spec:agent-reviewing  (after fixes pushed)
```
