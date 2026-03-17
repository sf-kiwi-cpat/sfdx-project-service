# Examples & Patterns

Quick reference for using and implementing the docs-as-code system.

## Usage Examples

### Invoke the Skill

```bash
/sync-docs
```

Runs full workflow: PR detection → Code→Docs → Docs→Code verification → PR.

### Via Cron Job

Scheduled daily at midnight:
```bash
/loop 24h [sync-docs-prompt]
```

### Manual Phases (Debug)

```bash
# Just generate docs (Phase 2)
# Agent reads code, updates docs, outputs summary

# Just verify docs (Phase 3)
# Agent reads docs and code, reports discrepancies
```

## Output Examples

### Successful Run

```
✓ Phase 1: PR Detection
  Found open PR #70 (automated label)
  Branch: worktree-docs-sync

✓ Phase 2: Code→Docs Generation
  Analyzed: 8 route files, 5 domain modules
  Recent changes: 2 endpoints added, 1 module refactored
  Generated:
    - Updated: api.md (added POST /projects/:id/notify endpoint)
    - Updated: modules.md (new NotificationModule)
    - Updated: architecture.md (notification flow diagram)
  Summary: 3 files changed, 47 lines added

✓ Phase 3: Docs→Code Verification
  Verified: 12 endpoints, 8 modules, 3 examples
  Result: ✓ PASSED
  - All endpoints match code
  - Response schemas accurate
  - Architecture diagram current
  - Examples valid

✓ Phase 4: Commit & PR
  Committed: docs: keep in sync with codebase
  Updated PR #70 with new changes
  Result: https://github.com/forcedotcom/sf-project-service/pull/70

✓ Complete: PR ready for review
```

### Issues Found & Fixed

```
✓ Phase 2: Code→Docs Generation
  Updated: 4 files

✓ Phase 3: Docs→Code Verification
  Issues found (1):
    🔴 api.md line 45: POST /projects endpoint docs outdated
       - Docs say: template field required
       - Code shows: template field required (correct but example is old)

✗ Verification FAILED: 1 issue to fix

→ Looping to Phase 2 to fix issues...

✓ Phase 2: Code→Docs Generation (Attempt 2)
  Fixed: api.md (updated POST /projects example)
  New summary: 1 file changed

✓ Phase 3: Docs→Code Verification (Attempt 2)
  Result: ✓ PASSED
  All issues resolved

✓ Complete: PR updated and verified
```

### No Changes Detected

```
✓ Phase 1: PR Detection
  No open PR with "automated" label found
  Created branch: docs-sync-1710705600

✓ Phase 2: Code→Docs Generation
  Analyzed: codebase
  Recent commits: 0 changes in src/
  Result: No changes detected

Exit: No documentation changes needed
```

## Code Patterns

### Agent A: Code→Docs Generation

**Pattern for extracting endpoints:**

```typescript
// Read src/routes/projects.routes.ts
// Find all router.METHOD('/path', ...) calls
// Extract JSDoc comments above each route
// Build endpoint documentation

// Example output:
{
  method: 'POST',
  path: '/projects',
  summary: 'Create a new project from a template',
  params: { body: { template: 'string' } },
  response: { status: 201, body: { id: 'string (uuid)' } }
}
```

**Pattern for module documentation:**

```typescript
// Read src/domain/projects.ts
// Extract exports
// For each export:
//   - Read type signature
//   - Extract JSDoc comment
//   - Find usage examples in tests
//   - Generate module doc

// Example output:
{
  name: 'createProject',
  type: 'async function',
  signature: '(templateId: string): Promise<string>',
  description: 'Creates a new project by unzipping a template...',
  example: 'const projectId = await createProject("minimal");'
}
```

### Agent B: Docs→Code Verification

**Pattern for endpoint verification:**

```typescript
// For each endpoint in docs/api.md:
//   1. Read endpoint spec (path, method, params)
//   2. Find matching route in src/routes/*.ts
//   3. Check: method matches, params valid, response schema correct
//   4. Report any mismatches

// Example check:
docs.endpoints.forEach(endpoint => {
  const code = findRouteInCode(endpoint.path, endpoint.method);
  if (!code) report(`Endpoint ${endpoint.path} not found in code`);
  if (code.method !== endpoint.method) report(`Method mismatch`);
  if (!matchesResponseSchema(code, endpoint.response)) report(`Response mismatch`);
});
```

