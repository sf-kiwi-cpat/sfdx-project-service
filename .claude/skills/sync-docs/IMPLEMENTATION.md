# Implementation Guide: Docs-as-Code System

This guide documents how to implement the two-pass documentation sync system for SF Project Service or similar projects.

## Architecture Overview

```
Cron Job (24h)
    ↓
    ├─→ Phase 1: PR Management
    │   └─→ Detect/create docs PR
    │
    ├─→ Phase 2: Code→Docs (Agent A)
    │   └─→ Generate/update docs from code
    │
    ├─→ Phase 3: Docs→Code (Agent B - Fresh Context)
    │   └─→ Verify docs against code
    │
    ├─→ Phase 4: Fix & Iterate
    │   └─→ Loop if issues found
    │
    └─→ Phase 5: Commit & PR
        └─→ Create/update PR
```

## Phase 1: PR Management

### Detection Pattern

```bash
gh pr list --state open --label "automated" --head "docs-sync*" -L 1
```

**Output parsing:**

- If results: Extract PR number and branch name
- If empty: Create fresh branch

### Branch Creation

```bash
# New branch with timestamp
git checkout -b docs-sync-$(date +%s)

# Or use EnterWorktree for isolation
git worktree add .claude/worktrees/docs-sync origin/main
cd .claude/worktrees/docs-sync
```

### PR Operations

```bash
# Create new PR
gh pr create --title "docs: keep in sync with codebase" \
  --body "..." \
  --label "automated" \
  --assignee @me

# Update existing PR (push new commits)
git push origin [branch]

# Add label to new PR
gh pr edit [pr-number] --add-label automated
```

## Phase 2: Code→Docs Generation

### Code Analysis Pattern

1. **File Structure Scanning**

   ```bash
   find src/ -name "*.ts" -not -name "*.test.ts" -not -name "*.integration.test.ts"
   ```

2. **Route Discovery**

   ```typescript
   // Extract from route files:
   // - router.get('/path', ...)
   // - router.post('/path', ...)
   // - JSDoc @openapi comments
   ```

3. **Module Inventory**

   ```typescript
   // For each src/domain/*.ts (or src/*.ts):
   // - exports { functionName, TypeName, ClassName }
   // - Read docstrings and types
   // - Extract signatures
   ```

4. **Recent Changes**
   ```bash
   git log --oneline --since="7 days ago" -- src/
   ```

### Documentation Generation

**README.md Template:**

```markdown
# Project Name

## Quick Start

[From package.json scripts]

## Architecture

[From architecture analysis]

## API Endpoints

[From route discovery]

## Project Structure

[From file scanning]

## Links

[Cross-references to other docs]
```

**api.md Template:**

```markdown
## Endpoints

For each route:

- Path and method
- JSDoc @openapi spec if available
- Request/response examples
- Status codes and errors
```

**modules.md Template:**

```markdown
## Module: [name]

For each export:

- Function/class name
- Type signature
- Description from docstring
- Usage example
```

### Key Implementation Tips

- **No re-inventing**: Parse existing JSDoc comments from routes
- **Example freshness**: Verify example code still parses/compiles
- **Type extraction**: Use TypeScript AST if available, else regex patterns
- **Git history**: Use `git log` to understand what changed

## Phase 3: Docs→Code Verification (Fresh Agent)

### Verification Checklist

```javascript
const checks = [
  {
    category: 'API Endpoints',
    items: [
      'All endpoints in api.md exist in route files',
      'HTTP methods match (GET vs POST, etc)',
      'Path parameters documented correctly',
      'Request body fields match actual validation',
      'Response schema matches actual responses',
      'Status codes match error handling',
    ],
  },
  {
    category: 'Architecture',
    items: [
      'System diagram is current',
      'Data flow reflects actual code',
      'Module responsibilities match implementations',
      'Security model documented',
      'Deployment model is accurate',
    ],
  },
  {
    category: 'Examples',
    items: [
      'Code examples compile/run (conceptually)',
      'API examples match current endpoints',
      'Environment variables are current',
      'No deprecated patterns used',
    ],
  },
  {
    category: 'Completeness',
    items: [
      'New features documented',
      'Removed features removed from docs',
      'All public APIs documented',
      'No placeholder text',
    ],
  },
];
```

### Discrepancy Reporting

Format for returning issues:

