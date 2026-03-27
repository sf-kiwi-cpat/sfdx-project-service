# CDD Implementation Fix Monitor Loop

Detects `impl:agent-comments` PRs assigned to the local user, reads code review findings, fixes the implementation, and relabels for re-review.

## Start

```
/loop 5m Run ME=$(gh api user -q '.login') then check for open PRs with the impl:agent-comments label assigned to $ME using gh pr list --state open --label impl:agent-comments --assignee "$ME" --json number,headRefName,title. If none found, do nothing. For each PR: extract the issue number from the branch name using sed, find the matching worktree via git worktree list, enter it with EnterWorktree, run npm install if node_modules is missing. Count how many CDD Code Review comments exist on the PR — if 3 or more, do NOT fix; instead post to #app-studio-alerts (C0ANF2KL5HT) in the PR's thread with "Impl fix loop hit max retries (3) — human intervention needed" and skip this PR. Otherwise: read the most recent CDD Code Review comment on the PR to understand what needs fixing. Address each finding from the review — fix correctness issues, address architecture concerns, clean up AI slop. Run all tests (npm test) to confirm they pass. Commit the fixes, push, then transition labels: remove impl:agent-comments and add impl:agent-reviewing on both the issue and PR. Post to #app-studio-alerts (C0ANF2KL5HT) in the PR's thread with "Implementation fixes pushed — ready for re-review".
```

## Max retry safety

Before fixing, count how many `CDD Code Review` comments exist on the PR
(each review→fix cycle adds one). If there are already **3 or more**, stop
auto-fixing: leave the label as `impl:agent-comments` and post to the PR's
Slack thread asking the human to intervene.

## What happens each cycle

1. Get current user: `ME=$(gh api user -q '.login')`
2. Query: `gh pr list --state open --label impl:agent-comments --assignee "$ME" --json number,headRefName,title`
3. If no results, do nothing (wait for next cycle)
4. For each PR found:
   - Extract issue number: `echo "$branch" | sed 's/.*issue-\([0-9]*\).*/\1/'`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Count `CDD Code Review` comments on the PR — if ≥ 3, skip and notify human
   - Read the most recent `CDD Code Review` comment on the PR for findings
   - Address each finding from the review
   - Run all tests: `npm test`
   - Commit, push
5. Transition labels:
   - Remove `impl:agent-comments`, add `impl:agent-reviewing` (on issue and PR)
6. Post to #app-studio-alerts in the PR's thread

## Slack threading in #app-studio-alerts

Each PR gets its own thread in channel C0ANF2KL5HT:

1. Search channel for existing thread containing "PR #N" or the PR URL
2. If found: reply in that thread (set `thread_ts` to the parent message's timestamp)
3. If not found: post a new top-level message:
   `"PR #N - title\nLink: https://github.com/REPO/pull/N"`
   Then reply in that thread with the fix status

## Label transitions

```
impl:agent-comments  →  impl:agent-reviewing  (after fixes pushed)
```
