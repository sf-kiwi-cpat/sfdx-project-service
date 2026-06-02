<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->

# Per-Project Unique App Metadata DeveloperName Contract

## Purpose

Defines invariants for the DeveloperName of any metadata that templates ship singular — UIBundle (every template) and CustomApplication (today: data-curator only). Today every project deploys a UIBundle named literally `App`, and every data-curator project deploys a CustomApplication named literally `Data_Curator`. Both collide on shared orgs. This contract pins the *invariants* — uniqueness, idempotency, format, and the cross-references that must track each rename — without prescribing a generation strategy.

The invariants apply generically to any metadata file the template ships under a directory that holds a single component. Today that's UIBundle and CustomApplication; tomorrow it could be `webapplications/`, `tabs/`, or others.

**Scope of this spec:** new project creation and the build/deploy pipeline's relationship between the on-disk bundle directory, the deployed bundle's `fullName`, and the returned `appUrl` — plus the on-disk consistency of cross-references to a renamed component (CustomApplication references in metadata, and `.forceignore` globs pinned to the bundle directory). **Out of scope:** the human-readable `<masterLabel>`, migration of pre-existing on-disk projects, multi-bundle templates.

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

### 3. Cross-reference rewrites that track the rename
Renaming a component is not sufficient on its own — other files in the project reference the old DeveloperName and break the deploy unless they are rewritten in lockstep:

- **CustomApplication references.** Every `<application>…</application>` reference in the project's metadata tree (PermissionSet / Profile `<applicationVisibilities>`) resolves to the **renamed** CustomApplication, not the template's original literal. Without this, the deploy fails with "In field: application - no CustomApplication named `<old>` found".
- **`.forceignore` bundle globs.** Every `.forceignore` glob scoped to the bundle path (`uiBundles/<segment>/…`) points at the **renamed** bundle directory that actually exists on disk. Without this, the rules stop matching after the rename and the bundle's `node_modules/`, `src/`, and lockfiles are swept into the UIBundle content payload — exceeding the Metadata API's 39MB / 10,000-file limit ("Content deployment failed for UIBundle").
- **No-op on blank projects.** A blank project ships no UIBundle and no CustomApplication, so both rewrites are no-ops: no bundle-scoped glob is injected into `.forceignore`, and no `<application>` reference is fabricated.

### 4. Idempotency for a single project
Rebuilding the same project does **not** change its UIBundle DeveloperName, and does **not** change its CustomApplication DeveloperName (when present). Otherwise each redeploy creates an orphaned component in the org.

### 5. On-disk consistency
A newly-created project has exactly one UIBundle directory under `force-app/main/default/uiBundles/`. The `*.uibundle-meta.xml` filename inside that directory matches the directory's name.

### 6. `appUrl` (cross-reference)
The `appUrl` returned in the deployment-complete event is built from the deployed UIBundle's `fullName` — that shape is pinned by [`spec/deploy/contract.md`](../deploy/contract.md). This spec does not re-assert the URL shape; the on-disk and uniqueness invariants here transitively constrain what `fullName` reaches the deploy contract and therefore what `appUrl` interpolates.

## What is NOT specified

- **Generation strategy.** Implementations may use a hash, a random suffix, a template-stamped opaque token, an adjective-noun combo, or any other scheme — as long as the invariants hold. A natural choice is a single per-project token (e.g. `_8f3a2c1b`) suffixed onto every singular-shipped component name (so UIBundle becomes `App_8f3a2c1b` and CustomApplication becomes `Data_Curator_8f3a2c1b`), but the spec does not require this specific approach.
- **Where uniqueness state is persisted.** A reasonable implementation persists the chosen DeveloperName(s) in `.project-meta.json` so rebuilds are idempotent; the spec does not require this specific location.
- **How cross-references are discovered or rewritten.** The implementation may walk the whole `force-app` tree, enumerate metadata types, or use any other discovery; the spec asserts only the resulting on-disk state, not the mechanism.
- **The sibling-name precision guard.** A bundle named `App` must not rewrite a sibling like `AppExtras` (the rewrite is anchored on the trailing slash). No shipped template provides a sibling bundle to exercise this through the HTTP surface, so it is covered by a unit test (`tests/unit/app-naming.test.ts`) rather than this contract. The contract's `.forceignore` assertion still partially constrains it: the bundle-segment extraction is slash-delimited, so a stale pre-rename `App/` prefix would surface as a segment mismatch.
- **Migration of pre-existing on-disk projects.** Projects created before this contract ships are implementation freedom: they may keep the legacy literal names, be lazily renamed on first build, or be eagerly migrated. Tests cover newly-created projects only.
- **Blank projects' naming.** `POST /v1/projects` without a `template` argument creates a project that ships no UIBundle (and no CustomApplication). No naming invariant applies — only the no-op rewrite invariant (§3) does.
- **Human-readable labels.** The `<masterLabel>` inside `*.uibundle-meta.xml` and the `<label>` inside `*.app-meta.xml` are user-facing display names and are not pinned by this contract.

## Test Surface

The spec drives all assertions through the public HTTP surface:
- `POST /v1/projects` to create a project (with a template, or blank)
- `POST /v1/projects/:id/deployments` to deploy
- The created project's observable on-disk tree (bundle directory, CustomApplication file, `<application>` references, `.forceignore` globs)

Tests discover the bundle directory, CustomApplication file, application references, and `.forceignore` bundle segments via filesystem walks rather than asserting any literal path. This keeps the spec flexible — any future change to the generation scheme is implementation-only. The cross-reference assertions compare discovered references against the discovered renamed name, so they hold for any naming strategy.

## Notes for reviewers

- The two idempotency assertions pass vacuously on today's code (today's hardcoded names already don't change between builds). They function as **regression guards** during implementation, not as drivers of code change. The uniqueness tests are the assertions that fail red.
- The cross-reference rewrite assertions use the `data-curator` template as the vehicle because it ships both artifacts the rewrites target: a PermissionSet referencing its CustomApplication, and a `.forceignore` pinned to the bundle path. A single project creation exercises both rewrites end-to-end through the HTTP surface.
- All assertions are reachable through the public HTTP surface; no private helpers, no fixture mutation. An implementation that uniquifies names (and rewrites their cross-references) anywhere in the project-creation pipeline satisfies this spec.

## Summary

- 1 describe block: `per-project unique App (UIBundle) DeveloperName`
- 4 nested describes: `on-disk bundle name (DeveloperName format)` (3 tests), `uniqueness across projects` (3 tests), `cross-reference rewrites that track the rename` (3 tests), `idempotency for a single project` (2 tests)
- **11 tests total**
