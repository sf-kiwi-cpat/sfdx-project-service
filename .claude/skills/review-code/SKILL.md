---
name: review-code
description: "Launch comprehensive code review using both code-review and quality-assurance agents in parallel"
model: inherit
---

## Purpose

This skill orchestrates a comprehensive code review by launching both the `code-review` (static analysis) and `quality-assurance` (behavioral testing) agents in parallel. Both agents work on the **current branch** without creating topic branches. The skill then merges their findings into a single unified report.

## Usage

```bash
# Review a pull request by number (default and most common)
/review-code 123

# Review the current branch
/review-code current

# Review a specific branch
/review-code feature/my-branch

# Review a specific commit
/review-code abc123f
```

## Arguments

- **PR number** (default): Fetches PR context via `gh pr view`, checks out the PR branch
- **`current`**: Reviews the current branch state
- **Branch name**: Checks out and reviews the specified branch
- **Commit hash**: Checks out and reviews the specified commit

## What This Skill Does

1. **Parse target**: Determines what to review (PR, branch, commit, or current)
2. **Fetch context**: Uses GitHub CLI to get PR information if reviewing a PR
3. **Prepare branch**: Fetches latest changes and checks out the target branch/commit
4. **Record branch name**: Captures the branch we're reviewing (to pass to agents)
5. **Determine review round**: Checks existing `.agents/review-N.md` files to find the next round number
6. **Launch agents in parallel**: Starts both `code-review` and `quality-assurance` agents on the current branch
7. **Merge findings**: Reads draft files (`.agents/.code-review-draft.md`, `.agents/.qa-draft.md`), merges findings, deduplicates
8. **Write unified report**: Creates `.agents/review-N.md` with all findings, test results, and implementation notes

## Process

### Step 1: Determine Review Target

Check what argument was provided and identify the review target:

```bash
# If argument looks like a number, treat as PR
# If argument is "current", use current branch
# If argument looks like commit hash, use that commit
# Otherwise, treat as branch name
```

### Step 2: Fetch PR Context (if applicable)

If reviewing a PR, use GitHub CLI to get context:

```bash
gh pr view <PR_NUMBER> --json number,title,headRefName,baseRefName,body,state
```

### Step 3: Prepare Git State and Record Current Branch

```bash
# Fetch latest from remote
git fetch origin

# For PR: checkout the PR branch
git checkout <headRefName>
git pull origin <headRefName>

# For branch: checkout the branch
git checkout <branch_name>
git pull origin <branch_name>

# For commit: checkout the commit in detached HEAD
git checkout <commit_hash>

# For current: stay on current branch, ensure it's up to date
git pull origin <current_branch>

# Capture current branch name for passing to agents
REVIEW_BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMIT_HASH=$(git rev-parse HEAD)
```

### Step 4: Determine Review Round Number

Check existing reports to find the next sequential number:

```bash
# Find the highest existing review-N.md file
ls .agents/review-*.md 2>/dev/null | sed 's/.*review-//' | sed 's/.md//' | sort -n | tail -1
# If result is N, next round is N+1; if no files, start at 1
```

### Step 5: Launch Both Agents in Parallel

**IMPORTANT**: Pass both the branch name and explicit instruction to **stay on current branch**.

Use the Task tool to launch both agents simultaneously:

```typescript
// Launch code-review agent
Task({
  subagent_type: "code-review",
  description: "Static code analysis",
  prompt: `Perform static code analysis review on branch ${REVIEW_BRANCH} (commit ${COMMIT_HASH}).

CRITICAL: Stay on ${REVIEW_BRANCH}. Do NOT create or checkout other branches.

Write your findings to .agents/.code-review-draft.md (intermediate artifact).
The skill will merge this with the QA findings into the final review-${NEXT_ROUND}.md report.`,
  run_in_background: false
})

// Launch quality-assurance agent
Task({
  subagent_type: "quality-assurance",
  description: "QA behavioral testing",
  prompt: `Perform quality assurance testing on branch ${REVIEW_BRANCH} (commit ${COMMIT_HASH}).

CRITICAL: Stay on ${REVIEW_BRANCH}. Do NOT create or checkout other branches.

Write your findings to .agents/.qa-draft.md (intermediate artifact).
The skill will merge this with the code-review findings into the final review-${NEXT_ROUND}.md report.`,
  run_in_background: false
})
```

**Important**: Both Task calls must be made in a single message to run in parallel.

### Step 6: Merge Findings into Unified Report

After both agents complete:

1. **Read both draft files:**
   - Read `.agents/.code-review-draft.md`
   - Read `.agents/.qa-draft.md`

2. **Merge and deduplicate findings:**
   - Parse findings from both agents
   - Identify duplicate issues (same issue flagged by both)
   - Order findings by severity: High → Medium → Low
   - Mark source for each finding: "Code Review", "QA", or "Both"

3. **Create unified report:** `.agents/review-N.md` with structure:

