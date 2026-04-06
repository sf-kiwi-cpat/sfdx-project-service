# Git Cleanup Loop

Removes local branches (and their worktrees) whose PRs have been merged or
closed on GitHub. Prunes stale remote-tracking refs and runs garbage collection.

**Source of truth is GitHub PR state, not `git branch --merged`.**
`git branch --merged` is unreliable for this purpose — it reports any branch
whose tip is reachable from main, including fresh branches that were created
from main but have no merged PR.

## Start

```
/loop 30m Run the git cleanup procedure below. All work happens in the main worktree (do NOT use EnterWorktree). 1) git fetch origin (update remote tracking refs — do NOT reset or checkout main). 2) Collect LOCAL branch names (git branch --format='%(refname:short)', exclude main). 3) For each local branch: run gh pr list --head <branch> --state closed --json number,title,state --limit 1. If a result exists (state will be MERGED or CLOSED), this branch is safe to delete: check git worktree list for a worktree on that branch, if found rm -rf <worktree>/node_modules then attempt git worktree remove <path> (without --force). If worktree removal fails (in use or dirty), log "skipping worktree <path>, in use" and skip this branch entirely. If worktree removal succeeds (or no worktree), run git branch -D <branch>. Log each removal with PR number and state (merged/closed). 4) git worktree prune. 5) git remote prune origin. 6) git gc --auto. 7) Print a summary of what was cleaned (branches removed, worktrees removed, refs pruned). If nothing to clean, print "Nothing to clean."
```

## What happens each cycle

1. **Fetch**: `git fetch origin` (updates remote tracking refs only — no checkout or reset)
2. **Collect local branches**: `git branch --format='%(refname:short)'`, exclude `main`
3. **Closed/merged-PR branches**: For each local branch, query GitHub:
   `gh pr list --head <branch> --state closed --json number,title,state --limit 1`
   (`--state closed` returns both merged and explicitly-closed PRs; the `state`
   field distinguishes `MERGED` from `CLOSED` for logging)
   - If a result exists: remove worktree (if any — `rm -rf node_modules/` first,
     then `git worktree remove <path>` without `--force`). If worktree removal
     fails, skip this branch (likely in active use). Otherwise `git branch -D <branch>`.
4. **Prune worktrees**: `git worktree prune` (cleans orphaned metadata)
5. **Prune remotes**: `git remote prune origin` (removes stale tracking refs)
6. **GC**: `git gc --auto` (let git decide if collection is needed)
7. **Summary**: print what was cleaned or "Nothing to clean."

## Safety

- **GitHub PR state is the only delete signal** — a branch is only removed if
  GitHub confirms a merged or closed PR for it. No reliance on `git branch --merged`.
- **No checkout or reset** — `git fetch` only updates remote tracking refs;
  never touches the working tree or moves HEAD. Safe regardless of which
  branch is currently checked out.
- **No `--force` on worktree removal** — if `git worktree remove` fails
  (e.g., a CDD agent is mid-session), the branch is skipped and retried
  next cycle. This prevents destroying an active agent's working directory.
- Removes `node_modules/` before worktree removal to speed up cleanup
- Branches with no PR at all are left untouched
- Does not delete remote branches (GitHub auto-deletes on merge)

## Running standalone

```bash
# Start from any Claude Code session:
/loop 30m <paste the prompt from the Start section>
```

This loop is NOT included in `/start-loops` (CDD-only). Start it separately.
