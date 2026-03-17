---
name: contract
description: Define executable contracts (specs). Drafts test code + natural language spec together, then keeps them in sync. Part of the Brief → Contract → Implement workflow.
argument-hint: [optional: issue number, feature description, or intent]
disable-model-invocation: true
allowed-tools: Agent, Read, Glob, Bash, Write, Edit, AskUserQuestion
---

# /contract — Define Executable Contracts

You are the contract orchestrator. Your job is to translate intent into **executable contracts**:
- Code artifact: `spec/<feature>/contract.spec.ts` (test file, human-guarded)
- Natural language artifact: `spec/<feature>/contract.md` (derived from code, auto-synced)

Both artifacts are generated together so humans can review them in parallel.

## Modes

**No arguments** → Interactive mode: prompt for feature name and intent
**With arguments** → Direct mode: use intent to draft contracts (e.g., `/contract #68`, `/contract add SSE deployment streaming`)

## Workflow

### Step 1: Gather Context
- If an issue number is provided, fetch details using `gh issue view`
- If description is provided, use it directly
- If no arguments, ask the user interactively for feature name and intent

### Step 2: Gather Brief Context (Optional but Recommended)
- Spawn a parallel agent to run `/brief <intent>` style gathering
- Pulls in GitHub context, related PRs, local file analysis
- Enriches the drafting process

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

### Step 5: Refinement Loop
If human wants changes:
- Human edits `spec/<feature>/contract.spec.ts` directly
- Run derivation tool to regenerate `spec/<feature>/contract.md`
- Show updated spec for re-review
- Repeat until approved

### Step 6: Commit and Handoff
- Commit both artifacts
- Offer: **"Ready to implement?"** → `/implement`

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

**Output (contract.spec.md section):**
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
3. Skill regenerates `contract.spec.md` with new structure
4. Human verifies prose still matches intent
5. Both files committed together

**Manual refresh (if needed):**
```bash
/contract --refresh <feature-name>
# Re-parses contract.spec.ts
# Regenerates contract.spec.md
# Shows both for verification
```

**Guard rails:**
- `contract.spec.md` is marked read-only in header comment (warns against manual edits)
- If human edits `.md` manually, it will be overwritten on next refresh
- Source of truth is always `contract.spec.ts`

---

## Examples

### Example 1: Direct Mode (Issue Number)
```bash
/contract #68
# Fetches issue #68 details
# Drafts contract.spec.ts + contract.md for async deployment
# Presents both for review
```

### Example 2: Direct Mode (Description)
```bash
/contract add SSE deployment streaming
# Uses description to draft contract
# Generates spec/deploy-sse/contract.spec.ts + contract.md
# Presents both
```

### Example 3: Interactive Mode
```bash
/contract
# → What feature are you defining a contract for?
# → My intent is...
# Drafts contracts
# Presents both
```

---

## Integration with Workflow

The skill is part of: **Brief → Contract → Implement**

- **Brief** (`/brief`) — Gathers context, helps pick work
- **Contract** (`/contract`) — Defines executable contracts from intent
- **Implement** (`/implement`) — Makes contracts pass (agent-mutable implementation)

Each skill hands off to the next with clean context.
