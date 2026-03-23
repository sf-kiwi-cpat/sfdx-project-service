The PR data was provided above as JSON. Do not re-query GitHub for the PR list.

For each PR found:
1. Extract the branch name from the headRefName field
2. Extract issue number from branch name: echo "$headRefName" | sed 's/.*issue-\([0-9]*\).*/\1/'
3. Find the corresponding worktree:
   ```bash
   git worktree list --porcelain | grep -B2 "branch.*$headRefName" | grep "^worktree " | cut -d' ' -f2
   ```
4. Change into that worktree directory
5. Run `npm install` if node_modules is missing (worktrees don't share node_modules)
6. Find the contract spec file: find spec -name "contract.spec.ts" -type f | head -1
7. Run: /implement /path/to/contract.spec.ts

The /implement skill will handle all label updates, code changes, and pushing. Do not modify spec files directly.

Process all matching PRs, then exit. The monitoring script will invoke you again on the next check.
