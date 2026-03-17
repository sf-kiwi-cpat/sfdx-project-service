# Development Workflow: Brief → Contract → Implement

This document describes the three-phase workflow for defining and implementing features in sf-project-service.

## The Workflow

```
/brief [intent]
  ↓
Gathers context from GitHub, local state, transcripts
Shows landscape or focused context
  ↓
User picks work
  ↓
[Optional: create worktree]
  ↓
/contract [intent or issue]
  ↓
AI drafts BOTH:
  - contract.spec.ts (executable tests)
  - contract.spec.md (derived prose spec)
  ↓
Human reviews both artifacts in parallel
  ↓
Human makes changes (edits contract.spec.ts if needed)
  ↓
contract.spec.md is regenerated to stay in sync
  ↓
Human approves both artifacts
  ↓
Commit both files
  ↓
/implement [contract path]
  ↓
AI implements to make contract tests pass
  ↓
Implementation agent is mutable
Human can review, request changes, tests must pass
  ↓
Merge to main
```

## Phase 1: Brief (`/brief`)

**Purpose:** Gather context and understand what work needs doing

**Inputs:**
- Optional: issue number, feature description, or intent
- Implicit: GitHub state, local git state, transcripts, discussions

**Outputs:**
- Landscape view: "Here's what's available to work on"
- Or context view: "Here's everything about this specific work"
- Ready-to-use context for the next phase

**Command:**
```bash
/brief                    # Landscape mode
/brief #68                # Context mode: specific issue
/brief add SSE streaming  # Context mode: description
```

**Handoff:**
Offers next step: `/contract` → define executable contracts

---

## Phase 2: Contract (`/contract`)

**Purpose:** Define executable contracts (what the system should do)

**Key Principle:**
The contract is defined in two formats that are always in sync:
- **Code format:** `contract.spec.ts` — executable tests (source of truth)
- **Prose format:** `contract.spec.md` — derived human-readable spec

**Workflow:**

1. **AI drafts both simultaneously** from context
   - Reads intent and brief context
   - Generates `spec/<feature>/contract.spec.ts` with tests
   - Automatically derives `spec/<feature>/contract.spec.md` from the test structure

2. **Human reviews both in parallel**
   - Reads `contract.spec.md` for high-level understanding
   - Reviews `contract.spec.ts` for detailed assertions
   - Both should align; if not, something is wrong

