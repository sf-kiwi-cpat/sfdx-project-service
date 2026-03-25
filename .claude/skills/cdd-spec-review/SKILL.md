---
name: cdd-spec-review
description: Evaluate spec quality before human approval. Independent agent critiques test-intent alignment, coverage gaps, mock boundaries, and testability. Posts findings to the PR. Advisory — does not gate label transitions.
argument-hint: [optional: path to contract.spec.ts, feature name, or PR number]
disable-model-invocation: false
allowed-tools: Agent, Read, Glob, Bash, AskUserQuestion
---

# /cdd-spec-review — Spec Quality Evaluation

You are the spec critic. Your job is to evaluate whether a contract spec is
**clear, complete, and testable** — before a human approves it and before an
implementation agent tries to satisfy it.

The core insight: the spec author and the spec critic must be independent.
The author knows what they *intended*; the critic checks what they *wrote*.
A spec that looks right to its author may be ambiguous, incomplete, or
untestable to a fresh reader.

## Modes

**With path** → Review that specific spec: `/cdd-spec-review spec/deploy/contract.spec.ts`
**With feature name** → Find and review: `/cdd-spec-review deploy`
**With PR number** → Review spec changes in a PR: `/cdd-spec-review #42`
**No arguments** → Auto-detect: find specs from current branch or recent changes

## Workflow

### Step 0: Find the Spec

Determine the feature and locate the spec files:

1. If a spec path or feature name is given, use it directly
2. If a PR number is given, get the changed files and find spec files
3. If no arguments: check `git diff main --name-only` for changed spec files,
   or look at the current branch name for an issue number

Locate:
- `spec/<feature>/contract.spec.ts` — the executable contract
- `spec/<feature>/contract.md` — the prose contract (if it exists)
- `spec/<feature>/fixtures.ts` — shared test fixtures (if they exist)
- Any existing implementation in `src/` for context on what already exists

### Step 1: Read the Spec

Read all spec files for the feature. Understand the full contract:
- What endpoints/behaviors are being specified?
- What test structure is used (describe/it blocks)?
- What mocks are set up?
- What fixtures are used?
- What assertions are made?

### Step 2: Blind Implementation Derivation (separate agent)

Spawn an agent with these **strict constraints**:

```
You are a spec analyst. Your job is to read ONLY the contract spec test
code and derive what an implementation agent would need to build.

RULES:
- You may ONLY read files in spec/
- You must NOT read any files in src/
- You must NOT read any existing implementation

Read the contract spec and derive:

1. REQUIREMENTS — What must the implementation do? List each behavior
   that a test asserts.
2. AMBIGUITIES — Where is the spec unclear? What could be interpreted
   multiple ways? What would an implementation agent have to guess about?
3. MOCK BOUNDARIES — What is mocked vs real? Does the test mock too much
   (testing nothing real) or too little (requiring real infrastructure)?
4. ASSERTION STRENGTH — For each test, is the assertion tight enough to
   catch bugs but loose enough to allow valid implementations? Flag
   assertions that are trivially satisfiable or impossibly brittle.
5. MISSING SCENARIOS — What obvious error conditions, edge cases, or
   concurrency scenarios are NOT tested? List up to 5 concrete gaps.

Be specific. Reference actual test names, mock setups, and assertion calls.
Do not suggest what the spec *should* test — only analyze what it *does* test
and what it *doesn't*.

Return your findings as a structured list under each heading.
```

Use `subagent_type: "general-purpose"` for this agent. The agent must work
from the spec alone — this tests whether the spec is self-contained and
unambiguous.

### Step 3: Critique

Using the blind derivation and your own reading, evaluate the spec across
five dimensions:

**1. Test-intent alignment**
Does each test actually test what its `it()` description claims? Read the
assertion code, not just the name. Flag tests where:
- The test name says one thing but the assertions check something else
- The test name is vague ("handles errors correctly") with no specifics
- The test exercises a code path but doesn't assert the meaningful outcome

**2. Coverage gaps**
What error conditions, edge cases, or concurrency scenarios are missing?
Suggest up to 5 concrete scenarios the spec doesn't cover. Be specific —
"should test error handling" is not useful; "what happens when the connection
drops mid-deployment?" is.

