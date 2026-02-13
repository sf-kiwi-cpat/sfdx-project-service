# Code Review Feedback (Round 4) — SF Project Service

Review of commit `5f40e7e` ("Address feedback-3: nested restricted paths + typed error classes") against the two findings in `feedback-3.md`.

---

## Status of Round 3 Findings

### Finding #1 (nested restricted paths) — Resolved

The one-line fix in `isRestrictedPath()` is exactly what was asked for:

```typescript
// Before (feedback-3 finding)
const first = segments[0];
return first !== undefined && shouldIgnoreEntry(first);

// After
return segments.some((seg) => shouldIgnoreEntry(seg));
```

Confirmed via curl spot-checks that the following previously-bypassed paths now correctly return 400:

```
GET  /project/file?path=force-app/.git/config          → 400 ✓
GET  /project/file?path=force-app/.hidden/secret.txt    → 400 ✓
GET  /project/file?path=force-app/node_modules/pkg.js   → 400 ✓
PUT  /project/file?path=force-app/.sf/evil.json         → 400 ✓
DELETE /project/file?path=force-app/node_modules/pkg.js → 400 ✓
```

Deeper nesting and traversal combinations also blocked:

```
GET  /project/file?path=force-app/main/default/.secret/config  → 400 ✓
GET  /project/file?path=force-app/main/../.git/config          → 400 ✓
```

The tree endpoint continues to filter these at every level, so tree and file operations are now consistent. Legitimate files remain accessible (200).

New unit tests (`files.test.ts:41-48`) cover four nested restricted path variants: `.git`, `node_modules`, `.sf`, and a dotfile at depth. New integration test (`routes.test.ts:182-194`) covers GET against `force-app/.git/config`. This is sufficient coverage.

### Finding #2 (typed error classes) — Resolved

All four error types are now proper `Error` subclasses defined in `errors.ts`:

- `RestrictedPathError` (line 20)
- `PathTraversalError` (line 28)
- `FileNotFoundError` (line 36)
- `NotAFileError` (line 44)

`errorToProblem()` uses `instanceof` checks instead of string matching. `files.ts` imports and throws these classes directly. The coupling is now enforced by the type system — renaming or removing an error class produces a compile error, not a silent 500 at runtime.

The error test file (`errors.test.ts`) has been updated to construct typed errors and verify the mapping. All four error classes are tested.

---

## Automated Checks

| Check | Result |
|:---|:---|
| `npx tsc --noEmit` | Clean (zero errors) |
| `npx eslint .` | Clean (zero errors) |
| `npm test` | 62 tests pass (up from 59) — 3 new tests added |
| `npm run build` | Clean |

---

## New Findings

No new bugs, security issues, or spec deviations found.

The remediation is clean and focused — it addresses both findings without introducing extraneous changes. The error class hierarchy is a genuine improvement to the codebase structure that will pay dividends as new error types are added.

---

## Summary

Both findings from Round 3 are fully resolved. The nested restricted path security hole is closed, and the error mapping is now type-safe. After four rounds of review, the security posture of the file operations is solid: `resolveProjectPath()` is the single gate, it checks traversal and restricted paths at all segment depths, and the restriction rules match what `buildTree()` applies in the tree response.

No further findings to report. The code is ready for the next phase of work.