```
## Issues Found (Priority Order)

### 🔴 High: Breaking Inconsistencies
- [Issue description]
- [Location in docs]
- [What code shows]
- [Fix needed]

### 🟡 Medium: Minor Discrepancies
- [Issue description]

### 🟢 Low: Notes
- [Observation]
```

### Agent Context

The verification agent should:

- Read documentation with fresh perspective
- Reference source code directly
- Not make assumptions
- Report only verifiable discrepancies
- Include line references to both docs and code

## Phase 4: Fix & Iterate

### If Issues Found

1. Agent A (Code→Docs) receives issues list
2. Re-analyzes code with issues in mind
3. Updates docs to fix discrepancies
4. Commits with message: `docs: fix verification issues (attempt N)`
5. Trigger Agent B (Docs→Code) again
6. If still issues, loop up to 3 times then report

### Stopping Condition

- All verifications pass, OR
- Same issues persist after 3 loops, OR
- New issues emerge (regression detection)

## Phase 5: PR Creation

### Commit Message Format

**For initial docs:**

```
docs: add comprehensive project documentation

Add documentation for:
- API endpoints and examples
- Architecture and design
- Module reference and examples
- Development setup and testing
- Deployment considerations
```

**For updates:**

```
docs: keep in sync with codebase

Changes in this sync:
- Added: New endpoint documentation
- Updated: Module reference (3 modules)
- Fixed: Verification issues (2)

Verification: Pass 1 + Pass 2 ✓
```

### PR Description Template

```markdown
## Summary

Automated documentation sync keeping docs in sync with codebase.

## Changes

### Pass 1 (Code→Docs)

- Generated/updated X files
- New content: Y
- Updated content: Z

### Pass 2 (Docs→Code)

- Verification: ✓ PASSED / ✗ ISSUES
- Issues found: [List if any]
- Issues fixed: [List if any]

## Files Changed

[List of doc files]

## Related

- Codebase commits: [refs]
- Previous PR: [if appending]

---

_This PR was created by the automated documentation sync system._
```

## Integration Patterns

### With Cron Jobs

```bash
/loop 24h [full-sync-docs-prompt]
```

The cron job should:

1. Detect/create worktree
2. Run full workflow
3. Return PR URL or "no changes"
4. Auto-retry on failure (optional)

### With CI/CD

Optional: Verify docs in CI

```yaml
- name: Verify docs
  run: |
    # Run Phase 3 verification as test
    # Fail if discrepancies found
```

### Manual Trigger

Users can run manually:

```bash
/sync-docs
```

Or with options:

```bash
/sync-docs --create-pr --force --verify-only
```

## Code Patterns for Agents

### Reading Routes (Agent A)

```typescript
// Pseudo-code for Agent A
const routes = findFiles('src/routes/*.ts');
routes.forEach((file) => {
  const content = readFile(file);
  const endpoints = extractRoutes(content);
  // router.get('/path', ...)
  // Extract JSDoc comments above
  // Extract path params, query, body
});
```

### Comparing Docs to Code (Agent B)

```typescript
// Pseudo-code for Agent B
const docs = readFile('docs/api.md');
const routes = readFile('src/routes/projects.routes.ts');

docs.endpoints.forEach((endpoint) => {
  const codeEndpoint = routes.find((ep) => ep.path === endpoint.path);
  if (!codeEndpoint) {
    report('Missing endpoint in code');
  } else if (codeEndpoint.method !== endpoint.method) {
    report('Method mismatch');
  }
  // ... more checks
});
```

## Limitations & Future Work

### Current Limitations

- Requires well-documented code (JSDoc comments help)
- Works best with consistent code structure
- May miss implicit behaviors
- Examples can't be actually executed

### Future Enhancements

- Actual example execution via tests
- AI-powered architecture diagram generation
- Integration with API specs (OpenAPI)
- Cross-linking between docs and code
- Metrics on docs coverage
- Automated detection of stale docs

## Debugging

### Check Worktree Status

```bash
git worktree list
git -C /path/to/worktree status
```

### Check PR Detection

```bash
gh pr list --state open --label "automated" -L 10
```

### Manual Phase Execution

```bash
# Phase 2 only (dry-run)
git diff docs/ # see what would change

# Phase 3 only
# Re-read docs and cross-check manually
```

### View Job Status

```bash
# In Claude Code session
/tasks  # See current running tasks
```

## References

- [Skill Definition](./SKILL.md)
- [Cron Job Setup](#)
- [Memory: docs-sync.md](#)
- [PR #70: Initial docs](https://github.com/forcedotcom/sfdx-project-service/pull/70)
