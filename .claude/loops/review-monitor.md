There are open PRs with the impl:ready label. Query them using: gh pr list --state open --label impl:ready --json number,headRefName,title

For each PR found:
1. Extract branch name from headRefName
2. Extract issue number using: echo "$headRefName" | grep -oP 'issue-\K\d+'
3. Find the corresponding worktree and enter it
4. Run the built-in /review command to assess code quality
5. If /review succeeds (exits 0):
   - Update issue label: gh issue edit <issue-number> --remove-label impl:ready --add-label review:complete
   - Update PR label: gh pr edit <pr-number> --remove-label impl:ready --add-label review:complete
   - Send Slack notification to #general with: "✅ PR ready for merge: #{PR} - {title}\nIssue: https://github.com/forcedotcom/sf-project-service/issues/{issue}\nLink: https://github.com/forcedotcom/sf-project-service/pull/{PR}"
6. If /review fails (exits non-0):
   - Leave labels at impl:ready
   - /review will have pushed fixes
   - Loop will check again on next iteration

Use gh CLI for all GitHub operations. Use Slack MCP tool for notifications.

Process all matching PRs, then exit. The monitoring script will invoke you again on the next check.
