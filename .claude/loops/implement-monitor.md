There are open PRs with the spec:approved label. Query them using: gh pr list --state open --label spec:approved --json number,headRefName

For each PR found:
1. Extract issue number from branch name using regex: echo "$headRefName" | grep -oP 'issue-\K\d+'
2. Find the corresponding worktree: git worktree list --porcelain | grep "$headRefName"
3. Change into that worktree directory
4. Find the contract spec file: find spec -name "contract.spec.ts" -type f | head -1
5. Run: /implement /path/to/contract.spec.ts

The /implement skill will handle all label updates and code changes. Do not modify spec files directly.

Process all matching PRs, then exit. The monitoring script will invoke you again on the next check.
