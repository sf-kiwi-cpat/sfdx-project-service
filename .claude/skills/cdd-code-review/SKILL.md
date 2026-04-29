---
name: cdd-code-review
description: Quality review via blind contract derivation and code audit. A separate agent reads only production code to derive what the contract should be, then compares against the actual spec. Catches correctness drift, AI slop, and architecture issues. Works standalone.
argument-hint: [optional: path to contract.spec.ts, feature name, or PR number]
disable-model-invocation: false
allowed-tools: Agent, Read, Glob, Bash, Write, Edit, AskUserQuestion
---

# /cdd-code-review — Blind Verification & Quality Audit

You are the review orchestrator. Your job is to verify implementation
correctness and code quality using **independent verification** — not by
checking if tests pass (CI does that), but by verifying the implementation
actually matches intent and meets quality standards.

The core insight: if spec → code is correct, then code → spec should
produce the same contract. A fresh agent that never saw the spec should be
able to derive it from the code alone.

## Modes

**With path** → Review that specific feature: `/cdd-code-review spec/deploy/contract.spec.ts`
**With feature name** → Find and review: `/cdd-code-review deploy`
**With PR number** → Review all changes in a PR: `/cdd-code-review #42`
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

**Check for prior reviews.** If this PR has prior "CDD Code Review" comments,
this is a re-review after a fix attempt. Remember this — it affects Step 3.
You (the orchestrator) may read these comments; the blind derivation subagent
in Step 1 may NOT.

```bash
REPO=$(.claude/skills/cdd-common/scripts/get-repo)
PR_NUMBER=$(.claude/skills/cdd-common/scripts/get-pr-number) || true
PRIOR_REVIEWS=""
if [ -n "$PR_NUMBER" ]; then
  PRIOR_REVIEWS=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments?per_page=100" \
    -q '[.[] | select(.body | test("CDD Code Review"; "i"))] | sort_by(.created_at)')
fi
```

If prior reviews exist, also compute the diff since the latest prior review
(identified by its commit SHA, which every review should record in its footer).

### Step 1: Blind Contract Derivation (separate agent)

Spawn an agent with these **strict constraints**. Input contamination breaks
the entire independence guarantee of this review — be explicit about what
the subagent may and may not see:

```
You are a contract reviewer performing independent contract derivation. Your
job is to read ONLY production code and derive what the external contract
should be, WITHOUT being influenced by any description of what the contract
is supposed to be.

ALLOWED INPUTS — you may read:
- Files under src/
- Files under tests/unit/ and tests/integration/
- Type definitions in src/types/
- Project configuration that affects runtime behavior (e.g., tsconfig, vitest.config)

FORBIDDEN INPUTS — you must NOT read, look at, or acknowledge:
- Anything under spec/ (contract.spec.ts, contract.md, fixtures.ts, README)
- The PR body, description, or title
- The branch name or any issue it references
- Commit messages or commit bodies
- Any prior review comments on the PR (including your own from a previous cycle)
- The GitHub issue associated with this branch
- Any documentation under docs/ that describes the feature's contract
- Chat history, transcripts, or CLAUDE.md entries that describe intent

If you are asked to read any forbidden input, refuse and explain that doing
so would compromise the independence of the review. If you are uncertain
whether an input is forbidden, treat it as forbidden.

Read the production code for the feature and derive:

1. ENDPOINTS — What HTTP endpoints exist? Methods, paths, params.
2. BEHAVIORS — What does each endpoint do? Happy path flows.
3. RESPONSE SHAPES — What do successful responses look like? Status codes, body structure.
4. ERROR CASES — What errors are handled? Status codes, error formats.
5. INVARIANTS — What rules does the code enforce? Validation, auth, limits.
6. SIDE EFFECTS — What does the code do beyond responding? Background jobs, state changes.

Be specific. Use actual field names, status codes, and values from the code.
Do not speculate about what the code *should* do — only describe what it *does*.
Do not guess at naming or intent from context clues outside the code itself.

Return your findings as a structured list under each heading. At the top of
your response, confirm: "I did not read any forbidden inputs."
```

