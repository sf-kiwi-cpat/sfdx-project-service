# Documentation Standards Checklist

Structured checks used by the `/docs-standards` skill. Each section maps to
a step in the audit workflow.

## Inventory compliance

- [ ] Every `.md` file in repo root and `docs/` appears in the inventory
      table in `docs/DOCUMENTATION-ARCHITECTURE.md`
- [ ] Every file listed in the inventory table exists on disk
- [ ] Each file's declared maintainer (manual vs. sync-docs) is accurate

## Scope compliance

### CLAUDE.md
- [ ] Contains: dev commands (npm scripts)
- [ ] Contains: git hook behavior (pre-commit, pre-push)
- [ ] Contains: CDD skill list
- [ ] Contains: label lifecycle (concise state machine)
- [ ] Contains: directory layout (src/, spec/, tests/)
- [ ] Contains: guardrail rules (spec/ human-guarded, tests/ agent-mutable)
- [ ] Contains: worktree npm install gotcha
- [ ] Contains: git conventions (branches, commits, PRs)
- [ ] Contains: link to docs/workflow-guide.md for full workflow details
- [ ] Does NOT contain: full workflow walkthrough (> 5 lines)
- [ ] Does NOT contain: monitor loop setup instructions
- [ ] Does NOT contain: troubleshooting guides
- [ ] Does NOT contain: Docker build/run commands
- [ ] Line count is around 120 or less (guideline, not a hard gate)

### CONTRIBUTING.md
- [ ] Contains: prerequisites list
- [ ] Contains: quick-start commands (clone, install, dev, test)
- [ ] Contains: brief workflow summary with link to docs/workflow-guide.md
- [ ] Contains: further reading links to docs/
- [ ] Does NOT contain: detailed instructions (> 2 sentences per topic)
- [ ] Does NOT contain: content duplicated from docs/development.md
- [ ] Line count is around 60 or less (guideline, not a hard gate)

### docs/workflow-guide.md
- [ ] Contains: all five CDD skills with correct names
- [ ] Contains: what you do vs. what agents do
- [ ] Contains: label lifecycle with feedback states
- [ ] Contains: monitor loop setup (three loops)
- [ ] Contains: rules (spec/ human-guarded, etc.)
- [ ] Contains: troubleshooting section

### docs/README.md
- [ ] Links section includes all docs/ files
- [ ] Quick start section matches actual npm scripts

## Link integrity

- [ ] All `[text](path)` links resolve to existing files
- [ ] All `[text](path#anchor)` links point to existing headings
- [ ] No orphan links to files that have been renamed or deleted

## Duplication detection

Common patterns to check:
- [ ] npm commands not repeated verbatim across CLAUDE.md, README.md, and
      docs/development.md (brief mentions OK, full code blocks = duplication)
- [ ] Docker instructions only in docs/development.md (others link to it)
- [ ] Workflow descriptions not duplicated between CLAUDE.md and
      docs/workflow-guide.md (CLAUDE.md has the state machine, workflow
      guide has the walkthrough)
- [ ] Worktree instructions not duplicated (CLAUDE.md has the agent gotcha,
      docs/development.md has setup steps)
