# Claude Code Agents for SF Project Service

This directory contains specialized agents for this project. Each agent encapsulates a specific process or expertise area.

## Available Agents

### code-review-bot

**Purpose:** Systematic code review against the spec and test plan

**When to use:**
- After completing a feature or bug fix
- After addressing previous review feedback
- Before merging changes to main
- When you want to verify security posture

**How to invoke:**

For the first review of new code:
```
Please perform a full code review of the current state of the codebase
using the code-review-bot agent.
```

For incremental review after addressing feedback:
```
I've addressed the findings in feedback-3.md. Please use the code-review-bot
agent to re-review my changes and verify the fixes.
```

**What it does:**
1. Reads the spec and prior feedback (if any)
2. Runs automated checks (TypeScript, ESLint, tests, build)
3. Analyzes source code for bugs, security issues, spec compliance
4. Performs manual testing (full test plan or targeted spot-checks)
5. Documents findings in `.agents/feedback-N.md`
6. Never modifies your code—only provides feedback

**Output:**
- Feedback file at `.agents/feedback-N.md`
- Summary with finding counts and priorities
- Evidence-based findings with severity classification

## Agent Guidelines

### What Agents Do
- Follow systematic, repeatable processes
- Document findings without implementing fixes
- Use the spec as the source of truth
- Provide evidence-based analysis
- Help developers learn through detailed feedback

### What Agents Don't Do
- Don't modify source code (unless explicitly instructed)
- Don't guess or assume—they verify against spec and tests
- Don't skip security checks
- Don't provide vague feedback

## Creating New Agents

To add a new agent for this project:

1. Create `.claude/agents/your-agent-name.md`
2. Start with a clear **Role** section
3. Document the **Process** step-by-step
4. Include **Decision Trees** for common choices
5. Provide **Examples** from this project
6. Add **Checklist** for completeness
7. Update this README with usage instructions

## Project Context

Key files agents should be aware of:
- `.agents/sf-project-service-spec.md` — spec is source of truth
- `.agents/q3-test-plan.md` — systematic QA process
- `.agents/feedback-N.md` — review history
- `src/` — source code
- `dist/` — compiled output