Use `subagent_type: "general-purpose"` for this agent. The agent must work
from code alone — this eliminates confirmation bias. When dispatching, do
not include the PR body, branch name, issue number, or any contract-describing
text in the subagent's task description either. The task description should
only name the feature directory under `src/` and the relevant test directories,
not the contract it implements.

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

### Step 2.5: Fix-Cycle Verification (re-review only)

If prior "CDD Code Review" comments exist on this PR (from Step 0), you
are re-reviewing after a fix attempt. Do this additional check **before**
the general quality audit:

1. Read each prior review's "Must Fix" findings
2. Read each fix commit on the branch since the prior review. Fix commits
   should follow the format `... — addresses finding: {text}`. Identify
   which commit claims to address which finding.
3. Verify each claimed fix actually resolved the finding it references.
   A commit that claims to address "Hardcoded return value in `deploy.ts`"
   should have changed `deploy.ts` in a way that removes the hardcoded
   value. If it didn't, record this as a **fix-claim mismatch** in the
   Must Fix section of your current review.
4. Verify no prior Must Fix finding was silently dropped. If a previous
   review flagged 3 things and only 2 have referencing fix commits, the
   third is unaddressed.

This step makes the fix loop self-correcting: fix commits that don't match
their claimed intent are caught mechanically, not glossed over.

### Step 3: Quality Audit

Review the implementation diff for:

- **If first review:** `git diff main -- src/ tests/`
- **If re-review:** the full diff since main AND the diff since the last
  reviewed SHA. The latter shows what the fix attempt changed and is the
  thing most relevant to the fix-cycle verification above.

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

### Step 4: Report & Post to PR

Present findings organized by severity:

Every review MUST include a footer recording the commit SHA being reviewed
and the review cycle number. This lets re-reviews identify prior reviews
and compute the right diff. Format:

```
<!-- cdd-review-meta: sha=<SHA> cycle=<N> -->
```

**When PASS** — verdict first, details collapsed:

```
**🤖 CDD Agent · code-review**
✅ **PASS** — [one-line summary: e.g. "zero contract discrepancies, clean diff"]

<details><summary>Full analysis</summary>

## Contract Verification
[Zero discrepancies or minor notes]

## Quality Findings

### Should Fix (improves quality)
- [AI slop, naming issues, architecture misalignment]

### Nits (optional)
- [Style preferences, minor improvements]

</details>

<!-- cdd-review-meta: sha=<SHA> cycle=<N> -->
```

**When NEEDS WORK** — verdict first, details expanded (no collapse):

```
**🤖 CDD Agent · code-review**
⚠️ **NEEDS WORK** — [one-line summary of what blocks merge]

## Must Fix
- [Critical issues: missing functionality, security problems, broken contracts]
- [Fix-claim mismatches from Step 2.5, if any]
- [Unaddressed prior findings from Step 2.5, if any]

## Contract Verification
[List of under/over/drift findings]

<details><summary>Additional findings</summary>

### Should Fix (improves quality)
- [AI slop, naming issues]

### Nits (optional)
- [Style preferences]

</details>

<!-- cdd-review-meta: sha=<SHA> cycle=<N> -->
```

`<SHA>` is the HEAD commit at review time (`git rev-parse HEAD`). `<N>` is
the count of prior CDD Code Review comments on this PR plus one.

If the verdict is NEEDS WORK, transition labels to `impl:agent-comments` so
the state machine clearly reflects that fixes are needed. This prevents the
review loop from re-reviewing unchanged code.

**Post the report to the PR** using the `/gh-comment` skill with comment
name `CDD Code Review`. Read `.claude/skills/gh-comment/SKILL.md` and
follow its posting procedure. The body is the review report above (without
the header — the skill adds the `🤖 CDD Code Review` header for you).