**Pattern for architecture verification:**

```typescript
// Check architecture.md against actual structure:
//   1. Verify module layout matches documentation
//   2. Check data flow diagram reflects code flow
//   3. Verify security claims are implemented
//   4. Check deployment model is achievable

// Example check:
if (docs.architecture.modules.includes('NotificationService')) {
  if (!fileExists('src/domain/notification-service.ts')) {
    report('NotificationService documented but not implemented');
  }
}
```

## PR Management Examples

### Creating New PR

```bash
# After Phase 2 & 3 complete successfully:
git add docs/
git commit -m "docs: keep in sync with codebase"
git push -u origin docs-sync-1710705600

gh pr create \
  --title "docs: keep in sync with codebase" \
  --body "Pass 1: Code→Docs ✓ / Pass 2: Docs→Code ✓" \
  --label "automated"
```

Result: PR #71 created

### Updating Existing PR

```bash
# Same branch already exists, just push new commits:
git add docs/
git commit -m "docs: fix verification issues"
git push origin docs-sync-1710705600

# PR #70 automatically updated with new commit
```

## Troubleshooting Examples

### Issue: Phase 3 Reports Discrepancies

```
🔴 api.md line 89: GET /projects/:id/tree endpoint docs wrong
   Expected: 404 if project not found
   Found in code: Returns 404 with RFC 9457 Problem Detail

Fix: Update docs/api.md line 89-95 to show RFC 9457 response
```

**Resolution:**
- Agent A re-reads code around line 89 in projects.routes.ts
- Sees: `res.status(404).contentType(PROBLEM_JSON).json(problemDetail(...))`
- Updates docs to show actual RFC 9457 response
- Agent B verifies fix
- PR updated

### Issue: Worktree Missing

```
git worktree list
# No docs-sync worktree found

Solution:
git worktree add .claude/worktrees/docs-sync origin/main
cd .claude/worktrees/docs-sync
npm install
```

### Issue: PR Detection Fails

```
gh pr list --state open --label "automated" -L 1
# No output

Solution:
Create new branch and PR as if first-time
gh pr create ... --label "automated"
```

## Integration Checklist

- [ ] Skill defined in `.claude/skills/sync-docs/SKILL.md`
- [ ] Implementation guide created
- [ ] Examples documented (this file)
- [ ] Cron job scheduled: `/loop 24h [prompt]`
- [ ] Memory saved: `/memory/docs-sync.md`
- [ ] Initial PR created with docs
- [ ] "automated" label applied to PR
- [ ] Team aware of docs-as-code process

## Common Workflows

### First-Time Setup

1. Create worktree: `git worktree add .claude/worktrees/docs-sync origin/main`
2. Generate initial docs with Phase 2
3. Verify with Phase 3
4. Create PR with initial docs
5. Label with "automated"
6. Schedule cron job

### Ongoing Maintenance

Each day at midnight:
1. Cron job triggers `/sync-docs`
2. Detects open "automated" PR
3. Generates updated docs from new code changes
4. Verifies accuracy
5. Appends commit to existing PR (or creates new if PR merged)

### After Code Refactor

1. Manually trigger `/sync-docs` or wait for cron
2. Phase 2 detects significant changes
3. Phase 3 may find discrepancies (expected after refactor)
4. Fixes applied, PR updated
5. Review and merge when ready

### Merging & Cleanup

```bash
# After PR review and approval:
gh pr merge [pr-number]

# Next cron job will:
# - Detect no open "automated" PR
# - Create new branch for next sync
# - Continue cycle
```

## References

- [Skill Definition](./SKILL.md)
- [Implementation Guide](./IMPLEMENTATION.md)
- [Project Memory](../../memory/docs-sync.md)
- [PR #70 Example](https://github.com/forcedotcom/sf-project-service/pull/70)
