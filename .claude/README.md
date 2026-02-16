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

**When to use:**
- After making code changes that affect structure or patterns
- Before merging to verify code quality
- To get feedback on abstractions and organization
- When refactoring or adding new features

**What it does NOT do:**
- Does not test runtime behavior
- Does not run curl commands or manual tests
- Does not verify spec compliance (that's QA's job)

**How to invoke:**

```
Please use the code-review agent to analyze my recent code changes
for code quality and maintainability.
```

**Output:**
- Code review file at `.agents/code-review-N.md`
- Feedback on: readability, maintainability, type safety, code smells, patterns
- Branch: `u/code-review/review-N`

---

### quality-assurance

**Purpose:** Behavioral validation through testing

**Focus Areas:**
- Running automated test suite
- Manual testing against test plan
- Spec compliance verification
- Runtime security posture
- Integration behavior
- Error response validation

**When to use:**
- After completing a feature or bug fix
- After addressing QA feedback
- Before merging to verify behavior matches spec
- To validate security posture through testing

**What it does NOT do:**
- Does not analyze code structure or quality
- Does not comment on naming or abstractions
- Does not suggest code improvements

**How to invoke:**

For the first QA run:
```
Please use the quality-assurance agent to verify the application
behavior matches the spec. Run the full test plan.
```

For incremental QA after fixes:
```
I've addressed the issues in qa-report-2.md. Please use the
quality-assurance agent to re-test and verify the fixes.
```

**Output:**
- QA test report at `.agents/qa-report-N.md`
- Summary of automated and manual test results
- Security verification results
- Branch: `u/qa/qa-report-N`

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
- Launches both agents in parallel
- Reports completion with links to feedback files

See `.claude/skills/review-code.md` for full documentation.

### Manual Invocation

Alternatively, request both agents explicitly:

```
I've finished implementing the new feature. Please:

1. Use the code-review agent to analyze code quality
2. Use the quality-assurance agent to verify behavior matches the spec
```

**Typical workflow:**
1. Developer implements feature
2. Run `/review-code` (or invoke both agents manually)
3. **Code Review** → identifies code quality issues
4. **QA** → validates behavior against spec
5. Developer addresses both code quality and behavioral issues
6. Re-run review as needed
7. Merge agent branches when satisfied

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
- `.agents/code-review-N.md` — code quality review history
- `.agents/qa-report-N.md` — behavioral testing history
- `src/` — source code
- `dist/` — compiled output

## Branch Strategy

All agents use topic branches for isolation:
- Code Review: `u/code-review/review-N`
- QA: `u/qa/qa-report-N`

The human user is responsible for reviewing agent output and merging branches to main when appropriate.