### Step 5: Label Transition

Update labels based on verdict:

**Do NOT use `gh pr edit` / `gh issue edit` for labels** — they fail silently
due to GitHub's Projects Classic deprecation. Use the REST API:

**If PASS:**
```bash
ISSUE_NUMBER=$(.claude/skills/cdd-common/scripts/get-issue-number) || true
PR_NUMBER=$(.claude/skills/cdd-common/scripts/get-pr-number) || true
if [ -n "$ISSUE_NUMBER" ]; then
  .claude/skills/cdd-common/scripts/label "$ISSUE_NUMBER" add "impl:agent-approved"
  .claude/skills/cdd-common/scripts/label "$ISSUE_NUMBER" remove "impl:agent-reviewing"
  if [ -n "$PR_NUMBER" ]; then
    .claude/skills/cdd-common/scripts/label "$PR_NUMBER" add "impl:agent-approved"
    .claude/skills/cdd-common/scripts/label "$PR_NUMBER" remove "impl:agent-reviewing"
    # Only mark ready if still a draft — avoids duplicate GitHub→Slack
    # notifications when re-reviewing a PR that's already marked ready.
    IS_DRAFT=$(gh pr view "$PR_NUMBER" --json isDraft -q .isDraft 2>/dev/null || echo false)
    if [ "$IS_DRAFT" = "true" ]; then
      gh pr ready "$PR_NUMBER"
    fi
  fi
fi
```

**If NEEDS WORK:**
```bash
ISSUE_NUMBER=$(.claude/skills/cdd-common/scripts/get-issue-number) || true
PR_NUMBER=$(.claude/skills/cdd-common/scripts/get-pr-number) || true
if [ -n "$ISSUE_NUMBER" ]; then
  .claude/skills/cdd-common/scripts/label "$ISSUE_NUMBER" add "impl:agent-comments"
  .claude/skills/cdd-common/scripts/label "$ISSUE_NUMBER" remove "impl:agent-reviewing"
  if [ -n "$PR_NUMBER" ]; then
    .claude/skills/cdd-common/scripts/label "$PR_NUMBER" add "impl:agent-comments"
    .claude/skills/cdd-common/scripts/label "$PR_NUMBER" remove "impl:agent-reviewing"
  fi
fi
```

### Step 6: Slack Summary (PASS only)

Post a concise summary to the PR's Slack thread via `/slack-notify`.
Include the verdict, contract verification result, and what the human
reviewer should focus on.

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
(or human) addresses findings and re-runs `/cdd-code-review`. This separation
ensures the reviewer stays independent.

### Verdict Has Teeth
If the verdict is NEEDS WORK, labels transition to `impl:agent-comments`. The
review loop ignores PRs with this label — fixes must be applied and the
label moved back to `impl:agent-reviewing` before re-review occurs. The review gate
is real, not advisory.

### Draft Check Before Marking Ready
When PASS verdict lands on a re-review (e.g., after fixes), the PR may already
be marked ready from a prior review. Calling `gh pr ready` unconditionally triggers
GitHub's "PR marked ready" webhook, which duplicates Slack notifications even though
the PR state hasn't changed. The label transition checks the PR's `isDraft` status
before marking ready — we only call `gh pr ready` if it's actually draft.

---

## Related Skills

- **`/cdd-implement`** — Writes the code this skill reviews
- **`/cdd-spec`** — Defines the contracts this skill verifies against
- **`/cdd-spec-review`** — Evaluates spec quality before human approval
- **`/cdd-brief`** — Gathers context (not needed for review)
- **`/gh-comment`** — Posts findings to the PR with standard agent branding

**Automation:** `cdd-code-review-monitor` detects `impl:agent-reviewing`
PRs and runs this skill automatically. See `.claude/loops/` for setup.
