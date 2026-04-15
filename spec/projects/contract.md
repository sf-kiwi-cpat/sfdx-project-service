<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->

# Projects Contract Specification

## Overview

The projects system manages SFDX project creation, listing, naming, and file tree browsing. Projects can be created from a **named template** (unzipped from disk) or as a **blank project** (minimal SFDX scaffold generated in-memory). Every project receives a human-readable **name** and a **createdAt** timestamp at creation time, and can be renamed later.

## Endpoints

### POST `/v1/projects`

**Create a new project**

**Request Body:**
- `template` (optional, string): Template identifier (e.g., `"local-react-test"`)
  - When provided: unzips the named template into a new project directory
  - When omitted: scaffolds a minimal blank SFDX project in-memory (no zip, no disk lookup)

**Responses:**

- **201 Created** — Project created successfully
  ```json
  {
    "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "name": "brave-falcon",
    "createdAt": "2026-04-13T12:00:00.000Z"
  }
  ```
  - `id` is a UUID (lowercase hex, 8-4-4-4-12 format)
  - `name` is a non-empty string (auto-generated)
  - `createdAt` is an ISO 8601 timestamp of when the project was created
  - Returned for both template-based and blank projects

- **400 Bad Request** — Invalid input
  - Template name is not recognized
  - Response: RFC 9457 Problem Detail (`application/problem+json`)

**Project Directory Contents:**

| Scenario | Contents |
|----------|----------|
| Template-based | Full template contents (unzipped from disk), including `sfdx-project.json` with `packageDirectories` (array, at least one entry) |
| Blank | Minimal `sfdx-project.json` with `packageDirectories` (array, at least one entry) + empty `force-app/main/default/` directory tree |

Both scenarios produce a valid SFDX project with `sfdx-project.json` containing a non-empty `packageDirectories` array.

---

### GET `/v1/projects`

**List all projects**

**Responses:**

- **200 OK** — Array of projects
  ```json
  [
    { "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "name": "brave-falcon", "createdAt": "2026-04-13T12:00:00.000Z" },
    { "id": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy", "name": "swift-river", "createdAt": "2026-04-13T12:01:00.000Z" }
  ]
  ```
  - Each element has `id` (string), `name` (non-empty string), and `createdAt` (ISO 8601 string)
  - `createdAt` is a valid ISO 8601 timestamp; sorting is left to the client
  - Returns empty array `[]` when no projects exist
  - No pagination — returns all projects

---

### PATCH `/v1/projects/:id`

**Rename a project**

**Request Body:**
- `name` (required, string): New project name (must be non-empty)

**Responses:**

- **200 OK** — Project renamed
  ```json
  {
    "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "name": "my-custom-name"
  }
  ```
  - Name change is persisted and reflected in subsequent `GET /v1/projects` calls

- **400 Bad Request** — Invalid input
  - `name` field is missing or empty string
  - Response: RFC 9457 Problem Detail (`application/problem+json`)

- **404 Not Found** — Project does not exist
  - Response: RFC 9457 Problem Detail (`application/problem+json`)

---

### GET `/v1/projects/:id/tree`

**Get the file tree for an existing project**

**Responses:**

- **200 OK** — Tree structure returned
  ```json
  {
    "name": "<project-dir-name>",
    "type": "directory",
    "children": [...]
  }
  ```
  - `children` is an array of nested file/directory entries
  - Works identically for both template-based and blank projects

- **404 Not Found** — Project does not exist
  - Response: RFC 9457 Problem Detail (`application/problem+json`)

---

## Design Principles

### Projects Have Names
- Every project gets a human-readable name at creation time (auto-generated)
- Names can be changed via PATCH — the generated name is a default, not permanent
- Name format is an implementation detail; the contract only guarantees a non-empty string

### Projects Track Creation Time
- Every project records a `createdAt` ISO 8601 timestamp at creation time
- `createdAt` is immutable — renaming does not change it
- Sorting by `createdAt` is left to the client

### Templates Are Optional
- `POST /projects {}` (no template) is a first-class creation path, not an error
- Blank projects are scaffolded in-memory — no zip file, no disk lookup
- The blank option never appears in `GET /templates` — it's the absence of a template, not a special one

### Uniform Response Shape
- Both blank and template-based creation return the same `{ id, name, createdAt }` response
- Both produce a directory with a valid `sfdx-project.json`
- Downstream endpoints (tree, file read, deploy) work identically on both

### Stateless
- No "active project" concept — every request identifies the project by ID
- Listing returns all projects; the client decides which to use

---

## Error Cases

| Error | HTTP | Condition |
|-------|------|-----------|
| Unknown template | 400 | `template` field provided but not recognized |
| Project not found | 404 | GET tree / PATCH for nonexistent project ID |
| Missing name | 400 | PATCH without `name` field |
| Empty name | 400 | PATCH with `name: ""` |

---

## Test Summary

- **POST /projects**: 5 tests (2 with template, 2 blank, 1 error) — now includes `createdAt` assertions
- **GET /projects**: 4 tests (array contents, element shape, createdAt validation, empty state)
- **PATCH /projects/:id**: 5 tests (rename, persistence, 404, missing name, empty name)
- **GET /projects/:id/tree**: 3 tests (template project, blank project, nonexistent)
- **Total**: 17 contract tests, 4 describe blocks
