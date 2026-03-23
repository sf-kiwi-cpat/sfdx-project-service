The PR data was provided above as JSON. Do not re-query GitHub for the PR list.

For each PR found:
1. Extract branch name from the headRefName field
2. Extract issue number: echo "$headRefName" | sed 's/.*issue-\([0-9]*\).*/\1/'
3. Find the corresponding worktree and enter it:
   ```bash
   git worktree list --porcelain | grep -B2 "branch.*$headRefName" | grep "^worktree " | cut -d' ' -f2
   ```
4. Run `npm install` if node_modules is missing (worktrees don't share node_modules)
5. Run /simplify to review code quality and fix any issues found
6. After review completes:
   - Update issue label: gh issue edit <issue-number> --remove-label impl:ready --add-label review:complete
   - Update PR label: gh pr edit <pr-number> --remove-label impl:ready --add-label review:complete
   - Get repo URL: REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   - Send Slack notification to #general using the Slack MCP tool with:
     "PR ready for merge: #<pr-number> - <title>\nIssue: https://github.com/$REPO/issues/<issue>\nLink: https://github.com/$REPO/pull/<pr-number>"

Use gh CLI for all GitHub operations. Use Slack MCP tool for notifications.

Process all matching PRs, then exit. The monitoring script will invoke you again on the next check.
