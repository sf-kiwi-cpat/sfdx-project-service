The PR data was provided above as JSON. Do not re-query GitHub for the PR list.

For each PR found:
1. Extract branch name from the headRefName field
2. Extract issue number: echo "$headRefName" | sed 's/.*issue-\([0-9]*\).*/\1/'
3. Find the corresponding worktree and enter it:
   ```bash
   git worktree list --porcelain | grep -B2 "branch.*$headRefName" | grep "^worktree " | cut -d' ' -f2
   ```
4. Run `npm install` if node_modules is missing (worktrees don't share node_modules)
5. Run /review to verify implementation correctness and code quality
6. If /review verdict is PASS:
   - Labels are already transitioned to review:complete by the /review skill
   - Get repo URL: REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   - Post to #app-studio-prs (C0ANF2KL5HT) in the PR's thread (see Slack threading below):
     "PR ready for merge: #<pr-number> - <title>\nIssue: https://github.com/$REPO/issues/<issue>\nLink: https://github.com/$REPO/pull/<pr-number>"
7. If /review verdict is NEEDS WORK:
   - Do NOT update labels (leave impl:ready so it gets re-reviewed next cycle)
   - Post to #app-studio-prs (C0ANF2KL5HT) in the PR's thread noting the review findings

Use gh CLI for all GitHub operations. Use Slack MCP tool for notifications.

## Slack threading in #app-studio-prs

Each PR gets its own thread. To find or create it:

1. Search channel for existing thread: use slack_read_channel on C0ANF2KL5HT and look for
   a message containing "PR #<pr-number>" or the PR URL.
2. If found: reply in that thread (set thread_ts to the parent message's timestamp).
3. If not found: post a new top-level message to start the thread. Use format:
   "PR #<pr-number> - <title>\nLink: https://github.com/$REPO/pull/<pr-number>"
   Then reply in that thread with the review status.

Process all matching PRs, then exit. The monitoring script will invoke you again on the next check.
