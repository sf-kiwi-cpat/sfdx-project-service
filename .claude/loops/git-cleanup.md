# Git Cleanup Loop

Removes local branches (and their worktrees) whose PRs have been merged or
closed on GitHub. Prunes stale remote-tracking refs and runs garbage collection.

**Source of truth is GitHub PR state, not `git branch --merged`.**
`git branch --merged` is unreliable for this purpose — it reports any branch
whose tip is reachable from main, including fresh branches that were created
from main but have no merged PR.

## Start

```
/loop 30m Run the git cleanup procedure below. All work happens in the main worktree (do NOT use EnterWorktree). 1) git fetch origin && git reset --hard origin/main (keep main current). 2) Collect LOCAL branch names (git branch --format='%(refname:short)', exclude main). 3) For each local branch: run gh pr list --head <branch> --state merged --json number,title --limit 1. If a merged PR exists, this branch is safe to delete: check git worktree list for a worktree on that branch, if found rm -rf <worktree>/node_modules then git worktree remove <path> --force, then git branch -D <branch>. Log each removal with PR number. 4) For each remaining local branch: run gh pr list --head <branch> --state closed --json number,title --limit 1. If a closed (not merged) PR exists, same cleanup: remove worktree if any, then git branch -D <branch>. Log each removal. 5) git worktree prune. 6) git remote prune origin. 7) git gc --auto. 8) Print a summary of what was cleaned (branches removed, worktrees removed, refs pruned). If nothing to clean, print "Nothing to clean."
```

## What happens each cycle

1. **Sync main**: `git fetch origin && git reset --hard origin/main`
2. **Collect local branches**: `git branch --format='%(refname:short)'`, exclude `main`
3. **Merged-PR branches**: For each local branch, query GitHub:
   `gh pr list --head <branch> --state merged --json number,title --limit 1`
   - If a merged PR exists: remove worktree (if any, including `node_modules/`),
     then `git branch -D <branch>`
4. **Closed-PR branches**: For remaining local branches, query GitHub:
   `gh pr list --head <branch> --state closed --json number,title --limit 1`
   - If a closed (not merged) PR exists: same worktree + branch cleanup
5. **Prune worktrees**: `git worktree prune` (cleans orphaned metadata)
6. **Prune remotes**: `git remote prune origin` (removes stale tracking refs)
7. **GC**: `git gc --auto` (let git decide if collection is needed)
8. **Summary**: print what was cleaned or "Nothing to clean."

## Safety

- **GitHub PR state is the only delete signal** — a branch is only removed if
  GitHub confirms a merged or closed PR for it. No reliance on `git branch --merged`.
- Removes `node_modules/` before worktree removal to speed up cleanup
- Uses `--force` on worktree remove to handle dirty worktrees (the work is
  either merged or abandoned)
- Branches with no PR at all are left untouched
- Does not delete remote branches (GitHub auto-deletes on merge)

## Running standalone

```bash
# Start from any Claude Code session:
/loop 30m <paste the prompt from the Start section>
```

This loop is NOT included in `/start-loops` (CDD-only). Start it separately.
