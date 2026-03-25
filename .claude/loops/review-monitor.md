# Review Monitor Loop

Detects `impl:ready` PRs, runs `/cdd-code-review`, and sends Slack notification.

## Start

```
/loop 5m Check for open PRs with the impl:ready label using gh pr list --state open --label impl:ready --json number,headRefName,title. If none found, do nothing. For each PR: extract the issue number from the branch name using sed, find the matching worktree via git worktree list, enter it with EnterWorktree, run npm install if node_modules is missing, then run /cdd-code-review. If review verdict is PASS: labels are already transitioned to review:complete by /cdd-code-review, post to #app-studio-prs (C0ANF2KL5HT) in the PR's thread with "🤖 CDD Agent · code-review\n✅ PASS — ready for merge" and the PR link. If verdict is NEEDS WORK: labels are already transitioned to impl:comments by /cdd-code-review, post to the PR's thread with "🤖 CDD Agent · code-review\n⚠️ NEEDS WORK — N findings posted to PR" and the PR link.
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
   - Post to #app-studio-prs in the PR's thread:
     `🤖 CDD Agent · code-review`
     `✅ PASS — ready for merge`
     `PR #N: https://github.com/REPO/pull/N`
5. If verdict is NEEDS WORK:
   - Labels already transitioned to `impl:comments` by `/cdd-code-review`
   - Post to #app-studio-prs in the PR's thread:
     `🤖 CDD Agent · code-review`
     `⚠️ NEEDS WORK — N findings posted to PR`
     `PR #N: https://github.com/REPO/pull/N`
   - The PR will not be re-reviewed until `impl:comments` is moved back to `impl:ready`

## Slack threading in #app-studio-prs

Each PR gets its own thread in channel C0ANF2KL5HT:

1. Search channel for existing thread containing "PR #N" or the PR URL
2. If found: reply in that thread (set `thread_ts` to the parent message's timestamp)
3. If not found: post a new top-level message:
   `"PR #N - title\nLink: https://github.com/REPO/pull/N"`
   Then reply in that thread with the agent-signed status (see format above)

## Label transitions

```
impl:ready  →  review:complete  (after /cdd-code-review passes)
impl:ready  →  impl:comments    (after /cdd-code-review finds issues)
```
