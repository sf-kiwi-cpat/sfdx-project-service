# Code Review Feedback (Round 3) — SF Project Service

Review of commit `fb5502b` ("Block file operations on sensitive paths") against the finding in `feedback-2.md`.

---

## Status of Round 2 Finding

The core issue — file read/write/delete endpoints serving sensitive paths — has been addressed. The fix adds an `isRestrictedPath()` check in `resolveProjectPath()`, which is the right place to put it. GET, PUT, and DELETE against `.sf/auth.json`, `.git/config`, `.env`, and `node_modules/` all correctly return 400 with an RFC 9457 response. The traversal variant `force-app/../.sf/auth.json` is also caught because `path.normalize()` resolves it to `.sf/auth.json` before the check runs.

59 tests pass (up from 55). TypeScript compiles clean. ESLint reports no issues. The 4 new tests cover the three HTTP methods and the unit-level `resolveProjectPath` behavior.

---

## New Findings

### 1. Restricted-path check only examines the first path segment — nested sensitive directories are accessible

**Severity:** Bug (security, low-to-medium) — same class as the original Bug #1

**File:** `src/files.ts:40-44` — `isRestrictedPath()`

```typescript
function isRestrictedPath(relative: string): boolean {
  const segments = relative.split(/[/\\]/).filter(Boolean);
  const first = segments[0];
  return first !== undefined && shouldIgnoreEntry(first);
}
```

This only checks `segments[0]`. A restricted name at any deeper level is not caught. Confirmed via curl:

```
GET  /project/file?path=force-app/.hidden/secret.txt     → 200 (returns content)
GET  /project/file?path=force-app/.git/config             → 200 (returns content)
GET  /project/file?path=force-app/node_modules/pkg.js     → 200 (returns content)
PUT  /project/file?path=force-app/.sf/evil.json           → 200 (writes file)
```

Meanwhile, `buildTree()` applies `shouldIgnoreEntry()` at *every* level of recursion (line 65), so these same paths are hidden from the tree response. This means a nested `.git` or `node_modules` directory is invisible in the tree but fully accessible through the file endpoints — the same inconsistency pattern as the original bug.

In practice, nested `.git` submodules, nested `node_modules` from monorepo layouts, and dotfiles like `.eslintrc` or `.prettierrc` inside subdirectories will all be accessible via the file API despite being hidden from the tree.

**What to do:** Change `isRestrictedPath` to check every segment, not just the first:

```typescript
function isRestrictedPath(relative: string): boolean {
  const segments = relative.split(/[/\\]/).filter(Boolean);
  return segments.some((seg) => shouldIgnoreEntry(seg));
}
```

Update the unit test in `files.test.ts` to cover nested restricted paths (e.g., `force-app/.git/config`, `force-app/node_modules/pkg.js`). The existing integration tests in `routes.test.ts` only test top-level `.sf/auth.json` — add at least one integration test for a nested restricted path as well.

---

### 2. Error-to-status-code mapping relies on exact string matching — brittle coupling between `files.ts` and `errors.ts`

**Severity:** Code quality (medium)

**File:** `src/errors.ts:23-26` — `errorToProblem()`

```typescript
if (err.message === 'Access to this path is restricted') {
  return problemDetail(400, 'Bad Request', err.message);
}
```

The restricted-path error is identified by comparing `err.message` against an exact literal string. The same pattern already existed for `'Path escapes project root'` (uses `startsWith`), `'No file exists'` (uses `startsWith`), and `'Not a file:'` (uses `startsWith`). The new entry is the strictest of the four — it uses `===` rather than `startsWith`.

This works today, but it's a fragile contract: if someone changes the error message text in `files.ts` without updating the matching string in `errors.ts`, the error silently falls through to the catch-all 500. There's no type system or test to enforce the coupling.

**What to do:** One clean approach: define a small set of typed error classes (e.g., `RestrictedPathError`, `PathTraversalError`, `FileNotFoundError`) in a shared module and use `instanceof` checks in `errorToProblem()` instead of string matching. This eliminates the fragile coupling and makes each error's HTTP mapping explicit. If custom error classes feel heavyweight, a simpler alternative is to add a `code` string property to the thrown errors (e.g., `err.code = 'RESTRICTED_PATH'`) and match on that.

This isn't blocking — the current code works — but it's a maintenance risk that grows with each new error type added to the string-matching chain.

---

## Summary

The security fix is correctly placed in `resolveProjectPath()`, which is the single gate for all file operations. The top-level sensitive paths are properly blocked. The two findings above are: (1) the restriction needs to be applied to all segments, not just the first, to match the depth of filtering that `buildTree()` already applies; and (2) the error-mapping pattern is getting brittle and would benefit from a more structured approach.

Finding #1 is the higher priority — it's a direct continuation of the original Bug #1 and can be fixed with a one-line change (`segments[0]` → `segments.some()`). Finding #2 is a code quality improvement that doesn't need to block the security fix.
