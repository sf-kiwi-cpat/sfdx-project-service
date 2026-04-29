<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->

# Projects Contract Specification

## Overview

The projects system manages SFDX project creation, listing, retrieval, naming, and file tree browsing. Projects can be created from a **named template** (unzipped from disk) or as a **blank project** (minimal SFDX scaffold generated in-memory). Every project receives a human-readable **name** at creation time, and can be renamed later. Each project tracks a **lastAccessedAt** ISO 8601 timestamp that updates whenever the project is accessed by ID. Every response that references a project includes `lastAccessedAt`.

Templates may optionally declare an `initialMessages` array in their `template.json`. When a project is created from such a template, those messages are persisted to the project's metadata and surfaced on both `POST /projects` (create) and `GET /projects/:id` (retrieve) responses so a downstream UI (e.g., an agentic chat panel) can seed a conversation with pre-written context.

`POST /projects` also accepts an optional `orgAlias` that names an SFDX-authenticated org. On success it is persisted to `.sf/config.json` as `target-org`, which the deploy endpoint then reads to resolve auth server-side (see `spec/deploy/contract.spec.ts` for the deploy-time resolution chain).

## Endpoints

### POST `/v1/projects`

**Create a new project**

**Request Body:**
- `template` (optional, string): Template identifier (e.g., `"local-react-test"`)
  - When provided: unzips the named template into a new project directory
  - When omitted: scaffolds a minimal blank SFDX project in-memory (no zip, no disk lookup)
- `orgAlias` (optional, string): Alias of a Salesforce org already authenticated via `sf org login`
  - When provided: validated against the local auth store (StateAggregator). A resolved alias is persisted to `.sf/config.json` as `target-org`.
  - When omitted: no target-org is written. The deploy endpoint will fall back to the global default org (if any) or require an `orgAlias` on the POST body.

**Responses:**

- **201 Created** — Project created successfully
  ```json
  {
    "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "name": "brave-falcon",
    "lastAccessedAt": "2026-04-22T14:00:00.000Z",
    "targetOrg": "my-scratch-org",
    "initialMessages": [
      { "role": "user", "content": "Build me something" },
      { "role": "assistant", "content": "On it!" }
    ]
  }
  ```
  - `id` is a UUID (lowercase hex, 8-4-4-4-12 format)
  - `name` is a non-empty string (auto-generated)
  - `lastAccessedAt` is a valid ISO 8601 timestamp equal to the creation time
  - `targetOrg` (optional) — present as a string echoing the resolved `orgAlias` when one was provided; omitted when `orgAlias` was not provided
  - `initialMessages` (optional) — present as a non-empty array when the template's `template.json` declares `initialMessages`; each element has non-empty `role` (string) and non-empty `content` (string)
  - `initialMessages` is omitted entirely (not an empty array) when the project was created blank or the template does not declare them
  - Returned for both template-based and blank projects (with the `initialMessages` / `targetOrg` rules above)
  - The returned `lastAccessedAt` matches the value that `GET /v1/projects` will report for this project
  - The returned `initialMessages` (when present) matches the value that `GET /v1/projects/:id` will return for this project

- **400 Bad Request** — Invalid input
  - Template name is not recognized
  - `orgAlias` is an empty string
  - `orgAlias` does not resolve to a username in the SFDX auth store (`detail` names the offending alias)
  - Response: RFC 9457 Problem Detail (`application/problem+json`)

**Project Directory Contents:**

| Scenario | Contents |
|----------|----------|
| Template-based | Full template contents (unzipped from disk), including `sfdx-project.json` with `packageDirectories` (array, at least one entry) |
| Blank | Minimal `sfdx-project.json` with `packageDirectories` (array, at least one entry) + empty `force-app/main/default/` directory tree |
| With `orgAlias` | In addition to the above, a `.sf/config.json` file containing `{ "target-org": "<alias>" }` |

