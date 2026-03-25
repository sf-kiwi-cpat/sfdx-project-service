# Spec Review Monitor Loop

Detects `spec:ready-for-review` PRs, runs `/cdd-spec-review`, and sends Slack notification.

## Start

```
/loop 5m Check for open PRs with the spec:ready-for-review label using gh pr list --state open --label spec:ready-for-review --json number,headRefName,title. If none found, do nothing. For each PR: extract the issue number from the branch name using sed, find the matching worktree via git worktree list, enter it with EnterWorktree, run npm install if node_modules is missing, then run /cdd-spec-review. The skill posts findings to the PR as a comment. If assessment is SOLID: post to #app-studio-prs (C0ANF2KL5HT) in the PR's thread with "🤖 CDD Agent · spec-review\n✅ SOLID — ready for human approval" and the PR link. If assessment is HAS GAPS: labels transition to spec:comments, post to the PR's thread with "🤖 CDD Agent · spec-review\n⚠️ HAS GAPS — N items to address, findings posted to PR" and the PR link.
```

## What happens each cycle

1. Query: `gh pr list --state open --label spec:ready-for-review --json number,headRefName,title`
2. If no results, do nothing (wait for next cycle)
3. For each PR found:
   - Extract issue number: `echo "$branch" | sed 's/.*issue-\([0-9]*\).*/\1/'`
   - Find worktree: `git worktree list --porcelain | grep -B2 "branch.*$branch"`
   - Enter worktree via `EnterWorktree`
   - `npm install` if `node_modules/` missing
   - Find spec: `find spec -name "contract.spec.ts" -type f | head -1`
   - Run `/cdd-spec-review`
4. If assessment is SOLID:
   - No label change (stays `spec:ready-for-review`)
   - Post to #app-studio-prs in the PR's thread:
     `🤖 CDD Agent · spec-review`
     `✅ SOLID — ready for human approval`
     `PR #N: https://github.com/REPO/pull/N`
5. If assessment is HAS GAPS:
   - Labels transition to `spec:comments`
   - Post to #app-studio-prs in the PR's thread:
     `🤖 CDD Agent · spec-review`
     `⚠️ HAS GAPS — N items to address, findings posted to PR`
     `PR #N: https://github.com/REPO/pull/N`
   - The PR will not be re-reviewed until `spec:comments` is moved back to `spec:ready-for-review`
6. The human can override by moving directly to `spec:approved`

## Slack threading in #app-studio-prs

Each PR gets its own thread in channel C0ANF2KL5HT:

1. Search channel for existing thread containing "PR #N" or the PR URL
2. If found: reply in that thread (set `thread_ts` to the parent message's timestamp)
3. If not found: post a new top-level message:
   `"PR #N - title\nLink: https://github.com/REPO/pull/N"`
   Then reply in that thread with the agent-signed status (see format above)

## Label transitions

```
spec:ready-for-review  →  spec:comments  (if /cdd-spec-review finds gaps)
```