```markdown
# Review (Round N) — SF Project Service

Review of `<branch>` at commit `<hash>`.

---

## Checks

| Check | Result |
|:---|:---|
| `npx tsc --noEmit` | ... |
| `npx eslint .` | ... |
| `npm run build` | ... |
| `npm test` | ... |

## Status of Round (N-1) Findings

[Both agents contribute — code-review checks code changes, QA re-tests]

For each prior finding, state:
- Finding number and title
- Whether it's resolved, partially resolved, or unresolved
- Evidence (code snippets, curl output, test results)

---

## Findings

[All findings from both agents, ordered by severity (High → Low), deduplicated]

### 1. [Title]

**Source:** Code Review | QA | Both
**Category:** [Security Risk | Type Safety | Bug | Maintainability | Spec Violation | etc.]
**Severity:** [High | Medium | Low]
**File/Endpoint:** [file.ts:line-range or /endpoint]

[Description]

**Evidence:** [Code snippet or curl output]

---

## Test Results

[QA agent's automated + manual test results]

### Automated Tests
| Check | Result |
|:---|:---|
| `npm test` | ... |
| Test pass rate | ... |

### Manual Test Results
[Test plan sections run and results]

---

## Security Verification

[QA agent's runtime security results + code-review's structural observations]

| Check | Status | Evidence |
|:---|:---|:---|
| Path traversal blocked | [Pass/Fail] | [curl output] |
| Restricted paths at all depths | [Pass/Fail] | [curl output] |
| Credentials not exposed | [Pass/Fail] | [How verified] |
| Error message safety | [Pass/Fail] | [Examples] |
| RFC 9457 compliance | [Pass/Fail] | [Spot checks] |

---

## Implementation Notes

[For each finding, note second-order considerations when addressing the fix]

For example:
- If suggesting a new function, note it needs tests
- If suggesting a timer, note it should be `.unref()`'d
- If suggesting a validation function, note what inputs it should handle
- Note any interactions between fixes (e.g., "Fix #3 requires coordinating with Fix #1")

---

## Summary

[2-3 sentences: overall review status, whether code quality and behavior are acceptable, what's most important to address first]

**Important:** Read all findings before addressing any — some interact with each other. Consider second-order effects of each fix (see Implementation Notes).
```

4. **Delete draft files:**
   ```bash
   rm -f .agents/.code-review-draft.md .agents/.qa-draft.md
   ```

### Step 7: Report Results to User

After both agents complete:

```markdown
## Code Review Complete

**Branch:** <branch_name>
**Commit:** <commit_hash>
**Report:** `.agents/review-N.md`

Both agents have completed their reviews and findings have been merged into a single unified report.

[If findings exist:]
**Summary:**
- X High-severity findings
- X Medium-severity findings
- X Low-severity findings
- X findings from code review, Y from QA, Z flagged by both

**Priority:** [The highest-severity finding and what to improve first]

**Important:** Read all findings before addressing any — some interact with each other. See "Implementation Notes" section for second-order effects.

[If no findings:]
All prior issues addressed. Code quality and behavior are good. No new issues found.
```

## Agent Coordination

### Single-Branch Workflow
Both agents work on the **current branch**—no topic branches, no branch switching:
- Code-review writes to `.agents/.code-review-draft.md`
- QA writes to `.agents/.qa-draft.md`
- Skill merges both drafts into `.agents/review-N.md` (local only — intentionally gitignored)

### Parallel Execution
Both agents run simultaneously for efficiency. No conflicts because:
- Each agent writes only to its own draft file
- Neither agent modifies source code
- Skill handles merging and commit

### Unified Report Sequence
Single sequential numbering: `review-1.md`, `review-2.md`, `review-3.md`, ...

This replaces:
- Old code-review naming: `code-review-N.md` (now intermediate: `.code-review-draft.md`)
- Old QA naming: `qa-report-N.md` (now intermediate: `.qa-draft.md`)

## Examples

### Example 1: Review PR #45

```bash
/review-code 45
```

**What happens:**
1. Fetch PR #45 details via `gh pr view 45`
2. Checkout PR source branch
3. Launch both agents in parallel
4. Report completion with branch/file links

### Example 2: Review Current Branch

```bash
/review-code current
```

**What happens:**
1. Stay on current branch
2. Ensure up to date with `git pull`
3. Launch both agents in parallel
4. Report completion with branch/file links

### Example 3: Review Specific Commit

```bash
/review-code a1b2c3d
```

**What happens:**
1. Checkout commit `a1b2c3d` (detached HEAD)
2. Launch both agents in parallel
3. Report completion with branch/file links

## Error Handling

### PR Not Found
If `gh pr view` fails, report error and ask user to verify PR number.

### Branch Doesn't Exist
If target branch doesn't exist, report error and list available branches.

### Agents Already Running
If agent branches already exist for current round number, agents will handle appropriately (see agent documentation).

### Git State Issues
If there are uncommitted changes, report them and ask user to commit or stash before proceeding.

## Notes

- This skill does NOT modify source code
- All agent outputs go on separate topic branches
- User is responsible for merging agent branches after review
- Both agents follow the "never fix, only document" principle
- Review numbers are independent per agent type
