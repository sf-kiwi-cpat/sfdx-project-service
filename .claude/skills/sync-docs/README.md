# Docs-as-Code Skill

First-draft skill for automated documentation sync using a two-pass review process.

## What is This?

A reusable skill for keeping project documentation automatically in sync with codebase changes. Combines:
- **Code→Docs**: Generate documentation from current code
- **Docs→Code**: Verify documentation accuracy against source
- **PR Management**: Automatic PR creation and updates
- **Cron Integration**: Daily scheduled runs

## Files

### SKILL.md
Main skill definition with:
- When to use this skill
- Full process (5 phases)
- Exit conditions and key details
- Example output
- Troubleshooting

**Use this**: When you want the full workflow description

### IMPLEMENTATION.md
Technical implementation guide with:
- Architecture overview
- Each phase in detail (code patterns)
- PR creation templates
- Debugging tips
- Future enhancements

**Use this**: When implementing for a new project or understanding how it works

### EXAMPLES.md
Practical examples and patterns with:
- Usage examples
- Output examples (success, issues, no-changes)
- Code patterns for agents
- Troubleshooting workflows
- Integration checklist

**Use this**: For quick reference and common workflows

### README.md
This file - navigation and overview

## Quick Start

### Invoke the Skill
```bash
/sync-docs
```

### Schedule Daily
```bash
/loop 24h [sync-docs-prompt]
```

## Key Concepts

### Two-Pass Review

**Pass 1 (Code→Docs)**
- Analyzes codebase (routes, modules, recent changes)
- Generates or updates documentation
- Output: Changed files summary

**Pass 2 (Docs→Code)** *(Fresh Agent Context)*
- Reads all docs
- Cross-references with code
- Verifies accuracy
- Reports discrepancies

### Intelligent PR Management

- **Detects** existing open PR with "automated" label
- **Appends** commits to existing PR (no duplicates)
- **Creates** new PR only if none exist
- **Skips** if no changes detected

### Workflow

```
Cron/Manual Trigger
    ↓
PR Detection (existing or new branch)
    ↓
Phase 2: Code→Docs Generation (Agent A)
    ↓
Phase 3: Docs→Code Verification (Agent B)
    ↓
Issues Found? → Yes → Fix & Re-Verify
    ↓ No
Commit & Create/Update PR
    ↓
Return PR URL
```

## Project Integration

This skill was created for **SFDX Project Service** but is designed to be reusable for any project.

### Current Implementation
- **Project**: https://github.com/forcedotcom/sfdx-project-service
- **Initial PR**: #70 (created March 2026)
- **Cron Job**: Daily at midnight
- **Memory**: `.claude/projects/.../memory/docs-sync.md`

### How to Adapt

1. Copy skill to your project: `.claude/skills/sync-docs/`
2. Update doc file paths in SKILL.md Phase 2
3. Adjust code scanning patterns for your structure
4. Create initial PR with `/sync-docs`
5. Label with "automated"
6. Schedule cron job

## Related

- **PR #70**: Initial comprehensive documentation
- **Cron Job**: Job ID `a24c4d8e` (24h schedule)
- **Memory**: Session memory saved for future runs
- **Worktree**: `docs-sync` for isolated docs work

## For New Sessions

If you're inheriting this system:

1. **Check memory**: `/memory/docs-sync.md` has current state
2. **Review current PR**: Open PR with "automated" label
3. **Understand workflow**: Read SKILL.md
4. **Run manually**: `/sync-docs` to see it in action
5. **Schedule if needed**: `/loop 24h [prompt]` to recreate cron

## Limitations

- Requires well-documented code (JSDoc comments help)
- Works best with consistent code structure
- Examples can't be actually executed in verification
- May miss implicit behaviors

## Future Enhancements

- Execute code examples as actual tests
- Auto-generate from OpenAPI specs
- Architecture diagram generation
- Cross-linking between docs and code
- Coverage metrics
- Stale docs detection

## Testing

To test the skill in your environment:

1. **Mock run**: `git status` to ensure clean state
2. **Verify phases**: Review SKILL.md workflow
3. **Check PR ops**: Ensure `gh` CLI is authenticated
4. **Run skill**: `/sync-docs --create-pr` (optional flag)

## Contributing

To improve this skill:

1. Update SKILL.md with refined phases
2. Add patterns to IMPLEMENTATION.md
3. Include examples in EXAMPLES.md
4. Document gotchas and solutions

## License

This skill is part of SFDX Project Service (Apache 2.0)