Both template-based and blank scenarios produce a valid SFDX project with `sfdx-project.json` containing a non-empty `packageDirectories` array.

---

### GET `/v1/projects`

**List all projects**

**Responses:**

- **200 OK** — Array of projects
  ```json
  [
    { "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "name": "brave-falcon", "lastAccessedAt": "2026-04-13T12:00:00.000Z" },
    { "id": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy", "name": "swift-river", "lastAccessedAt": "2026-04-13T12:01:00.000Z" }
  ]
  ```
  - Each element has `id` (string), `name` (non-empty string), and `lastAccessedAt` (ISO 8601 string)
  - `lastAccessedAt` is a valid ISO 8601 timestamp; sorting is left to the client
  - A freshly created project's `lastAccessedAt` equals its creation time
  - Returns empty array `[]` when no projects exist
  - No pagination — returns all projects
  - `initialMessages` is intentionally NOT surfaced in the list response (detail-only field; see GET `/v1/projects/:id`)

---

### GET `/v1/projects/:id`

**Retrieve a single project by ID**

**Path Parameters:**
- `id` (required, string): The project's UUID (lowercase hex, 8-4-4-4-12 format). Values that do not match the UUID shape are treated as "not found".

**Responses:**

- **200 OK** — Project exists
  ```json
  {
    "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "name": "brave-falcon",
    "lastAccessedAt": "2026-04-27T21:13:06.000Z",
    "initialMessages": [
      { "role": "user", "content": "Build me something" },
      { "role": "assistant", "content": "On it!" }
    ]
  }
  ```
  - `id` equals the path parameter
  - `name` is the current name from the project's metadata (non-empty string); reflects any prior PATCH rename
  - `lastAccessedAt` is a valid ISO 8601 timestamp
  - `initialMessages` (optional) — present as a non-empty array when the project was created from a template whose `template.json` declared initialMessages; each element has non-empty `role` (string) and non-empty `content` (string)
  - `initialMessages` is omitted entirely (not an empty array) for blank projects or projects created from templates without initialMessages
  - `initialMessages` is preserved across PATCH rename — rename does not clear or modify it
  - **Access side effect:** every retrieval bumps `lastAccessedAt` to the current time, not just the first access after a mutation. The returned value is the post-bump value, and is strictly greater than both the creation time and any prior PATCH-time `lastAccessedAt`.
  - The returned `lastAccessedAt` matches the value that the next `GET /v1/projects` will report for this project

