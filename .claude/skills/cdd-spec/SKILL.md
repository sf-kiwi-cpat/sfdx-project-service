---
name: cdd-spec
description: Define executable contracts (specs). Drafts test code + natural language spec together, then keeps them in sync. Works standalone — gathers its own context if /cdd-brief hasn't run. Enters plan mode for discussion before pushing for review.
argument-hint: [optional: issue number, feature description, or intent]
disable-model-invocation: false
allowed-tools: Agent, Read, Glob, Bash, Write, Edit, AskUserQuestion, EnterPlanMode, EnterWorktree
---

# /cdd-spec — Define Executable Contracts

You are the contract orchestrator. Your job is to translate intent into **executable contracts**:
- Code artifact: `spec/<feature>/contract.spec.ts` (test file, human-guarded)
- Natural language artifact: `spec/<feature>/contract.md` (derived from code, auto-synced)

Both artifacts are generated together so humans can review them in parallel.

## Modes

**No arguments** → Interactive mode: prompt for feature name and intent
**With arguments** → Direct mode: use intent to draft contracts (e.g., `/cdd-spec #68`, `/cdd-spec add SSE deployment streaming`)

## Workflow

**Overall approach:** This skill gathers context, proposes contracts for discussion, refines them with the human, then pushes for review. It works standalone — `/cdd-brief` is helpful but not required.

### Step 0: Check if CDD is appropriate

Before setting up, check whether this work actually needs a contract.

**Triage check:** If the work is linked to a GitHub issue, fetch its labels.
If the issue has a `triage` label, **stop immediately** — do not draft specs
or start any workflow. Tell the user: "This issue is labeled `triage` and
needs human conversation before work begins. Want to remove the triage label
and proceed, or discuss first?" Only continue if the user explicitly approves.

**Scope check:** Contracts are for new or changed observable behavior (new
endpoints, response shape changes, new error conditions). If the work is a
doc change, chore, refactor, dependency bump, or bug fix with no behavior
change, suggest skipping the contract workflow: "This looks like a [type].
You probably don't need a formal spec — just start coding. Want to proceed
with /cdd-spec anyway?" Only continue if the user confirms.

### Step 1: Environment Setup (auto-detected)

Check the current environment and set up what's missing:

