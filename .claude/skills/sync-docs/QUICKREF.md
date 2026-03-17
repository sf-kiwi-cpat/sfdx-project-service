# Quick Reference Card

## One-Liner Invocations

```bash
/sync-docs                    # Run full workflow
/loop 24h [sync-docs-prompt]  # Schedule daily
/memory/docs-sync.md          # Check current state
```

## The Workflow (5 Phases)

| Phase | What | Owner | Input | Output |
|-------|------|-------|-------|--------|
| 1 | PR Detection | System | GitHub | PR # or new branch |
| 2 | Code→Docs | Agent A | Codebase | Updated docs |
| 3 | Docs→Code | Agent B | Docs + Code | Pass/Fail + issues |
| 4 | Fix & Iterate | Agent A | Issues | Fixed docs (if issues) |
| 5 | Commit & PR | System | Docs + PR # | PR URL |

## Key Commands

```bash
# Detect open PR
gh pr list --state open --label "automated" -L 1

# Create worktree
git worktree add .claude/worktrees/docs-sync origin/main

# Stage docs
git add docs/

# Commit
git commit -m "docs: keep in sync with codebase"

# Push
git push -u origin [branch]

# Create PR
gh pr create --title "..." --body "..." --label "automated"

# Update PR
git push origin [branch]  # Automatically updates

# View PR
gh pr view [pr-number]
```

## Doc Files to Maintain

```
/docs/
├── README.md           # Overview + tech stack
├── api.md             # Endpoints + examples
├── architecture.md    # Design + security + deployment
├── development.md     # Setup + testing + docker
├── api-examples.md    # Curl/bash/JS/Python examples
└── modules.md         # Module reference + code examples
```

## Success Indicators

✓ Phase 2 completes without errors
✓ Phase 3 finds zero discrepancies (or all fixed)
✓ `git add docs/` succeeds
✓ PR created/updated successfully
✓ PR has "automated" label

## When to Run

- **Scheduled**: Daily at 00:00 (cron job)
- **Manual**: After major code refactor
- **Manual**: After significant API changes
- **Manual**: When docs feel stale

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No open PR found | First-time run, will create new branch |
| Phase 3 finds issues | Loop back to Phase 2, fix, re-verify |
| Worktree missing | `git worktree add .claude/worktrees/docs-sync origin/main` |
| gh CLI fails | `gh auth status` and login if needed |
| Empty docs | Run Phase 2 with clean codebase |
| Merge conflicts | Manual merge, then re-run |

## File Locations

| Resource | Path |
|----------|------|
| Skill | `.claude/skills/sync-docs/` |
| Memory | `.claude/projects/.../memory/docs-sync.md` |
| Docs | `docs/` (root) |
| Initial PR | #70 on GitHub |

## Cron Job Info

- **Status**: Scheduled (Job ID: a24c4d8e)
- **Schedule**: Daily at 00:00 UTC
- **Duration**: ~5-15 min
- **Output**: PR URL or "no changes"
- **Expiry**: 3 days (recreate in new session)

## Skip Conditions

Exit without creating PR if:
- No code changes in past 7 days
- Docs already accurate (Phase 3 passes)
- Nothing to commit

## PR Lifecycle

```
Created (first run)
    ↓
Updated (append commits daily)
    ↓
Reviewed (human review)
    ↓
Merged (when approved)
    ↓
New PR created (next cycle)
```

## Related Documentation

- **Full Skill**: [SKILL.md](./SKILL.md)
- **Implementation**: [IMPLEMENTATION.md](./IMPLEMENTATION.md)
- **Examples**: [EXAMPLES.md](./EXAMPLES.md)
- **Overview**: [README.md](./README.md)

## Next Steps

1. [ ] Review SKILL.md workflow
2. [ ] Check current PR (#70)
3. [ ] Verify cron scheduled
4. [ ] Read memory file for state
5. [ ] Run `/sync-docs` to test
6. [ ] Review output and PR

---

**TL;DR**: `/sync-docs` keeps docs in sync with code daily. Two-pass review ensures accuracy. Creates/updates PR automatically.
