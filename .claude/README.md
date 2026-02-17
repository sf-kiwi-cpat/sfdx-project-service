# Claude Code Agents for SF Project Service

This directory contains specialized agents for this project. Each agent encapsulates a specific process or expertise area.

## Available Agents

### code-review

**Purpose:** Static code analysis for code quality and maintainability

**Focus Areas:**
- Readability and naming
- Maintainability and abstractions
- Type safety and error handling patterns
- Code smells and duplication
- Consistency with project patterns
- Security code patterns (from a structural perspective)
- Input flow tracing for security risks

**When to use:**
- After making code changes that affect structure or patterns
- Before merging to verify code quality
- To get feedback on abstractions and organization
- When refactoring or adding new features

**What it does NOT do:**
- Does not test runtime behavior
- Does not run curl commands or manual tests
- Does not verify spec compliance (that's QA's job)
- Does not create branches (works on current branch)

**How to invoke:**

The code-review agent is typically launched via `/review-code` skill (see below). Manual invocation:

```
Please use the code-review agent to analyze my recent code changes
for code quality and maintainability.
```

**Output:**
- Intermediate draft at `.agents/.code-review-draft.md` (merged by skill into final report)
- Contributes to unified report at `.agents/review-N.md`
- No branches created (works on current branch)

---

### quality-assurance

**Purpose:** Behavioral validation through testing

**Focus Areas:**
- Running automated test suite
- Manual testing against test plan
- Spec compliance verification
- Runtime security posture (path traversal, restricted paths, credentials, error messages)
- Integration behavior
- Error response validation
- Adversarial input testing (malicious URLs, paths, strings)

**When to use:**
- After completing a feature or bug fix
- After addressing QA feedback
- Before merging to verify behavior matches spec
- To validate security posture through testing

**What it does NOT do:**
- Does not analyze code structure or quality
- Does not comment on naming or abstractions
- Does not suggest code improvements
- Does not create branches (works on current branch)

**How to invoke:**

The quality-assurance agent is typically launched via `/review-code` skill (see below). Manual invocation:

```
Please use the quality-assurance agent to verify the application
behavior matches the spec. Run the full test plan.
```

**Output:**
- Intermediate draft at `.agents/.qa-draft.md` (merged by skill into final report)
- Contributes to unified report at `.agents/review-N.md`
- No branches created (works on current branch)

---

## Using Both Agents Together

### Via Skill: /review-code

The easiest way to run both agents is using the `/review-code` skill:

```bash
# Review a pull request
/review-code 123

# Review current branch
/review-code current

# Review specific branch or commit
/review-code feature/my-branch
/review-code abc123f
```

This automatically:
- Fetches PR context via GitHub CLI (if reviewing a PR)
- Checks out the target branch/commit
- **Launches both agents in parallel on the current branch** (no topic branches)
- Merges findings from both agents into a single unified report
- Commits the report to the current branch
- Reports completion with link to the unified report

**Key difference from old workflow:**
- Both agents work on the **current branch** (no branch switching)
- Findings are merged into a **single report** (`.agents/review-N.md`)
- Report is **automatically committed** to the current branch
- No more separate `code-review-N.md` and `qa-report-N.md` files

See `.claude/skills/review-code.md` for full documentation.

### Manual Invocation

Alternatively, request both agents explicitly:

```
I've finished implementing the new feature. Please:

1. Use the code-review agent to analyze code quality
2. Use the quality-assurance agent to verify behavior matches the spec
```

**Typical workflow:**
1. Developer implements feature and commits to feature branch
2. Run `/review-code current`
3. **Code Review** → identifies code quality issues (writes to `.agents/.code-review-draft.md`)
4. **QA** → validates behavior and tests with adversarial inputs (writes to `.agents/.qa-draft.md`)
5. **Skill** → merges both drafts into unified `.agents/review-N.md` and commits to feature branch
6. Developer reviews unified report, reads all findings before fixing any
7. Developer addresses findings, considering implementation notes and second-order effects
8. Re-run `/review-code current` as needed
9. Merge feature branch to main when all findings resolved

## Agent Guidelines

### What Agents Do
- Follow systematic, repeatable processes
- Document findings without implementing fixes
- Use the spec as the source of truth (QA) or context (Code Review)
- Provide evidence-based analysis
- Help developers learn through detailed feedback
- Use topic branches for isolation

### What Agents Don't Do
- Don't modify source code (unless explicitly instructed)
- Don't guess or assume—they verify through analysis or testing
- Don't provide vague feedback
- Don't commit directly to main

## Creating New Agents

To add a new agent for this project:

1. Create `.claude/agents/your-agent-name.md`
2. Start with a clear **Role** section (what the agent is)
3. Define **Core Principles** (how it operates)
4. Document the **Process** step-by-step
5. Include **Decision Trees** for common choices
6. Provide **Examples** from this project
7. Add **Checklist** for completeness
8. Update this README with usage instructions

## Project Context

Key files agents should be aware of:
- `.agents/sf-project-service-spec.md` — spec is source of truth
- `.agents/q3-test-plan.md` — systematic QA process
- `.agents/review-N.md` — unified review reports (code quality + behavioral testing)
  - `.agents/.code-review-draft.md` — intermediate (code-review agent's findings during analysis)
  - `.agents/.qa-draft.md` — intermediate (QA agent's findings during analysis)
  - These drafts are merged by the skill and should not be manually edited
- `src/` — source code
- `dist/` — compiled output

## Workflow Notes

**Single-branch operation:**
- Agents work on the **current branch**, no topic branches
- Both agents write intermediate drafts (`.code-review-draft.md`, `.qa-draft.md`)
- The `/review-code` skill merges these into `.agents/review-N.md`
- The skill commits the final report to the current branch

**Report files in `.agents/`:**
- `.agents/review-N.md` — generated by skill, contains both agents' findings
- `.agents/.code-review-draft.md` — intermediate file, deleted after merge
- `.agents/.qa-draft.md` — intermediate file, deleted after merge
- These files should not be manually edited

**When reviewing findings:**
- Read all findings before addressing any — some interact with each other
- Review the "Implementation Notes" section for second-order effects
- Consider dependencies between fixes