3. **Human refines (if needed)**
   - Edits `contract.spec.ts` (the executable contract)
   - Never edits `contract.spec.md` (it's auto-generated)
   - Runs derivation to regenerate prose
   - Re-reviews until both are correct

4. **Approval & Commit**
   - Both files are human-guarded (locked for implementation phase)
   - Commit both to feature branch

**Files:**
```
spec/<feature>/
├── contract.spec.ts      # Executable tests (source of truth)
├── contract.spec.md      # Derived prose spec (auto-generated, read-only)
└── README.md             # Context about this contract
```

**Key Rules:**
- Test file is source of truth
- Prose is always derived from code, never hand-edited
- Both must be in sync before approval
- Use `/contract --refresh <feature>` to regenerate prose if needed

**Command:**
```bash
/contract #68                    # Draft from issue
/contract add SSE streaming      # Draft from description
/contract --refresh deploy       # Regenerate prose from tests
```

**Handoff:**
Once approved: Ready to implement? → `/implement`

---

## Phase 3: Implement (`/implement`)

**Purpose:** Write code to make contract tests pass

**Key Principle:**
Implementation is **agent-mutable** but must satisfy the **human-guarded contract**

**Workflow:**

1. **AI implements from contract**
   - Reads `contract.spec.ts` to understand the contract
   - Writes production code to make tests pass
   - Also writes unit and integration tests (mutable)
   - Cannot modify `contract.spec.ts` or `contract.spec.md` (human-guarded)

2. **Tests must pass**
   - Contract tests must pass (hard requirement)
   - Unit/integration tests should pass (quality check)
   - Coverage threshold must be met (90% on main branches)

3. **Human reviews**
   - Reviews implementation code
   - Can request changes
   - Re-runs tests to verify

4. **Merge**
   - Once approved, merge to main
   - CI checks run again
   - Done

**Commands:**
```bash
/implement spec/deploy/contract.spec.ts
```

**Constraints:**
- Cannot edit `spec/**/*.spec.ts` files
- Cannot edit `spec/**/*.spec.md` files
- Can create/edit production code
- Can create/edit unit/integration tests
- All contract tests must pass

---

## Directory Structure

```
sf-project-service/
├── spec/                          # Human-guarded contracts
│   ├── deploy/                    # Deployment contract
│   │   ├── contract.spec.ts       # Executable contract (tests)
│   │   ├── contract.spec.md       # Prose specification (derived)
│   │   └── README.md              # Contract context
│   ├── projects/                  # Project management contract
│   │   └── ...
│   └── templates/                 # Template contract
│       └── ...
├── src/                           # Production code (mutable)
│   ├── domain/                    # Business logic
│   ├── routes/                    # HTTP handlers
│   └── ...
├── tests/unit/                    # Unit tests (mutable)
├── tests/integration/             # Integration tests (mutable)
└── .claude/skills/
    ├── brief/                     # Gathering context
    ├── contract/                  # Defining contracts
    └── implement/                 # Implementing contracts (future)
```

---

## Tools & Commands

### derive-contract.ts
Parses a `contract.spec.ts` file and generates `contract.spec.md`

Located: `.claude/skills/contract/derive-contract.ts`

**Usage:**
```bash
# From command line (in Node environment)
npx ts-node derive-contract.ts <spec-dir> <feature-name>

# From within a skill
const markdown = await deriveContract(specPath, featureName);
```

**Sync Guarantee:**
- Always run after editing `contract.spec.ts`
- Ensures `contract.spec.md` is fresh
- Prevents drift between code and prose

---

## Example: Deploying with Async SSE

### Phase 1: Brief
```bash
/brief #68
# Output: Full context about issue #68 (async deployment)
```

### Phase 2: Contract
```bash
/contract #68
# AI drafts:
#   - spec/deploy/contract.spec.ts (3 describe blocks, 20+ test cases)
#   - spec/deploy/contract.spec.md (auto-derived)
#
# Human reviews contract.spec.md:
#   - POST /v1/projects/:id/deployments returns 202
#   - GET /v1/projects/:id/deployments/:deploymentId returns current status
#   - GET /v1/projects/:id/deployments/:deploymentId/events streams SSE
#   - Validates input and handles errors
#
# Human reviews contract.spec.ts:
#   - Confirms tests match the prose
#   - Suggests refinements if needed
#
# Human approves both
# Commit: contract.spec.ts + contract.spec.md
```

### Phase 3: Implement
```bash
/implement spec/deploy/contract.spec.ts
# AI writes:
#   - src/domain/deploy.ts (async deployment logic)
#   - src/routes/deploy.routes.ts (endpoint handlers)
#   - src/types/deployment.ts (types)
#   - tests/unit/deploy.test.ts (quality tests)
#   - tests/integration/deploy.integration.test.ts
#
# All contract tests pass
# Human reviews implementation
# Merge to main
```

---

## FAQ

**Q: Why have two formats of the contract?**
A: The code format is executable and precise. The prose format is human-friendly for stakeholder review. Together they ensure both precision and clarity.

**Q: What if the prose and code don't match?**
A: Regenerate the prose from the code. The code is source of truth. If they still don't match, the derivation tool needs improvement.

**Q: Can I edit contract.spec.md?**
A: No. It's auto-generated. Edit contract.spec.ts, then regenerate contract.spec.md.

**Q: What if I want to change the contract during implementation?**
A: Stop, go back to `/contract`, make the change, regenerate both artifacts, human approves, then resume implementation.

**Q: Can I skip the contract phase?**
A: No. The contract is the guarantee that implementation meets intent. Always define the contract first.

**Q: What about tests that don't fit the contract?**
A: Unit and integration tests are separate from contract tests. They're in `tests/` not `spec/`. Contract tests are high-level, public contracts only.

---

## See Also

- `.claude/skills/brief/SKILL.md` — Brief skill documentation
- `.claude/skills/contract/SKILL.md` — Contract skill documentation
- `CLAUDE.md` — Project conventions and setup instructions
- `spec/*/README.md` — Individual contract documentation
