<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->

# Projects Contract Specification

## Overview

The projects system manages SFDX project creation and file tree browsing. Projects can be created from a **named template** (unzipped from disk) or as a **blank project** (minimal SFDX scaffold generated in-memory). Blank projects support the "vibe coding" flow where users build from scratch without picking a template.

## Endpoints

### POST `/v1/projects`

**Create a new project**

**Request Body:**
- `template` (optional, string): Template identifier (e.g., `"work-tracking"`)
  - When provided: unzips the named template into a new project directory
  - When omitted: scaffolds a minimal blank SFDX project in-memory (no zip, no disk lookup)

**Responses:**

- **201 Created** — Project created successfully
  ```json
  {
    "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
  ```
  - `id` is a UUID (lowercase hex, 8-4-4-4-12 format)
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

### Templates Are Optional
- `POST /projects {}` (no template) is a first-class creation path, not an error
- Blank projects are scaffolded in-memory — no zip file, no disk lookup
- The blank option never appears in `GET /templates` — it's the absence of a template, not a special one

### Uniform Response Shape
- Both blank and template-based creation return the same `{ id }` response
- Both produce a directory with a valid `sfdx-project.json`
- Downstream endpoints (tree, file read, deploy) work identically on both

### Separation of Concerns
- The project service creates the empty room; orchestration layers furnish it
- No prompt, name, or AI-related data flows through project creation
- Blank projects are a filesystem concern, not an intelligence concern

---

## Error Cases

| Error | HTTP | Condition |
|-------|------|-----------|
| Unknown template | 400 | `template` field provided but not recognized |
| Project not found | 404 | GET tree for nonexistent project ID |

---

## Test Summary

- **POST /projects**: 5 tests (3 template-based, 2 blank)
- **GET /projects/:id/tree**: 3 tests (template project, blank project, nonexistent project)
- **Total**: 8 contract tests, 2 describe blocks
