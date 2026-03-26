# CDD Implementation Fix Monitor Loop

Detects `impl:agent-comments` PRs assigned to the local user, reads code review findings, fixes the implementation, and relabels for re-review.

## Start

```
/loop 5m Run ME=$(gh api user -q '.login') then check for open PRs with the impl:agent-comments label assigned to $ME using gh pr list --state open --label impl:agent-comments --assignee "$ME" --json number,headRefName,title. If none found, do nothing. For each PR: extract the issue number from the branch name using sed, find the matching worktree via git worktree list, enter it with EnterWorktree, run npm install if node_modules is missing. Read the most recent CDD Code Review comment on the PR to understand what needs fixing. Address each finding from the review — fix correctness issues, address architecture concerns, clean up AI slop. Run all tests (npm test) to confirm they pass. Commit the fixes, push, then transition labels: remove impl:agent-comments and add impl:ready-for-agent-review on both the issue and PR. Post to #app-studio-prs (C0ANF2KL5HT) in the PR's thread with "Implementation fixes pushed — ready for re-review".
```

## What happens each cycle

1. Get current user: `ME=$(gh api user -q '.login')`
2. Query: `gh pr list --state open --label impl:agent-comments --assignee "$ME" --json number,headRefName,title`
3. If no results, do nothing (wait for next cycle)
4. For each PR found:
   - Extract issue number: `echo "$branch" | sed 's/.*issue-\([0-9]*\).*/\1/'`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Read the most recent `CDD Code Review` comment on the PR for findings
   - Address each finding from the review
   - Run all tests: `npm test`
   - Commit, push
5. Transition labels:
   - Remove `impl:agent-comments`, add `impl:ready-for-agent-review` (on issue and PR)
6. Post to #app-studio-prs in the PR's thread

## Slack threading in #app-studio-prs

Each PR gets its own thread in channel C0ANF2KL5HT:

1. Search channel for existing thread containing "PR #N" or the PR URL
2. If found: reply in that thread (set `thread_ts` to the parent message's timestamp)
3. If not found: post a new top-level message:
   `"PR #N - title\nLink: https://github.com/REPO/pull/N"`
   Then reply in that thread with the fix status

## Label transitions

```
impl:agent-comments  →  impl:ready-for-agent-review  (after fixes pushed)
```
