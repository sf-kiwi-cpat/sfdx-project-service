# Loop Preamble

Shared setup steps for all CDD monitor loops. Each loop prompt should
reference this file before dispatching to its target skill or fix work.

## Find matching PRs

Run `.claude/skills/cdd-common/scripts/find-my-prs "<label>"` with the
loop's target label. This returns a JSON array of PRs assigned to the
current `gh` user matching the label. If the array is empty, stop — nothing
to do this cycle.

## Set up worktree for each PR

For each PR:

1. Get the branch name from the PR JSON
2. Extract the issue number: `.claude/skills/cdd-common/scripts/get-issue-number "$branch"`
3. Check if a worktree exists for this branch (`git worktree list`)
4. If not, create one under `.claude/worktrees/` using the branch suffix
   as the directory name (e.g., `issue-42-foo` from `t/user/issue-42-foo`)
5. Run `npm install` in the worktree if `node_modules/` is missing

Then `EnterWorktree` at the worktree path before running the target skill.

## Max retry check (fix loops only)

Fix loops specify a max retry count and a review comment header (e.g.,
`"CDD Code Review"` or `"CDD Spec Review"`). Before fixing a PR:

1. Count comments on the PR whose body contains the review header
2. If count >= the max (typically 3): skip the PR and post a **top-level
   message** to `#app-studio-alerts` (`C0ANF2KL5HT`) tagging the PR
   assignee — draft PRs have no GitHub bot thread, so a top-level
   message is the right escalation path
3. Otherwise: proceed with fixes
