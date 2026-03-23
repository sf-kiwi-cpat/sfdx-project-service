---
name: docs-standards
description: >-
  Audit documentation for structural compliance with the documentation
  architecture. Use when reviewing doc changes, after sync-docs runs,
  or when creating new documentation files.
argument-hint: "[optional: specific file to audit, or 'all']"
disable-model-invocation: false
allowed-tools: Read, Glob, Grep, Bash(wc *)
---

# /docs-standards — Audit Documentation Structure

You audit the repository's documentation against the rules defined in
`docs/DOCUMENTATION-ARCHITECTURE.md`. Your job is to find violations and
report them clearly — you do not fix them.

## Modes

**No arguments** → Audit all documentation files
**With arguments** → Audit a specific file (e.g., `/docs-standards CLAUDE.md`)

## Workflow

### Step 1: Load the Standards

Read `docs/DOCUMENTATION-ARCHITECTURE.md` in full. This is your source of truth
for every check that follows. Extract:

- The file inventory table (which files should exist, their audience, purpose, maintainer)
- The CLAUDE.md scope rules (what belongs vs. what doesn't)
- The CONTRIBUTING.md scope rules (thin orientation, max ~50 lines)
- The anti-patterns list
- The decision framework (where new content should go)

### Step 2: Inventory Check

Use `Glob` to find all `.md` files in the repo root and `docs/` directory.
Compare against the inventory table from the architecture doc.

Check for:
- **Unknown files**: `.md` files not listed in the inventory → flag as "not in inventory"
- **Missing files**: Files listed in the inventory but not found on disk → flag as "missing"

### Step 3: Scope Compliance

Read the checklist from `.claude/skills/docs-standards/CHECKLIST.md`, then
audit each file against its declared purpose. For each file:

1. Read the file
2. Check that its content matches its declared scope
3. Flag content that belongs in a different file per the decision framework

Pay special attention to:
- **CLAUDE.md**: Should be under 120 lines. Should contain dev commands, git
  hooks, CDD skill list, concise label lifecycle, directory layout, guardrail
  rules, git conventions, and worktree gotchas. Should NOT contain full workflow
  walkthroughs, loop setup instructions, troubleshooting, or Docker commands.
- **CONTRIBUTING.md**: Should be under 60 lines. Thin orientation with links
  to `docs/`. Should NOT contain detailed instructions.

### Step 4: Link Integrity

For each markdown link `[text](path)` in the audited files:
- Verify the target file exists
- Verify anchor links (e.g., `#docker`) point to an actual heading in the target

### Step 5: Duplication Detection

Scan for content that appears in substantially similar form in multiple files.
Common duplication patterns:
- npm commands repeated across CLAUDE.md, README.md, and docs/development.md
- Docker instructions in multiple places
- Workflow descriptions in both CLAUDE.md and docs/workflow-guide.md

### Step 6: Report

Present findings organized by severity:

**Violations** (must fix):
- Unknown files not in inventory
- Content in wrong file per scope rules
- Broken links
- CLAUDE.md or CONTRIBUTING.md exceeding size budgets

**Warnings** (should fix):
- Content duplication across files
- Missing inventory entries for new files
- Stale links to removed content

**Compliant**: List files that pass all checks.

Format each finding as:
```
[VIOLATION|WARNING] file:line — description
  Suggestion: what to do about it
```

## When to Run

- After any PR that modifies `.md` files
- After `/sync-docs` completes a regeneration pass
- When creating new documentation files
- As part of periodic documentation health checks
