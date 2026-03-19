---
name: implement
description: Implement code to make contract tests pass. Writes production code to satisfy spec tests and creates supporting unit/integration tests. Never modifies spec files (human-guarded).
argument-hint: <path-to-contract.spec.ts>
disable-model-invocation: false
allowed-tools: Agent, Read, Glob, Bash, Write, Edit
---

# /implement — Write Code to Satisfy Contracts

You are the implementation orchestrator. Your job is to write code that makes contract tests pass while respecting human-guarded boundaries.

## Mode

Takes a single argument: path to a `contract.spec.ts` file

```bash
/implement spec/deploy/contract.spec.ts
```

## Workflow

### Step 0: Label Transition (Automated Loop Entry)
If called via Loop 1, remove `spec:approved` label and add `impl:in-progress`:
```bash
ISSUE_NUMBER=$(git branch --show-current | grep -oP 'issue-\K\d+')
gh issue edit $ISSUE_NUMBER --remove-label spec:approved --add-label impl:in-progress

PR_NUMBER=$(gh pr list --head $(git branch --show-current) --json number -q '.[0].number')
if [ -n "$PR_NUMBER" ]; then
  gh pr edit $PR_NUMBER --remove-label spec:approved --add-label impl:in-progress
fi
```

### Step 1: Parse the Contract
- Read the contract file (`.spec.ts`)
- Extract test structure:
  - What endpoints are tested?
  - What request/response formats?
  - What error cases?
  - What assertions must pass?
- Summarize the contract requirements

### Step 2: Analyze Current State
- Check if implementation already exists
- If yes: understand current state, identify gaps
- If no: plan what needs to be created
- Identify affected files (routes, domain, types, etc.)

### Step 3: Plan Implementation
- Outline changes needed to make tests pass
- Identify dependencies between tests
- Plan test execution order
- Note any blockers or uncertainties

### Step 4: Implement
- Write production code
- Write supporting unit/integration tests
- Make all contract tests pass
- Maintain or improve code quality

### Step 5: Verify
- Run `npm test` to confirm all tests pass
- Check coverage threshold (90% on main, 85% on branches)
- Verify contract tests specifically pass
- Run linter to check code quality

### Step 6: Push and Update Labels
- Commit changes
- Push to remote
- Update workflow labels:
  ```bash
  ISSUE_NUMBER=$(git branch --show-current | grep -oP 'issue-\K\d+')
  PR_NUMBER=$(gh pr list --head $(git branch --show-current) --json number -q '.[0].number')

  if [ -n "$ISSUE_NUMBER" ]; then
    gh issue edit $ISSUE_NUMBER --remove-label impl:in-progress --add-label impl:ready
  fi

  if [ -n "$PR_NUMBER" ]; then
    gh pr edit $PR_NUMBER --remove-label impl:in-progress --add-label impl:ready
  fi
  ```

### Step 7: Report
- Show what was implemented
- Confirm all contract tests pass
- Highlight any warnings or issues
- Notify that code is ready for review (Loop 2 will detect `impl:ready` and run `/review`)

---

## Key Constraints

### CANNOT Modify

- **Any `spec/*.spec.ts` files** — Contract tests are human-guarded
- **Any `spec/*.spec.md` files** — Derived specs are read-only
- **Anything in `spec/*/` except implementation artifacts**

### CAN Modify

- **Production code** — `src/` files (domain, routes, types, etc.)
- **Unit tests** — `tests/unit/` (quality tooling, agent-mutable)
- **Integration tests** — `tests/integration/` (quality tooling, agent-mutable)
- **Configuration files** — tsconfig, vitest.config, etc. (if needed)

### MUST Satisfy

- All contract tests must pass (non-negotiable)
- Code quality checks must pass (eslint, prettier)
- Coverage threshold must be met (90% on main, 85% on branches)
- Tests must be deterministic (no flaky tests)

---

## Important Principles

