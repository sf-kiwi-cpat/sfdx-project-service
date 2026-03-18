The PR data was provided above as JSON. Do not re-query GitHub for the PR list.

For each PR found:
1. Extract branch name from headRefName
2. Extract issue number: echo "$headRefName" | sed 's/.*issue-\([0-9]*\).*/\1/'
3. Find the corresponding worktree and enter it
4. Run the built-in /review command to assess code quality
5. If /review succeeds (exits 0):
   - Update issue label: gh issue edit <issue-number> --remove-label impl:ready --add-label review:complete
   - Update PR label: gh pr edit <pr-number> --remove-label impl:ready --add-label review:complete
   - Get repo URL: REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   - Send Slack notification to #general with: "✅ PR ready for merge: #{PR} - {title}\nIssue: https://github.com/$REPO/issues/{issue}\nLink: https://github.com/$REPO/pull/{PR}"
6. If /review fails (exits non-0):
   - Leave labels at impl:ready
   - /review will have pushed fixes
   - Loop will check again on next iteration

Use gh CLI for all GitHub operations. Use Slack MCP tool for notifications.

Process all matching PRs, then exit. The monitoring script will invoke you again on the next check.
