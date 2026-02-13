# Code Review Feedback (Round 2) — SF Project Service

Review of commit `161837d` ("Address code review feedback") against the original findings in `feedback.md`.

---

## Status of Original Findings

All 19 items from the first review were addressed. The fixes are generally clean and correct. Specific notes:

- **Bugs #1–4** — all fixed
- **Spec Deviations #5–8** — all fixed
- **Test Coverage Gaps #9–14** — all fixed (15 new tests added, new `events.test.ts` file)
- **Code Quality #15–19** — all fixed

55 tests pass (up from 40). TypeScript compiles clean. ESLint reports no issues.

---

## New Finding

### 1. File read/write/delete endpoints still serve sensitive paths (`.sf/`, `.git/`, dotfiles)

**Severity:** Bug (security) — this is a continuation of Bug #1 from the first review

**Files:** `src/files.ts` — `resolveProjectPath()`, `readFile()`, `writeFile()`, `deleteFile()`; `src/routes.ts` — GET/PUT/DELETE `/project/file`

The `buildTree()` fix correctly filters `.git`, `.sf`, `node_modules`, and dotfiles from the tree response. However, the file read/write/delete endpoints apply no such filtering. A client that knows (or guesses) the path can still:

```
GET  /project/file?path=.sf/auth.json          → 200, returns access token
GET  /project/file?path=.git/config             → 200, returns git config
GET  /project/file?path=.env                    → 200, returns secrets
PUT  /project/file?path=.sf/malicious.json      → 200, writes arbitrary file into .sf/
```

All four of these were confirmed during curl testing against the running service.

The tree filtering hides these paths from the file explorer UI, but that's security through obscurity — the actual file operations have no access control for sensitive paths. The spec says `.sf/` contains auth credentials saved by `@salesforce/core`. Exposing those via a simple GET request defeats the purpose of filtering them from the tree.

**What to do:** Apply the same `IGNORED_NAMES` / `shouldIgnoreEntry` logic (or an equivalent check) in `resolveProjectPath()` so that all file operations — read, write, and delete — reject paths that resolve into `.sf/`, `.git/`, `node_modules/`, or dotfiles at the top level. Return `400` with an RFC 9457 response (e.g., `"Access to this path is restricted"`). Add integration tests for at least GET, PUT, and DELETE against `.sf/auth.json`.

This is the only check on the path between the client and the filesystem for these sensitive directories, so it needs to be in the path resolution layer, not just the tree builder.

---

## Summary

The remediation was thorough. All 19 original items were addressed correctly and the new tests are well-structured. The one remaining issue is that Bug #1 was only half-fixed: the tree is filtered, but the file operations still allow direct access to sensitive paths. This should be straightforward to close out — the filtering logic already exists in `files.ts`, it just needs to be enforced in `resolveProjectPath()` as well.
