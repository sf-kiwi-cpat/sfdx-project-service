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
   - DM the PR author via Slack MCP tool (use slack_search_users to find their user ID by name) with:
     "PR ready for merge: #<pr-number> - <title>\nIssue: https://github.com/$REPO/issues/<issue>\nLink: https://github.com/$REPO/pull/<pr-number>"
7. If /review verdict is NEEDS WORK:
   - Do NOT update labels (leave impl:ready so it gets re-reviewed next cycle)
   - DM the PR author via Slack noting the review findings

Use gh CLI for all GitHub operations. Use Slack MCP tool for DM notifications to the PR author.

Process all matching PRs, then exit. The monitoring script will invoke you again on the next check.
