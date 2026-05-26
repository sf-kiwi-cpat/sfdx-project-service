<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->

# Per-Project Unique App Metadata DeveloperName Contract

## Purpose

Defines invariants for the DeveloperName of any metadata that templates ship singular — UIBundle (every template) and CustomApplication (today: data-curator only). Today every project deploys a UIBundle named literally `App`, and every data-curator project deploys a CustomApplication named literally `Data_Curator`. Both collide on shared orgs. This contract pins the *invariants* — uniqueness, idempotency, format — without prescribing a generation strategy.

The invariants apply generically to any metadata file the template ships under a directory that holds a single component. Today that's UIBundle and CustomApplication; tomorrow it could be `webapplications/`, `tabs/`, or others.

**Scope of this spec:** new project creation and the build/deploy pipeline's relationship between the on-disk bundle directory, the deployed bundle's `fullName`, and the returned `appUrl`. **Out of scope:** the human-readable `<masterLabel>`, migration of pre-existing on-disk projects, multi-bundle templates.

## Invariants

### 1. Format
Every singular-shipped metadata DeveloperName is a valid Salesforce DeveloperName:

```
^[A-Za-z][A-Za-z0-9_]{0,79}$
```

Starts with a letter, alphanumeric or underscore otherwise, ≤80 characters.

### 2. Uniqueness across projects
Two distinct projects created from the same template have **different** UIBundle DeveloperNames. For templates that also ship a CustomApplication (e.g. `data-curator`), two distinct projects also have **different** CustomApplication DeveloperNames.

This prevents collisions on shared orgs across every singular-shipped metadata kind. The contract is asserted against both shipped templates that contain a UIBundle (`data-curator`, `local-react-test`) so the implementation cannot be silently special-cased to one template.

### 3. Idempotency for a single project
Rebuilding the same project does **not** change its UIBundle DeveloperName, and does **not** change its CustomApplication DeveloperName (when present). Otherwise each redeploy creates an orphaned component in the org.

### 4. On-disk consistency
A newly-created project has exactly one UIBundle directory under `force-app/main/default/uiBundles/`. The `*.uibundle-meta.xml` filename inside that directory matches the directory's name.

### 5. `appUrl` (cross-reference)
The `appUrl` returned in the deployment-complete event is built from the deployed UIBundle's `fullName` — that shape is pinned by [`spec/deploy/contract.md`](../deploy/contract.md). This spec does not re-assert the URL shape; the on-disk and uniqueness invariants here transitively constrain what `fullName` reaches the deploy contract and therefore what `appUrl` interpolates.

## What is NOT specified

- **Generation strategy.** Implementations may use a hash, a random suffix, a template-stamped opaque token, an adjective-noun combo, or any other scheme — as long as the invariants hold. A natural choice is a single per-project token (e.g. `_8f3a2c1b`) suffixed onto every singular-shipped component name (so UIBundle becomes `App_8f3a2c1b` and CustomApplication becomes `Data_Curator_8f3a2c1b`), but the spec does not require this specific approach.
- **Where uniqueness state is persisted.** A reasonable implementation persists the chosen DeveloperName(s) in `.project-meta.json` so rebuilds are idempotent; the spec does not require this specific location.
- **Migration of pre-existing on-disk projects.** Projects created before this contract ships are implementation freedom: they may keep the legacy literal names, be lazily renamed on first build, or be eagerly migrated. Tests cover newly-created projects only.
- **Blank projects.** `POST /v1/projects` without a `template` argument creates a project that ships no UIBundle (and no CustomApplication). No naming invariant applies.
- **Human-readable labels.** The `<masterLabel>` inside `*.uibundle-meta.xml` and the `<label>` inside `*.app-meta.xml` are user-facing display names and are not pinned by this contract.

## Test Surface

The spec drives all assertions through the public HTTP surface:
- `POST /v1/projects` to create a project
- `POST /v1/projects/:id/deployments` to deploy
- The deployment record's `appUrl` field

Tests discover the bundle directory and CustomApplication file via `fs.readdir` rather than asserting any literal path. This keeps the spec flexible — any future change to the generation scheme is implementation-only.

## Notes for reviewers

- The two idempotency assertions pass vacuously on today's code (today's hardcoded names already don't change between builds). They function as **regression guards** during implementation, not as drivers of code change. The uniqueness tests are the assertions that fail red.
- All assertions are reachable through the public HTTP surface; no private helpers, no fixture mutation. An implementation that uniquifies names anywhere in the project-creation pipeline satisfies this spec.

## Summary

- 1 describe block: `per-project unique App (UIBundle) DeveloperName`
- 3 nested describes: `on-disk bundle name (DeveloperName format)` (3 tests), `uniqueness across projects` (3 tests), `idempotency for a single project` (2 tests)
- **8 tests total**
