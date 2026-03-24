<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->
<!-- Regenerate with: /cdd-spec --refresh file-read -->

# File Read Endpoint Contract

## GET `/v1/projects/:id/file?path=...`

Read the contents of a file within a project. Returns raw file contents as `text/plain`.

### 200 — Success
- Returns file contents as `text/plain`
- Reads files in nested directories (e.g., `src/hello.txt`)

### 400 — Bad Request
- Returns 400 when `path` query parameter is missing
- Returns 400 for path traversal attempts (e.g., `../../etc/passwd`)
- Returns 400 for restricted paths (`.git/`, `.sf/`, `node_modules/`, dotfiles)
- Returns 400 when path points to a directory (not a file)

### 404 — Not Found
- Returns 404 for a nonexistent project
- Returns 404 for a nonexistent file

### Error Format

All errors return `application/problem+json` with RFC 9457 structure:
```json
{ "status": 400, "title": "Bad Request", "detail": "..." }
```

---

*3 describe blocks, 8 tests*
