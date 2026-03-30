---
name: cdd-spec-review
description: Evaluate spec quality before human approval. Critiques test-intent alignment, coverage gaps, mock boundaries, and testability. Posts findings to the PR. Transitions to spec:agent-comments when gaps are found.
argument-hint: [optional: path to contract.spec.ts, feature name, or PR number]
disable-model-invocation: false
allowed-tools: Read, Glob, Bash, AskUserQuestion
---

# /cdd-spec-review — Spec Quality Evaluation

You are the spec critic. Your job is to evaluate whether a contract spec is
**clear, complete, and testable** — before a human approves it and before an
implementation agent tries to satisfy it.

The core insight: the spec is the source of truth. The `contract.spec.ts` is
the executable contract; the `contract.md` is an orientation aid for human
reviewers. Your job is to verify the spec is unambiguous and implementable,
not to re-derive it from another source.

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

Also read any existing implementation in `src/` for context on what already
exists — this helps you assess whether the spec covers real behavior.

### Step 2: Critique

Evaluate the spec across five dimensions:

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

### Step 3: Report & Post to PR

Present findings organized by impact:

**When SOLID** — verdict first, details collapsed:

```
**🤖 CDD Agent · spec-review**
✅ **SOLID** — [one-line summary of what the spec covers]

<details><summary>Full analysis (N describe blocks, M tests)</summary>

## Spec Summary
[Brief description of what the spec covers — endpoints, behaviors, test count]

## Critique

### Worth Considering (improves spec quality)
- [Coverage gaps, mock boundary adjustments, assertion tightness]

### Observations (no action needed)
- [Notes on spec structure, style, patterns]

</details>
```

**When HAS GAPS** — verdict first, details expanded (no collapse):

```
**🤖 CDD Agent · spec-review**
⚠️ **HAS GAPS** — [one-line summary of what needs attention]

## Must Address
- [Ambiguities that would force the implementation agent to guess]
- [Missing error cases that are likely to matter in production]

## Worth Considering
- [Coverage gaps, mock boundary adjustments]
```

**Post the report to the PR** using the `/gh-comment` skill with comment
name `CDD Spec Review`. Read `.claude/skills/gh-comment/SKILL.md` and
follow its posting procedure. The body is the review report above (without
the header — the skill adds the `🤖 CDD Spec Review` header for you).

**Label transition based on assessment:**

**If SOLID** — transition to `spec:agent-approved` and mark the PR as
ready for review (undraft). This is the signal to humans that the agent
has cleared the spec and it's ready for their approval.

Use `gh api` for labels — `gh issue/pr edit --add-label` is unreliable
(silently fails due to Projects Classic deprecation). PRs are issues in the
GitHub API, so the same `/issues/` endpoint works for both:

```bash
PR_NUMBER=$(gh pr list --head $(git branch --show-current) --json number -q '.[0].number')
ISSUE_NUMBER=$(git branch --show-current | sed 's/.*issue-\([0-9]*\).*/\1/')
if [ -n "$ISSUE_NUMBER" ] && [ "$ISSUE_NUMBER" != "$(git branch --show-current)" ]; then
  gh api repos/{owner}/{repo}/issues/$ISSUE_NUMBER/labels/spec:agent-reviewing --method DELETE 2>/dev/null || true
  gh api repos/{owner}/{repo}/issues/$ISSUE_NUMBER/labels --method POST -f 'labels[]=spec:agent-approved'
  if [ -n "$PR_NUMBER" ]; then
    gh api repos/{owner}/{repo}/issues/$PR_NUMBER/labels/spec:agent-reviewing --method DELETE 2>/dev/null || true
    gh api repos/{owner}/{repo}/issues/$PR_NUMBER/labels --method POST -f 'labels[]=spec:agent-approved'
    gh pr ready $PR_NUMBER
  fi
fi
```

**If HAS GAPS** — transition to `spec:agent-comments` so the state machine
reflects that feedback exists. The fix monitor addresses findings and
re-pushes, which moves the label back to `spec:agent-reviewing`.

```bash
PR_NUMBER=$(gh pr list --head $(git branch --show-current) --json number -q '.[0].number')
ISSUE_NUMBER=$(git branch --show-current | sed 's/.*issue-\([0-9]*\).*/\1/')
if [ -n "$ISSUE_NUMBER" ] && [ "$ISSUE_NUMBER" != "$(git branch --show-current)" ]; then
  gh api repos/{owner}/{repo}/issues/$ISSUE_NUMBER/labels/spec:agent-reviewing --method DELETE 2>/dev/null || true
  gh api repos/{owner}/{repo}/issues/$ISSUE_NUMBER/labels --method POST -f 'labels[]=spec:agent-comments'
  if [ -n "$PR_NUMBER" ]; then
    gh api repos/{owner}/{repo}/issues/$PR_NUMBER/labels/spec:agent-reviewing --method DELETE 2>/dev/null || true
    gh api repos/{owner}/{repo}/issues/$PR_NUMBER/labels --method POST -f 'labels[]=spec:agent-comments'
  fi
fi
```

The human can still approve a spec regardless of the agent's assessment —
just add `spec:human-approved` directly.

---

## Key Principles

### Source of Truth is the Test
The `contract.spec.ts` is the executable contract. The `contract.md` is a
human-readable orientation aid — helpful for onboarding reviewers, but not
a substitute for reading the test code. Review quality comes from analyzing
the tests themselves, not comparing two representations.

### Gating, Not Blocking
When SOLID, labels transition to `spec:agent-approved` — signaling the
human that the agent has cleared the spec. When HAS GAPS, labels transition
to `spec:agent-comments`. The human can override either by moving directly
to `spec:human-approved`. The spec review loop re-runs when the spec
returns to `spec:agent-reviewing`.

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
author (human or `/cdd-spec`) addresses findings and re-pushes.

---

## Related Skills

- **`/cdd-spec`** — Authors the contracts this skill critiques
- **`/cdd-implement`** — Implements code to satisfy the spec
- **`/cdd-code-review`** — Reviews implementation quality after coding
- **`/cdd-brief`** — Gathers context (not needed for spec review)
- **`/gh-comment`** — Posts findings to the PR with standard agent branding

**Automation:** `cdd-spec-review-monitor` detects `spec:agent-reviewing`
PRs and runs `/cdd-spec-review` automatically. Findings are posted to the PR.
If gaps are found, labels transition to `spec:agent-comments`.
