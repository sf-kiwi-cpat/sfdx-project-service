<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->
<!-- Regenerate with: /cdd-spec --refresh file-write -->

# File Write Endpoint Contract

## PUT `/v1/projects/:id/file`

Replace the contents of a file inside a project, or create it if missing.
Parent directories are auto-created. Path traversal and restricted paths
(`.git/`, `.sf/`, `node_modules/`, dotfiles at any segment) are rejected.

**Request body** (`application/json`, `additionalProperties: false`):
```json
{ "path": "<relative-file-path>", "content": "<utf-8 string>" }
```

### 204 — Success
- Writes a new file and returns 204 with an empty body
- Overwrites an existing file (replaces, does not append)
- Auto-creates parent directories that do not yet exist
- Round-trips: PUT then GET returns the same content

### 400 — Bad Request
- Returns 400 when `path` field is missing
- Returns 400 when `content` field is missing
- Returns 400 when `content` is not a string
- Returns 400 when `path` is empty
- Returns 400 when `path` points to an existing directory
- Returns 400 for path traversal attempts (e.g., `../../etc/passwd`)
- Returns 400 for restricted paths (`.git/`, `.sf/`, `node_modules/`)
- Returns 400 for dotfiles at any segment (e.g., `src/.env`)
- Returns 400 when path length is at or above `MAX_PATH_LENGTH`
- Returns 400 for unknown body fields (`additionalProperties: false`)

### 404 — Not Found
- Returns 404 for a nonexistent project

### Error Format

All errors return `application/problem+json` with RFC 9457 structure:
```json
{ "status": 400, "title": "Bad Request", "detail": "..." }
```

---

*3 describe blocks, 15 tests*