**3. Mock appropriateness**
Are mocks at the right boundary?
- Mocking too much → test proves nothing (you're testing the mock)
- Mocking too little → test requires real infrastructure (flaky, slow)
- Mock setup doesn't match real behavior (e.g., mock always succeeds but
  real code can throw)
- Mocks are shared/global when they should be per-test

**4. Testability**
Can an implementation agent satisfy these tests without modifying the spec?
- Are assertions too brittle? (exact string matches on error messages that
  the implementation might reasonably word differently)
- Are assertions too loose? (checking only status codes, not response shape)
- Does the test depend on timing, ordering, or other non-deterministic factors?
- Are fixture paths hardcoded in ways that break across environments?

**5. Spec hygiene**
- Are fixtures well-structured and reusable?
- Is setup/teardown correct? (resources cleaned up, mocks restored)
- Any shared mutable state between tests that could cause order-dependence?
- Are test descriptions consistent in style and specificity?

### Step 4: Report & Post to PR

Present findings organized by impact:

```
**[CDD Spec Review]**

## Spec Summary
[Brief description of what the spec covers — endpoints, behaviors, test count]

## Blind Derivation Findings
[Key findings from the implementation derivation agent — ambiguities,
mock boundary issues, missing scenarios]

## Critique

### Must Address (spec is unclear or incomplete)
- [Ambiguities that would force the implementation agent to guess]
- [Missing error cases that are likely to matter in production]

### Worth Considering (improves spec quality)
- [Coverage gaps for edge cases]
- [Mock boundary adjustments]
- [Assertion tightness improvements]

### Observations (no action needed)
- [Notes on spec structure, style, patterns]

## Assessment
[SOLID — spec is clear and complete | HAS GAPS — address listed items
before approving]
```

**Post the report to the PR** so the human reviewer sees it alongside the
spec itself. Edit an existing review comment if one exists to avoid duplicates:

```bash
PR_NUMBER=$(gh pr list --head $(git branch --show-current) --json number -q '.[0].number')
if [ -n "$PR_NUMBER" ]; then
  EXISTING=$(gh pr view $PR_NUMBER --json comments \
    --jq '.comments[] | select(.body | startswith("**[CDD Spec Review]**")) | .url' | tail -1)
  COMMENT_ID=$(echo "$EXISTING" | grep -oE '[0-9]+$')
  if [ -n "$COMMENT_ID" ]; then
    gh api repos/{owner}/{repo}/issues/comments/$COMMENT_ID \
      -X PATCH -f body="$REVIEW_BODY"
  else
    gh pr comment $PR_NUMBER --body "$REVIEW_BODY"
  fi
fi
```

This skill does NOT transition labels. The spec review is advisory — the
human decides whether to approve the spec based on both their own judgment
and the agent's critique.

---

## Key Principles

### Independence
The spec critic must not share context with the spec author. The blind
derivation agent reads only spec files and derives what an implementation
would need. If the derivation is ambiguous, the spec is ambiguous.

### Advisory, Not Blocking
This skill posts findings but does not gate label transitions. The human
reviewer considers the critique alongside their own review and decides
whether to approve (`spec:approved`) or request changes. The spec review
loop re-runs when the spec is updated.

### Concrete over Abstract
"Consider adding error handling tests" is useless feedback. "What happens
when `vite.build()` rejects with a non-Error value (e.g., a string)?" is
actionable. Every finding should be specific enough that the spec author
knows exactly what to add or change.

### Five Findings, Not Fifty
Limit coverage gap suggestions to 5. Limit each critique category to the
most impactful findings. A review with 3 high-signal observations is better
than one with 30 nits. The human reviewer doesn't want to wade through noise.

### No Spec Modification
This skill reads and critiques. It does not modify spec files. The spec
author (human or `/cdd-spec`) addresses findings and re-pushes. This
separation ensures the critic stays independent.

---

## Related Skills

- **`/cdd-spec`** — Authors the contracts this skill critiques
- **`/cdd-implement`** — Implements code to satisfy the spec
- **`/cdd-code-review`** — Reviews implementation quality after coding
- **`/cdd-brief`** — Gathers context (not needed for spec review)

**Automation:** Loop 3 detects `spec:ready-for-review` PRs and runs
`/cdd-spec-review` automatically. Findings are posted to the PR for the
human reviewer.