**Worktree:** Check if already in a worktree (`git worktree list` — if cwd is not the
main worktree, you're in one). If not, and this is for a GitHub issue, offer to
create one:
- Branch convention: `t/{user}/issue-{N}-{slug}`
- Use `EnterWorktree` to create it
- Run `npm install` synchronously — do not rely on the `SessionStart` hook

**Assignee:** If working on a GitHub issue, claim it:
```bash
ISSUE_NUMBER=$(git branch --show-current | sed 's/.*issue-\([0-9]*\).*/\1/')
if [ -n "$ISSUE_NUMBER" ] && [ "$ISSUE_NUMBER" != "$(git branch --show-current)" ]; then
  gh issue edit $ISSUE_NUMBER --add-assignee $(gh api user -q .login)
fi
```

### Step 2: Gather Context
- If an issue number is provided, fetch details using `gh issue view`
- If description is provided, use it directly
- If no arguments, ask the user interactively for feature name and intent
- Check for existing specs in `spec/` that might overlap or relate
- Look at related source files to understand current implementation state

### Step 3: AI Drafts Both Artifacts Simultaneously

**Generate `spec/<feature>/contract.spec.ts`:**
- Executable test file using vitest
- Covers happy path + error cases
- High-level (contracts, not unit tests)
- TODOs for uncertain areas
- Include a header comment explaining the contract

**Generate `spec/<feature>/contract.md`:**
- Mechanically derived from the test structure
- Sections: Endpoints, Requests, Responses, Error Cases, Design Principles
- Formatted for stakeholder review
- Includes examples
- Never manually edited (always regenerated from code)

### Step 4: Present Both to Human
Show side-by-side or sequentially:
1. The natural language spec (easier to review)
2. The code spec (executable assertions)

Ask: "Do these contracts match your intent? Any changes needed?"

### Step 5: Discussion & Refinement

**Enter plan mode** to discuss contracts with the human:
- Use `EnterPlanMode` to signal that you're ready for collaborative design discussion
- Present both the code and prose specs for review
- Discuss architecture, design principles, edge cases
- Get human approval on the approach before implementation

**Refinement loop** (if changes needed):
- Human edits `spec/<feature>/contract.spec.ts` directly
- Run derivation tool to regenerate `spec/<feature>/contract.md`
- Show updated spec for re-review
- Return to discussion as needed
- Repeat until both artifacts are approved

### Step 6: Push for Review & Commit

Once human approves both artifacts:
- Commit both `contract.spec.ts` and `contract.md` to the branch
  - Use conventional commit format: `spec({feature}): {description}`
  - Reference the issue in the body: `Closes #N` or `Part of #N`
- Push to remote
- Create a **draft PR** (or ensure existing PR is draft). Draft PRs signal
  that the spec is not yet agent-reviewed — humans should not review until
  the agent clears it and marks it ready:
  ```bash
  BRANCH=$(git branch --show-current)
  PR_NUMBER=$(gh pr list --head "$BRANCH" --json number -q '.[0].number')

  ME=$(gh api user -q .login)

  if [ -z "$PR_NUMBER" ]; then
    gh pr create --draft --assignee "$ME" \
      --title "spec({feature}): {description}" \
      --body "$(cat <<'EOF'
  ## Summary
  - ...

  Part of #N
  EOF
  )"
    PR_NUMBER=$(gh pr list --head "$BRANCH" --json number -q '.[0].number')
  else
    # Ensure existing PR is in draft mode and has an assignee
    gh pr ready "$PR_NUMBER" --undo 2>/dev/null || true
    gh pr edit "$PR_NUMBER" --add-assignee "$ME"
  fi
  ```
- Update workflow labels to signal readiness for agent review.
  **Use `gh api` for labels** — `gh issue/pr edit --add-label` is unreliable
  (silently fails due to Projects Classic deprecation). PRs are issues in the
  GitHub API, so the same `/issues/` endpoint works for both:
  ```bash
  ISSUE_NUMBER=$(echo "$BRANCH" | sed 's/.*issue-\([0-9]*\).*/\1/')

  if [ -n "$ISSUE_NUMBER" ] && [ "$ISSUE_NUMBER" != "$BRANCH" ]; then
    gh api repos/{owner}/{repo}/issues/$ISSUE_NUMBER/labels --method POST -f 'labels[]=spec:agent-reviewing'
  fi

  if [ -n "$PR_NUMBER" ]; then
    gh api repos/{owner}/{repo}/issues/$PR_NUMBER/labels --method POST -f 'labels[]=spec:agent-reviewing'
  fi
  ```
- Notify: **"Draft PR created — specs pushed for agent review!"** The spec
  review loop will automatically run `/cdd-spec-review`. When the agent
  clears the spec, the PR is marked ready for human review.

---

## Key Responsibilities

1. **Scaffold the folder structure** — Create `spec/<feature>/` directory with README, contract files
2. **Draft test code** — Generate `.spec.ts` based on intent and context
3. **Derive natural language** — Generate `.md` from test structure automatically
4. **Show both for review** — Present prose + code together
5. **Maintain sync** — When code changes, regenerate prose immediately
6. **Lock the contract** — Mark as human-guarded once approved

---

## Important Principles

- **Test is source of truth** — Prose is always derived from code, never the reverse
- **Never edit prose manually** — `contract.md` is auto-generated; changes always go to `.spec.ts`
- **Derivation tool is critical** — Parser must accurately extract test structure
- **Side-by-side review** — Show code and prose together so human can verify they're in sync
- **Lock after approval** — Both files are human-guarded; implementation agent cannot modify

---

## Derivation Tool

The derivation tool parses `contract.spec.ts` and generates `contract.md`:

**Inputs:**
- File path to `.spec.ts`
- Feature name (for titles)

**Outputs:**
- Structured markdown with:
  - Endpoint list (from describe blocks)
  - Request/response shapes (from test setup and assertions)
  - HTTP status codes (from .expect() calls)
  - Error cases (from negative tests)
  - Examples (derived from test data)

### Derivation Algorithm

**Parse the test file to extract:**
1. Describe blocks → endpoint groupings (e.g., "POST /v1/projects/:id/deployments")
2. HTTP method + path from describe block name
3. It blocks within each describe → individual test cases
4. `.expect(STATUS)` calls → HTTP response codes
5. Test names → human-readable behavior descriptions

**Generate markdown with sections:**
- **Endpoints** — Grouped by HTTP method and path
- **Status codes** — Organized under each endpoint (200, 202, 400, 404, 502, etc.)
- **Test descriptions** — Listed under status codes
- **Summary** — Count of blocks and tests

### Example Extraction

**Input (contract.spec.ts):**
```typescript
describe('POST /v1/projects/:id/deployments', () => {
  it('returns 202 Accepted with deploymentId', async () => {
    const res = await request(app)
      .post(`/v1/projects/${projectId}/deployments`)
      .send(credentials)
      .expect(202);
    expect(res.body).toHaveProperty('deploymentId');
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app)
      .post(`/v1/projects/${projectId}/deployments`)
      .send({})
      .expect(400);
    expect(res.body.status).toBe(400);
  });
});
```

**Output (contract.md section):**
```markdown
### POST `/v1/projects/:id/deployments`

**202**
- returns 202 Accepted with deploymentId

**400**
- returns 400 when credentials are missing
```

### Keeping Prose in Sync

**When human edits `contract.spec.ts`:**
1. Skill detects the change (human edits the file)
2. Skill re-parses the updated test file
3. Skill regenerates `contract.md` with new structure
4. Human verifies prose still matches intent
5. Both files committed together

**Manual refresh (if needed):**
```bash
/cdd-spec --refresh <feature-name>
# Re-parses contract.spec.ts
# Regenerates contract.md
# Shows both for verification
```

**Guard rails:**
- `contract.md` is marked read-only in header comment (warns against manual edits)
- If human edits `.md` manually, it will be overwritten on next refresh
- Source of truth is always `contract.spec.ts`

---

## Examples

### Example 1: Direct Mode (Issue Number)
```bash
/cdd-spec #68
# Fetches issue #68 details
# Drafts contract.spec.ts + contract.md for async deployment
# Presents both for review
```

### Example 2: Direct Mode (Description)
```bash
/cdd-spec add SSE deployment streaming
# Uses description to draft contract
# Generates spec/deploy-sse/contract.spec.ts + contract.md
# Presents both
```

### Example 3: Interactive Mode
```bash
/cdd-spec
# → What feature are you defining a contract for?
# → My intent is...
# Drafts contracts
# Presents both
```

---

## Related Skills

These skills complement `/cdd-spec`, but none are prerequisites:

- **`/cdd-brief`** — Gathers context (helpful before writing specs, but /cdd-spec gathers its own)
- **`/cdd-implement`** — Writes code to satisfy contract tests
- **`/cdd-code-review`** — Verifies correctness and code quality
- **`/cdd-spec-review`** — Evaluates spec quality before human approval

**Automation:** After specs are pushed (`spec:agent-reviewing`),
`cdd-spec-review-monitor` runs `/cdd-spec-review`. After human approves
(`spec:human-approved`), `cdd-implement-monitor` runs `/cdd-implement`.
After implementation completes (`impl:agent-reviewing`),
`cdd-code-review-monitor` runs `/cdd-code-review`.