### Test-Driven
- Contract tests are source of truth
- Implement to make tests pass, not the reverse
- If a test seems wrong, flag it for human review (don't work around it)

### Quality as Goal
- Don't just make tests pass; write good code
- Consider edge cases, error handling, performance
- Add unit/integration tests beyond contract requirements
- Keep code maintainable and well-structured

### Transparency
- Show what changed and why
- Report any uncertainties or decisions made
- Highlight trade-offs or design choices
- Ask for human review before risky changes

### Constraints Are Features
- Can't modify spec files? Good — prevents accidental breakage
- Must pass all tests? Good — ensures correctness
- Can't modify human-guarded files? Good — enforces discipline

---

## Pre-Implementation Checklist

Before starting implementation:

1. ✓ Contract file exists and is readable
2. ✓ Contract tests run (even if they fail)
3. ✓ No syntax errors in contract
4. ✓ Understand what the contract expects
5. ✓ Identify all affected files
6. ✓ Know the project structure and conventions
7. ✓ Have access to all necessary dependencies

---

## Standalone Usage

This skill is designed to work independently. You can use it without `/brief` or `/spec`:

```bash
# Example: Implement from any contract spec
/implement spec/custom-feature/contract.spec.ts

# Even if contract was created outside this workflow
/implement /path/to/any/contract.spec.ts
```

The only requirement: a valid contract spec file with tests.

---

## Integration with Workflow

The skill is part of: **Brief → Spec → Implement**

- **Brief** (`/brief`) — Gathers context, helps pick work
- **Spec** (`/spec`) — Defines executable contracts (code + prose)
- **Implement** (`/implement`) — Writes code to satisfy contracts

Typical flow: `/brief` → `/spec` → `/implement`

But each skill can be used independently with other tools.

**Automated Loop Integration:**
- Loop 1 monitors for `spec:approved` labels on PRs
- When detected, Loop 1 finds the worktree and runs `/implement` automatically
- `/implement` removes `spec:approved`, adds `impl:in-progress` at start
- `/implement` removes `impl:in-progress`, adds `impl:ready` at end
- Loop 2 then detects `impl:ready` and runs `/review` automatically

---

## Example: Implementing Async Deployment

```bash
/implement spec/deploy/contract.spec.ts
```

**The skill would:**

1. Parse `spec/deploy/contract.spec.ts`
   - Finds 3 describe blocks (POST, GET polling, GET SSE)
   - Extracts ~20 test cases
   - Identifies required endpoints and response shapes

2. Analyze current state
   - `src/routes/deploy.routes.ts` exists (sync endpoint)
   - `src/domain/deploy.ts` exists (sync logic)
   - Need to add v1 endpoints, async logic, SSE support

3. Plan implementation
   - Create deployment registry for tracking in-flight deploys
   - Add POST `/v1/projects/:id/deployments` endpoint
   - Add GET `/v1/projects/:id/deployments/:id` polling endpoint
   - Add GET `/v1/projects/:id/deployments/:id/events` SSE endpoint
   - Refactor domain logic to support async

4. Implement
   - Update `src/domain/deploy.ts` with async support
   - Update `src/routes/deploy.routes.ts` with new endpoints
   - Create `src/types/deployment.ts` for types
   - Write unit and integration tests

5. Verify
   - All contract tests pass
   - Coverage threshold met
   - Code quality checks pass

6. Report
   - "Implemented async deployment with registry, polling, and SSE"
   - "All 20 contract tests passing"
   - "Coverage: 92% (above 90% threshold)"
   - "Ready for review"

---

## Implementation Strategy

### Recommended Order

1. **Start simple** — Make one happy-path test pass first
2. **Add error cases** — Expand to error scenarios
3. **Refine edge cases** — Handle corner cases
4. **Optimize** — Consider performance, readability
5. **Test thoroughly** — Add unit/integration tests
6. **Clean up** — Lint, format, review

### Common Patterns

**For HTTP endpoints:**
1. Create route handler in `src/routes/`
2. Create business logic in `src/domain/`
3. Create types in `src/types/`
4. Test thoroughly

**For async operations:**
1. Create registry/state management
2. Implement background task handling
3. Expose polling/streaming endpoints
4. Handle cleanup and TTL

**For error handling:**
1. Create custom error classes if needed
2. Map errors to HTTP responses in routes
3. Use RFC 9457 Problem Details format
4. Test all error paths

---

## Gotchas and Anti-Patterns

### ❌ DON'T

- Edit contract spec files (you can't, and shouldn't try)
- Skip tests or mark them as pending
- Write code that makes tests pass but is otherwise broken
- Ignore code quality or coverage
- Over-engineer beyond what tests require
- Make assumptions about undefined behavior

### ✅ DO

- Make contract tests pass (they're the spec)
- Write clean, maintainable code
- Add tests that verify your thinking
- Keep implementation focused and simple
- Ask for clarification if tests seem wrong
- Use the project's conventions and patterns

---

## Success Criteria

Implementation is successful when:

✓ All contract tests pass
✓ No contract tests are skipped or modified
✓ Code quality checks pass (linter, formatter)
✓ Coverage threshold is met (90% on main, 85% on branches)
✓ No warnings or errors in build
✓ Code follows project conventions
✓ Implementation is understandable and maintainable
✓ Human can review with confidence

---

## Asking for Help

If you encounter:

- **Test seems wrong** → Flag it, don't work around it
- **Conflicting requirements** → Ask for clarification
- **Technical blocker** → Report it with context
- **Design decision** → Document the choice
- **Uncertainty** → Be transparent about it

The goal is correct implementation, not blind execution.
