# Review Monitor Loop

Detects `impl:ready` PRs, runs `/cdd-code-review`, and sends Slack notification.

## Start

```
/loop 5m Check for open PRs with the impl:ready label using gh pr list --state open --label impl:ready --json number,headRefName,title. If none found, do nothing. For each PR: extract the issue number from the branch name using sed, find the matching worktree via git worktree list, enter it with EnterWorktree, run npm install if node_modules is missing, then run /cdd-code-review. If review verdict is PASS: labels are already transitioned by /cdd-code-review, post to #app-studio-prs (C0ANF2KL5HT) in the PR's thread with "PR ready for merge" and links. If verdict is NEEDS WORK: do NOT update labels, post review findings in the PR's thread.
```

## What happens each cycle

1. Query: `gh pr list --state open --label impl:ready --json number,headRefName,title`
2. If no results, do nothing (wait for next cycle)
3. For each PR found:
   - Extract issue number: `echo "$branch" | sed 's/.*issue-\([0-9]*\).*/\1/'`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Run `/cdd-code-review`
4. If verdict is PASS:
   - Labels already transitioned to `review:complete` by `/cdd-code-review`
   - Post to #app-studio-prs in the PR's thread (see Slack threading below)
5. If verdict is NEEDS WORK:
   - Do NOT update labels (leave `impl:ready` for re-review next cycle)
   - Post review findings in the PR's thread

## Slack threading in #app-studio-prs

Each PR gets its own thread in channel C0ANF2KL5HT:

1. Search channel for existing thread containing "PR #N" or the PR URL
2. If found: reply in that thread (set `thread_ts` to the parent message's timestamp)
3. If not found: post a new top-level message:
   `"PR #N - title\nLink: https://github.com/REPO/pull/N"`
   Then reply in that thread with the review status

## Label transitions

```
impl:ready  →  review:complete  (after /cdd-code-review passes)
```