- **404 Not Found** — Project does not exist, or `id` does not match the UUID shape
  - Response: RFC 9457 Problem Detail (`application/problem+json`) with `status: 404` and a `title`

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
    "name": "my-custom-name",
    "lastAccessedAt": "2026-04-22T14:05:00.000Z"
  }
  ```
  - Name change is persisted and reflected in subsequent `GET /v1/projects` calls
  - `lastAccessedAt` is bumped to the rename time (strictly greater than the prior value)
  - The returned `lastAccessedAt` matches the value that `GET /v1/projects` will report for this project
  - `initialMessages`, when set at project creation, is preserved through rename and can be observed via a subsequent `GET /v1/projects/:id`

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
  - Accessing the tree updates the project's `lastAccessedAt`

- **404 Not Found** — Project does not exist
  - Response: RFC 9457 Problem Detail (`application/problem+json`)

---

## Design Principles

### Projects Have Names
- Every project gets a human-readable name at creation time (auto-generated)
- Names can be changed via PATCH — the generated name is a default, not permanent
- `GET /v1/projects/:id` returns the current name, reflecting any prior rename (no caching)
- Name format is an implementation detail; the contract only guarantees a non-empty string

### Projects Track Last Access
- Every project records a `lastAccessedAt` ISO 8601 timestamp
- `lastAccessedAt` is initialized to the project's creation time
- `lastAccessedAt` is updated whenever the project is accessed by ID (GET /:id, PATCH, tree, file read)
- **Every response that references a project includes `lastAccessedAt`** — POST create, GET /:id, PATCH rename, and GET list all return it consistently
- Sorting by `lastAccessedAt` is left to the client

### Templates Are Optional
- `POST /projects {}` (no template) is a first-class creation path, not an error
- Blank projects are scaffolded in-memory — no zip file, no disk lookup
- The blank option never appears in `GET /templates` — it's the absence of a template, not a special one

### Templates Can Seed Initial Agent Messages
- Templates may declare an `initialMessages` array in their `template.json`, each element `{ role: string, content: string }`
- When a project is created from such a template, those messages are persisted into the project's metadata (`.project-meta.json`) at creation time
- Both the `POST /v1/projects` create response and the `GET /v1/projects/:id` retrieve response surface `initialMessages` when present — clients can seed an agent conversation without re-fetching
- Blank projects and templates without `initialMessages` omit the field entirely — never returned as an empty array
- `initialMessages` is read-only post-creation: no endpoint mutates it, and PATCH rename leaves it untouched
- Role vocabulary and content length are unconstrained by this contract; downstream consumers (UI, agent service) are responsible for validating what they accept

### Uniform Response Shape
- Both blank and template-based creation return the same core `{ id, name, lastAccessedAt }` response; optional fields (`initialMessages`, `targetOrg`) appear when set
- `GET /v1/projects/:id` returns the same shape, matching create, rename, and list for the core fields, and additionally surfaces `initialMessages` when present
- Both produce a directory with a valid `sfdx-project.json`
- Downstream endpoints (tree, file read, deploy) work identically on both
- Response shape is consistent across create, retrieve, rename, and list — clients never have to reconstruct `lastAccessedAt` themselves

### Invalid IDs Are Not Found
- Requests whose `:id` path parameter does not match the UUID shape are rejected as 404, not 400
- This keeps the contract honest: the only answerable question about a project ID is "does this project exist?" A malformed ID is just one kind of "no"
- Consistent across GET `/:id`, PATCH `/:id`, and GET `/:id/tree`

### Initial Messages Are Detail-Only
- Like `targetOrg`, `initialMessages` is not surfaced in `GET /v1/projects` (list) — clients fetch the field per-project via `GET /:id` or receive it inline on `POST /projects` creation
- Keeps the list response compact for UIs that only need ID, name, and recency

### Stateless
- No "active project" concept — every request identifies the project by ID
- Listing returns all projects; the client decides which to use

---

## Error Cases

| Error | HTTP | Condition |
|-------|------|-----------|
| Unknown template | 400 | `template` field provided but not recognized |
| Project not found | 404 | GET `/:id`, GET `/:id/tree`, or PATCH `/:id` for a nonexistent or non-UUID project ID |
| Missing name | 400 | PATCH without `name` field |
| Empty name | 400 | PATCH with `name: ""` |

---

## Test Summary

- **POST /projects**: 9 tests (2 with template, 2 blank, 1 error, 1 create/list consistency, 1 initialMessages from template, 1 initialMessages absent on blank, 1 create/get initialMessages consistency)
- **GET /projects**: 5 tests (array contents, element shape with lastAccessedAt, initial lastAccessedAt at creation time, access-updates-timestamp, empty state)
- **GET /projects/:id**: 10 tests (200 shape, lastAccessedAt bump past creation, get/list consistency, post-rename name + bump-past-PATCH, every-GET-bumps, 404 for valid-UUID miss, 404 for non-UUID, initialMessages from template, initialMessages absent on blank, initialMessages preserved across PATCH)
- **PATCH /projects/:id**: 6 tests (rename with lastAccessedAt bump, persistence, rename/list consistency, 404, missing name, empty name)
- **GET /projects/:id/tree**: 3 tests (template project, blank project, nonexistent)
- **Total**: 33 contract tests, 5 describe blocks
