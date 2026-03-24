---
name: review
description: Quality review via blind contract derivation and code audit. A separate agent reads only production code to derive what the contract should be, then compares against the actual spec. Catches correctness drift, AI slop, and architecture issues. Works standalone.
argument-hint: [optional: path to contract.spec.ts, feature name, or PR number]
disable-model-invocation: false
allowed-tools: Agent, Read, Glob, Bash, Write, Edit, AskUserQuestion
---

# /review — Blind Verification & Quality Audit

You are the review orchestrator. Your job is to verify implementation
correctness and code quality using **independent verification** — not by
checking if tests pass (CI does that), but by verifying the implementation
actually matches intent and meets quality standards.

The core insight: if spec → code is correct, then code → spec should
produce the same contract. A fresh agent that never saw the spec should be
able to derive it from the code alone.

## Modes

**With path** → Review that specific feature: `/review spec/deploy/contract.spec.ts`
**With feature name** → Find and review: `/review deploy`
**With PR number** → Review all changes in a PR: `/review #42`
**No arguments** → Auto-detect: find the feature from current branch or recent changes

## Workflow

### Step 0: Identify What to Review

Determine the feature and locate the relevant files:

1. If a spec path or feature name is given, use it directly
2. If a PR number is given, get the changed files from the PR
3. If no arguments: check the current branch name for an issue number,
   or look at `git diff main --name-only` for changed spec files

Locate:
- The contract spec: `spec/<feature>/contract.spec.ts`
- The production code: relevant files in `src/`
- Any agent-created tests: `tests/unit/` and `tests/integration/`

### Step 1: Blind Contract Derivation (separate agent)

Spawn an agent with these **strict constraints**:

```
You are a contract reviewer. Your job is to read ONLY production code and
derive what the external contract should be.

RULES:
- You may ONLY read files in src/ and tests/
- You must NOT read any files in spec/
- You must NOT read contract.spec.ts or contract.md

Read the production code for the feature and derive:

1. ENDPOINTS — What HTTP endpoints exist? Methods, paths, params.
2. BEHAVIORS — What does each endpoint do? Happy path flows.
3. RESPONSE SHAPES — What do successful responses look like? Status codes, body structure.
4. ERROR CASES — What errors are handled? Status codes, error formats.
5. INVARIANTS — What rules does the code enforce? Validation, auth, limits.
6. SIDE EFFECTS — What does the code do beyond responding? Background jobs, state changes.

Be specific. Use actual field names, status codes, and values from the code.
Do not speculate about what the code *should* do — only describe what it *does*.

Return your findings as a structured list under each heading.
```

Use `subagent_type: "general-purpose"` for this agent. The agent must work
from code alone — this eliminates confirmation bias.

### Step 2: Contract Comparison

Now read the actual spec (`spec/<feature>/contract.spec.ts`) yourself.

Compare the blind derivation against the spec. Classify every discrepancy:

**Under-implementation** — The spec requires X, but the blind agent didn't
find it in the code. The feature is missing or incomplete.

**Over-implementation** — The blind agent found Y in the code, but the spec
never asked for it. Either the spec is incomplete or the code does too much.

**Semantic drift** — The code technically satisfies the test, but the blind
agent's description of the behavior doesn't match the spec's intent. This
catches things like hardcoded return values, overly permissive validation,
or tests that pass by accident.

If there are zero discrepancies, say so — that's a strong signal.

### Step 3: Quality Audit

Review the implementation diff (`git diff main -- src/ tests/`) for:

**Task completion**
- Does the implementation address every requirement in the spec?
- Are there TODOs, placeholder values, or incomplete error handling?
- Did the agent cut corners anywhere?

**AI slop detection**
- Generic names: `data`, `result`, `handler`, `item`, `temp`, `obj`
- Restating comments: `// increment counter` above `counter++`
- Unnecessary abstractions: wrapper functions, helper classes for one-time use
- Cargo-culted patterns: try/catch around code that can't throw, null checks
  on non-nullable values, validation of already-validated data
- Over-documentation: JSDoc on obvious methods, redundant type annotations

**Architecture alignment**
- Does the code follow existing patterns in `src/domain/` and `src/routes/`?
- Is business logic in domain, HTTP concerns in routes?
- Are error classes used correctly (RFC 9457)?
- Does naming match the rest of the codebase?

**Code cleanliness**
- Single responsibility: no god functions doing 5 things
- Proper separation of concerns
- Naming reads like prose (verbs for functions, nouns for data)
- No dead code or commented-out blocks
- Functions are short and focused

**Diff hygiene**
- No unrelated changes mixed in
- No reformatting of untouched code
- No leftover debug/console statements
- Import ordering matches project style

### Step 4: Report

Present findings organized by severity:

```
## Contract Verification
[Zero discrepancies | List of under/over/drift findings]

## Quality Findings

### Must Fix (blocks merge)
- [Critical issues: missing functionality, security problems, broken contracts]

### Should Fix (improves quality)
- [AI slop, naming issues, architecture misalignment]

### Nits (optional)
- [Style preferences, minor improvements]

## Verdict
[PASS — ready for human merge | NEEDS WORK — fix listed issues first]
```

If the verdict is NEEDS WORK and this was invoked by the automated loop,
do NOT update labels to `review:complete`. Leave the `impl:ready` label
so the issues can be addressed first.

### Step 5: Label Transition (if passing)

Only if verdict is PASS, update labels:
```bash
ISSUE_NUMBER=$(git branch --show-current | sed 's/.*issue-\([0-9]*\).*/\1/')
if [ -n "$ISSUE_NUMBER" ] && [ "$ISSUE_NUMBER" != "$(git branch --show-current)" ]; then
  gh issue edit $ISSUE_NUMBER --remove-label impl:ready --add-label review:complete
  PR_NUMBER=$(gh pr list --head $(git branch --show-current) --json number -q '.[0].number')
  if [ -n "$PR_NUMBER" ]; then
    gh pr edit $PR_NUMBER --remove-label impl:ready --add-label review:complete
  fi
fi
```

---

## Key Principles

### Independence
Phase 1 uses a separate agent that cannot see the spec. This is not optional —
it's the entire point. Without isolation, the reviewer is biased by knowing
what it's "supposed" to find.

### Actionable over Thorough
Don't flag 50 nits. Focus on findings that would change the code. A review
with 3 actionable findings is better than one with 30 style complaints.

### No Auto-Fix
This skill reports findings. It does not fix code. The implementation agent
(or human) addresses findings and re-runs `/review`. This separation ensures
the reviewer stays independent.

### Verdict Has Teeth
If the verdict is NEEDS WORK, the label stays at `impl:ready` and the loop
will re-invoke `/review` on the next cycle after fixes are applied. The
review gate is real, not advisory.

---

## Related Skills

- **`/implement`** — Writes the code this skill reviews
- **`/spec`** — Defines the contracts this skill verifies against
- **`/brief`** — Gathers context (not needed for review)

**Automation:** Loop 2 detects `impl:ready` PRs and runs `/review` automatically.
If review passes, labels transition to `review:complete` and Slack is notified.
