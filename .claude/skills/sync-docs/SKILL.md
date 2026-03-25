---
name: sync-docs
description: Keep documentation in sync with codebase changes. Generates, reviews, and maintains docs through a two-pass verification process, creating or updating PRs automatically.
---

# Sync Docs

Keep SF Project Service documentation automatically in sync with codebase via a **two-pass review process**: code→docs generation, then docs→code verification.

## When to use

- Running the daily documentation sync job
- Manually updating docs after significant code changes
- Verifying documentation accuracy against current codebase
- Creating or updating PR with documentation changes
- Ensuring docs reflect new APIs, architecture, or features

## Process

### Phase 1: PR Management
```bash
gh pr list --state open --label "automated" -L 1
```

- **If open PR found**: Switch to that branch, append updates
- **If no open PR**: Create fresh branch `docs-sync-[timestamp]`
- **Label new PRs**: Add "automated" label for future detection

### Phase 2: Code→Docs Generation
Analyze codebase and generate/update documentation:

1. **Code Analysis**
   - Scan `src/`, `src/routes/`, `src/domain/` for current structure
   - Review recent commits (7 days or since last update)
   - Identify changes: new endpoints, refactored modules, architecture updates

2. **Documentation Updates**
   - **README.md**: Project overview, quick start, tech stack (regenerate)
   - **api.md**: Endpoint specs from route files (regenerate)
   - **architecture.md**: System design reflecting current structure (regenerate)
   - **development.md**: Setup/testing (update if changes detected)
   - **modules.md**: Module reference from source code (regenerate)
   - **api-examples.md**: Keep unless outdated (verify still works)

3. **Output Summary**
   - List files changed/created
   - Summarize what code changed
   - Highlight breaking changes if any

### Phase 3: Docs→Code Verification (Fresh Context)
Use a separate agent to verify documentation accuracy:

1. **Read Documentation**
   - Parse all files in `/docs/`
   - Extract: endpoints, architecture, module descriptions, examples

2. **Cross-Reference Code**
   - Read route handlers in `src/routes/`
   - Read domain modules in `src/domain/` (or `src/` if not reorganized)
   - Verify implementations match docs

3. **Accuracy Checks**
   - ✓ API endpoints exist and methods match
   - ✓ Parameter names and types are correct
   - ✓ Response schemas reflect actual responses
   - ✓ Architecture diagram is current
   - ✓ Module descriptions match implementations
   - ✓ Examples run without errors (conceptually)
   - ✓ No outdated or removed APIs documented

4. **Report Findings**
   - List discrepancies found
   - Prioritize: breaking docs inconsistencies first
   - Flag items that need fixing

### Phase 4: Fix & Commit
If Phase 3 found issues:
- Loop back to Phase 2
- Fix identified discrepancies
- Run Phase 3 again (or assume fixed)

If Phase 3 passed or only minor notes:
1. Stage changes: `git add docs/`
2. Commit with message: `docs: keep in sync with codebase`
3. If updating existing PR: Push to update it
4. If creating new PR:
   - Push branch: `git push -u origin [branch]`
   - Create PR via `gh pr create`
   - Add automated label: `gh pr edit --add-label automated`
   - Include pass results in PR description

### Phase 5: Return Result
- **Output**: PR URL if created/updated
- **Output**: "No changes detected" if nothing changed
- **Note**: Include pass results and any remaining notes

## Exit Conditions

**Stop and report "No changes":**
- Phase 2 detects zero code changes
- Phase 3 finds no docs inconsistencies
- Nothing to commit

**Continue to PR:**
- Phase 2 generated doc changes
- Phase 3 verified accuracy (or issues fixed)
- Ready to commit and PR

## Key Details

- **Worktree**: Use `docs-sync` if available
- **Base branch**: Always `main`
- **Labels**: New PRs get "automated" label
- **Detection**: Look for existing open PR via label
- **No duplicates**: Append to open PR, don't create new one
- **gh CLI**: Required for PR operations

## Cron Job Integration

This skill runs automatically via `/loop 24h` cron job:
- Executes daily at midnight
- Runs full two-pass workflow
- Updates or creates PR automatically
- Job expires after 3 days (recreate in new sessions)

To manually trigger or debug:
```bash
/sync-docs
```

## Example Output

```
✓ Pass 1 (Code→Docs): Generated 2 files, updated 3
  - New: arch-diagram.md
  - Updated: api.md (2 endpoints added)
  - Updated: modules.md (new Deploy module)

✓ Pass 2 (Docs→Code): Verified accuracy
  - All endpoints match code
  - 1 example needs update (noted in PR)

✓ PR created: https://github.com/forcedotcom/sfdx-project-service/pull/71
  - Branch: docs-sync-1710705600
  - Label: automated
```

## Troubleshooting

**"No open PR found, creating new one"**
- Expected on first run
- PR will be labeled "automated" for future detection

**Phase 3 finds discrepancies**
- Loop back to Phase 2
- Fix issues and re-run Phase 3
- Only create PR after verification passes

**Worktree doesn't exist**
- Create: `git worktree add .claude/worktrees/docs-sync origin/main`
- Install: `npm install` in worktree
- Re-run skill

**gh CLI issues**
- Verify auth: `gh auth status`
- Login if needed: `gh auth login`

## Related

- **Cron job**: `/loop 24h [docs-sync-prompt]`
- **Memory**: `/memory/docs-sync.md`
- **PR**: https://github.com/forcedotcom/sfdx-project-service/pull/70 (initial docs)
