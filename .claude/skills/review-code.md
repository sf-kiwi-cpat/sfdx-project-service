---
name: review-code
description: "Launch comprehensive code review using both code-review and quality-assurance agents in parallel"
model: inherit
color: blue
---

## Purpose

This skill orchestrates a comprehensive code review by launching both the `code-review` (static analysis) and `quality-assurance` (behavioral testing) agents in parallel. It handles fetching PR context, preparing the target branch, and coordinating the review process.

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
4. **Launch agents in parallel**: Starts both `code-review` and `quality-assurance` agents simultaneously
5. **Report completion**: Provides links to both feedback branches and report files

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

This provides:
- PR title and description
- Source branch (`headRefName`) to check out
- Base branch (`baseRefName`) for comparison
- PR state (open, closed, merged)

### Step 3: Prepare Git State

Ensure we have latest changes and check out target:

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
```

### Step 4: Launch Both Agents in Parallel

Use the Task tool to launch both agents simultaneously:

```typescript
// Launch code-review agent
Task({
  subagent_type: "code-review",
  description: "Static code analysis",
  prompt: "Perform static code analysis review following the established process. Create a new review branch and feedback file.",
  run_in_background: false
})

// Launch quality-assurance agent
Task({
  subagent_type: "quality-assurance",
  description: "QA behavioral testing",
  prompt: "Perform quality assurance testing following the established process. Run automated tests and manual test plan validation. Create a new QA report branch and report file.",
  run_in_background: false
})
```

**Important**: Both Task calls must be made in a single message to run in parallel.

### Step 5: Report Results

After both agents complete, provide a summary:

```markdown
## Code Review Complete

Both agents have completed their reviews:

### Static Code Analysis (code-review agent)
- Branch: `u/code-review/review-N`
- Feedback: `.agents/code-review-N.md`
- Focus: Code quality, maintainability, patterns, type safety

### Quality Assurance (quality-assurance agent)
- Branch: `u/qa/qa-report-N`
- Report: `.agents/qa-report-N.md`
- Focus: Runtime behavior, spec compliance, automated tests, security

### Next Steps
1. Review both feedback files
2. Address findings as appropriate
3. Merge agent branches back to main when satisfied
```

## Agent Coordination

### Parallel Execution
Both agents run simultaneously for efficiency. They work on independent branches:
- `code-review` creates `u/code-review/review-N` branch
- `quality-assurance` creates `u/qa/qa-report-N` branch

### No Conflicts
Since each agent:
- Works on its own topic branch
- Only creates/modifies its own feedback files
- Never modifies source code

There are no merge conflicts between them.

### Review Numbers
Each agent maintains its own sequence:
- Code review rounds: `review-1`, `review-2`, `review-3`, ...
- QA test rounds: `qa-report-1`, `qa-report-2`, `qa-report-3`, ...

These sequences are independent and may not align (e.g., you might have 3 code reviews but 5 QA reports).

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
