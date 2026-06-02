<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->

# Projects Contract Specification

## Overview

The projects system manages SFDX project creation, listing, retrieval, naming, and file tree browsing. Projects can be created from a **named template** (unzipped from disk) or as a **blank project** (minimal SFDX scaffold generated in-memory). Every project receives a human-readable **name** at creation time, and can be renamed later. Each project tracks a **lastAccessedAt** ISO 8601 timestamp that updates whenever the project is accessed by ID. Every response that references a project includes `lastAccessedAt`.

Templates may optionally declare an `initialMessages` array in their `template.json`. When a project is created from such a template, those messages are persisted to the project's metadata and surfaced on both `POST /projects` (create) and `GET /projects/:id` (retrieve) responses so a downstream UI (e.g., an agentic chat panel) can seed a conversation with pre-written context.

Templates may **also** declare a `seedMessages` array. `seedMessages` are **hidden**, persona-anchoring few-shot turns — semantically distinct from the **visible** `initialMessages` — captured into the project at create time and surfaced the same way (on `POST /projects` and `GET /projects/:id`, detail-only, omitted entirely when absent). A template may ship both fields independently: a visible opening exchange (`initialMessages`) and a hidden persona anchor (`seedMessages`). See the "Templates Can Seed Hidden Agent Context" design principle below.

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
    "name": "Untitled",
    "lastAccessedAt": "2026-04-22T14:00:00.000Z",
    "targetOrg": "my-scratch-org",
    "initialMessages": [
      { "role": "user", "content": "Build me something" },
      { "role": "assistant", "content": "On it!" }
    ],
    "seedMessages": [
      { "role": "user", "content": "How should I phrase a failure?" },
      { "role": "assistant", "content": "Lead with the cause and the next action." }
    ]
  }
  ```

  - `id` is a UUID (lowercase hex, 8-4-4-4-12 format)
  - `name` is a non-empty string (auto-generated)
  - `lastAccessedAt` is a valid ISO 8601 timestamp equal to the creation time
  - `targetOrg` (optional) — present as a string echoing the resolved `orgAlias` when one was provided; omitted when `orgAlias` was not provided
  - `initialMessages` (optional) — present as a non-empty array when the template's `template.json` declares `initialMessages`; each element has non-empty `role` (string) and non-empty `content` (string)
  - `initialMessages` is omitted entirely (not an empty array) when the project was created blank or the template does not declare them
  - `seedMessages` (optional) — present as a non-empty array when the template's `template.json` declares `seedMessages`; each element has non-empty `role` (string) and non-empty `content` (string). Hidden few-shot seeds, distinct from `initialMessages`.
  - `seedMessages` is omitted entirely (not an empty array) when the project was created blank or the template does not declare them
  - When a template declares both, `initialMessages` and `seedMessages` are returned independently (each its own non-empty array)
  - Returned for both template-based and blank projects (with the `initialMessages` / `seedMessages` / `targetOrg` rules above)
  - The returned `lastAccessedAt` matches the value that `GET /v1/projects` will report for this project
  - The returned `initialMessages` / `seedMessages` (when present) match the values that `GET /v1/projects/:id` will return for this project

- **400 Bad Request** — Invalid input
  - Template name is not recognized
  - `orgAlias` is an empty string
  - `orgAlias` does not resolve to a username in the SFDX auth store (`detail` names the offending alias)
  - Response: RFC 9457 Problem Detail (`application/problem+json`)

**Project Directory Contents:**

| Scenario        | Contents                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Template-based  | Full template contents (unzipped from disk), including `sfdx-project.json` with `packageDirectories` (array, at least one entry)   |
| Blank           | Minimal `sfdx-project.json` with `packageDirectories` (array, at least one entry) + empty `force-app/main/default/` directory tree |
| With `orgAlias` | In addition to the above, a `.sf/config.json` file containing `{ "target-org": "<alias>" }`                                        |

Both template-based and blank scenarios produce a valid SFDX project with `sfdx-project.json` containing a non-empty `packageDirectories` array.

---

### GET `/v1/projects`

**List all projects**

**Responses:**

- **200 OK** — Array of projects

  ```json
  [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "name": "Untitled",
      "lastAccessedAt": "2026-04-13T12:00:00.000Z"
    },
    {
      "id": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
      "name": "Untitled 2",
      "lastAccessedAt": "2026-04-13T12:01:00.000Z"
    }
  ]
  ```

  - Each element has `id` (string), `name` (non-empty string), and `lastAccessedAt` (ISO 8601 string)
  - `lastAccessedAt` is a valid ISO 8601 timestamp; sorting is left to the client
  - A freshly created project's `lastAccessedAt` equals its creation time
  - Returns empty array `[]` when no projects exist
  - No pagination — returns all projects
  - `initialMessages` is intentionally NOT surfaced in the list response (detail-only field; see GET `/v1/projects/:id`)
  - `seedMessages` is likewise NOT surfaced in the list response (detail-only field; see GET `/v1/projects/:id`)

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
    ],
    "seedMessages": [
      { "role": "user", "content": "How should I phrase a failure?" },
      { "role": "assistant", "content": "Lead with the cause and the next action." }
    ]
  }
  ```

  - `id` equals the path parameter
  - `name` is the current name from the project's metadata (non-empty string); reflects any prior PATCH rename
  - `lastAccessedAt` is a valid ISO 8601 timestamp
  - `initialMessages` (optional) — present as a non-empty array when the project was created from a template whose `template.json` declared initialMessages; each element has non-empty `role` (string) and non-empty `content` (string)
  - `initialMessages` is omitted entirely (not an empty array) for blank projects or projects created from templates without initialMessages
  - `initialMessages` is preserved across PATCH rename — rename does not clear or modify it
  - `seedMessages` (optional) — present as a non-empty array when the project was created from a template whose `template.json` declared seedMessages; each element has non-empty `role` (string) and non-empty `content` (string). Hidden few-shot seeds, distinct from `initialMessages`.
  - `seedMessages` is omitted entirely (not an empty array) for blank projects or projects created from templates without seedMessages
  - `seedMessages` is preserved across PATCH rename — rename does not clear or modify it
  - **Access side effect:** every retrieval bumps `lastAccessedAt` to the current time, not just the first access after a mutation. The returned value is the post-bump value, and is strictly greater than both the creation time and any prior PATCH-time `lastAccessedAt`. This invariant applies only when the project's meta file is valid — see Meta-File Integrity below for the missing/unparseable carve-out.
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
  - `seedMessages`, when set at project creation, is likewise preserved through rename and observable via a subsequent `GET /v1/projects/:id`

- **400 Bad Request** — Invalid input
  - `name` field is missing
  - `name` is empty string or only whitespace (after trimming)
  - `name` exceeds 80 characters
  - Error type: `InvalidProjectNameError`
  - Response: RFC 9457 Problem Detail (`application/problem+json`) with `title` containing "invalid" or "name"

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
  - Accessing the tree updates the project's `lastAccessedAt` (subject to the Meta-File Integrity carve-out below)

- **404 Not Found** — Project does not exist
  - Response: RFC 9457 Problem Detail (`application/problem+json`)

---

## Meta-File Integrity

An access route that bumps `lastAccessedAt` must never fabricate or overwrite `.project-meta.json` when the on-disk file is missing or unparseable at access time.

- **Missing meta at access time:** `GET /v1/projects/:id` returns 200 without persisting a new meta file. If a later path legitimately recreates the file, its `name` must not be the project's UUID — fabricating a UUID-shaped `name` is explicitly disallowed.
- **Unparseable meta at access time:** `GET /v1/projects/:id`, `GET /v1/projects/:id/tree`, and `GET /v1/projects/:id/file` return 200 without modifying the on-disk bytes. The corrupted content is preserved byte-for-byte so an explicit repair path can restore the project.
- **Narrowed `lastAccessedAt` invariant:** the "every access bumps `lastAccessedAt`" rule applies only to projects with a valid meta file. When the meta file is missing or unparseable, the bump is skipped rather than performed against a fabricated read. This is the trade-off that preserves recoverability.
- **PATCH rename is a guaranteed recovery path:** `PATCH /v1/projects/:id` succeeds even when the project's meta file is corrupted or missing at the time of the request. The post-rename meta on disk is valid JSON whose `name` is the new name (never the project UUID). This is the recovery mechanism that the read-side carve-out depends on — preserving corrupted bytes is only useful if the project can actually be healed by an explicit write.

Context: historically, a read fallback returned `{ name: path.basename(projectDir) }` when the meta file could not be read. A subsequent access bump would persist that fabricated value to disk, permanently overwriting the real name. This contract rules out that class of silent corruption while guaranteeing that PATCH rename remains a viable way out.

---

## Design Principles

### Projects Have Names

- Every project gets a human-readable name at creation time (auto-generated)
- **Blank projects:** name follows the `Untitled` / `Untitled N` convention — first instance is `Untitled`, subsequent ones are `Untitled 2`, `Untitled 3`, etc. (see Project Naming Convention below)
- **Template projects:** name follows the same `<base>` / `<base> N` pattern, where `<base>` is the template's display name from `template.json:name` (e.g., "Data Curator", "Data Curator 2", "Data Curator 3")
- Names can be changed via PATCH — the generated name is a default, not permanent
- Names are trimmed (leading/trailing whitespace removed) and must be 1–80 characters after trimming
- `GET /v1/projects/:id` returns the current name, reflecting any prior rename (no caching)

### Projects Track Last Access

- Every project records a `lastAccessedAt` ISO 8601 timestamp
- `lastAccessedAt` is initialized to the project's creation time
- `lastAccessedAt` is updated whenever the project is accessed by ID (GET /:id, PATCH, tree, file read) **for projects with a valid meta file** — see Meta-File Integrity for the carve-out
- **Every response that references a project includes `lastAccessedAt`** — POST create, GET /:id, PATCH rename, and GET list all return it consistently
- Sorting by `lastAccessedAt` is left to the client

### Templates Are Optional

- `POST /projects {}` (no template) is a first-class creation path, not an error
- Blank projects are scaffolded in-memory — no zip file, no disk lookup
- The blank option never appears in `GET /templates` — it's the absence of a template, not a special one

### Project Naming Convention

- Both blank and template-based projects share a single max-based naming scheme
- Pattern: `<base>` for the first project with that base name, then `<base> 2`, `<base> 3`, …
- For blank projects, `<base>` is the literal string `"Untitled"`
- For template projects, `<base>` is the template's display name (read from `template.json:name`, falling back to the templateId if missing or unparseable)
- Naming rule: take the **maximum N** among existing projects matching `<base>` (treated as N=1) or `<base> N`, and return `<base> ${N+1}` (or just `<base>` if no match exists)
- Gap slots are intentionally **not** reused — for example, renaming "Untitled 2" away from a `{Untitled, Untitled 2, Untitled 3}` set does not free up the "2" slot; the next blank project is "Untitled 4" because the max remaining N is 3
- This avoids two failure modes the alternative count-based scheme had: (1) collisions when a middle slot is renamed (count + 1 can equal an in-use N), and (2) the race where two concurrent creates both pick the same gap
- No LLM dependency for either path

### Templates Can Seed Initial Agent Messages

- Templates may declare an `initialMessages` array in their `template.json`, each element `{ role: string, content: string }`
- When a project is created from such a template, those messages are persisted into the project's metadata (`.project-meta.json`) at creation time
- Both the `POST /v1/projects` create response and the `GET /v1/projects/:id` retrieve response surface `initialMessages` when present — clients can seed an agent conversation without re-fetching
- Blank projects and templates without `initialMessages` omit the field entirely — never returned as an empty array
- `initialMessages` is read-only post-creation: no endpoint mutates it, and PATCH rename leaves it untouched
- Role vocabulary and content length are unconstrained by this contract; downstream consumers (UI, agent service) are responsible for validating what they accept

### Templates Can Seed Hidden Agent Context

- Templates may declare a `seedMessages` array in their `template.json`, each element `{ role: string, content: string }` — the **same shape** as `initialMessages`
- `seedMessages` are **hidden** persona-anchoring few-shot turns: distinct in purpose from `initialMessages` (which are **visible** starter turns rendered into the transcript). Hidden seeds are intended to be injected into a chat session as model-visible-but-transcript-hidden context (the consuming mechanism sets `transcriptVisible: false`); they anchor the agent's persona without appearing in the user-visible conversation
- A single template may declare **both** fields — they coexist and are surfaced independently. Neither field's presence implies or affects the other
- When a project is created from such a template, `seedMessages` are persisted into the project's metadata (`.project-meta.json`) at creation time, exactly like `initialMessages` (capture-at-create: later template edits do not retroactively change existing projects)
- Both the `POST /v1/projects` create response and the `GET /v1/projects/:id` retrieve response surface `seedMessages` when present; it is detail-only (NOT in `GET /v1/projects` list) and omitted entirely (never `[]`) when absent
- `seedMessages` is read-only post-creation: no endpoint mutates it, and PATCH rename leaves it untouched
- **Validation and caps (executable contract):** each element must satisfy the same `{ role: string, content: string }` shape (`isMessage`); malformed elements are dropped, not fatal. Structural caps bound the field so a malformed/runaway template cannot write an unbounded blob: at most **50** messages (surplus truncated) and at most **10,000** characters per `content` (oversized elements dropped; a content of exactly 10,000 chars is kept — the cap is inclusive). If nothing valid survives, the field is omitted (treated as absent) — never a 500. These caps are exercised through the public API (`POST /v1/projects` + `GET /v1/projects/:id`) over spec-owned fixture templates, so the bound is a verified contract guarantee, not a prose-only claim
- Role vocabulary is unconstrained by this contract (consistent with `initialMessages`); downstream consumers validate what they accept. Note: the consuming agent/SDK expects alternating `user`/`assistant` turns for few-shot anchoring to work well, but that is a downstream concern, not enforced here

### Uniform Response Shape

- Both blank and template-based creation return the same core `{ id, name, lastAccessedAt }` response; optional fields (`initialMessages`, `seedMessages`, `targetOrg`) appear when set
- `GET /v1/projects/:id` returns the same shape, matching create, rename, and list for the core fields, and additionally surfaces `initialMessages` and `seedMessages` when present
- Both produce a directory with a valid `sfdx-project.json`
- Downstream endpoints (tree, file read, deploy) work identically on both
- Response shape is consistent across create, retrieve, rename, and list — clients never have to reconstruct `lastAccessedAt` themselves

### Invalid IDs Are Not Found

- Requests whose `:id` path parameter does not match the UUID shape are rejected as 404, not 400
- This keeps the contract honest: the only answerable question about a project ID is "does this project exist?" A malformed ID is just one kind of "no"
- Consistent across GET `/:id`, PATCH `/:id`, and GET `/:id/tree`

### Initial & Seed Messages Are Detail-Only

- Like `targetOrg`, both `initialMessages` and `seedMessages` are not surfaced in `GET /v1/projects` (list) — clients fetch the fields per-project via `GET /:id` or receive them inline on `POST /projects` creation
- Keeps the list response compact for UIs that only need ID, name, and recency

### On-Disk State Is Never Fabricated

- When a caller asks for a project's details but the on-disk meta file is missing or corrupted, the service returns a best-effort response for display but **must not write a synthesized replacement** back to disk
- Recovery is always an explicit, user-initiated write (PATCH rename, or manual file repair) — never a silent side effect of a read
- This applies to any access route that bumps `lastAccessedAt`: GET `/:id`, GET `/:id/tree`, GET `/:id/file`

### Stateless

- No "active project" concept — every request identifies the project by ID
- Listing returns all projects; the client decides which to use

---

## Error Cases

| Error             | HTTP | Condition                                                                             |
| ----------------- | ---- | ------------------------------------------------------------------------------------- |
| Unknown template  | 400  | `template` field provided but not recognized                                          |
| Project not found | 404  | GET `/:id`, GET `/:id/tree`, or PATCH `/:id` for a nonexistent or non-UUID project ID |
| Missing name      | 400  | PATCH without `name` field                                                            |
| Empty name        | 400  | PATCH with `name: ""` or only whitespace (after trimming)                             |
| Name too long     | 400  | PATCH with `name` exceeding 80 characters after trimming                              |

---

## Test Summary

- **POST /projects**: includes orgAlias resolution, blank-project Untitled-N numbering, template-flow `<TemplateName> N` numbering, name-persistence-across-list/retrieve, initialMessages handling from templates, and seedMessages handling (present from template, absent on blank, create/get parity, independent from initialMessages when both present).
- **seedMessages structural caps (contract)**: driven through `POST /projects` + `GET /:id` over spec-owned fixture templates — caps at 50 entries (surplus dropped), drops a content over 10,000 chars while keeping the rest, keeps a content of exactly 10,000 chars (inclusive boundary), drops malformed entries while keeping well-formed ones, and omits the field (201, never 500) when every entry is malformed.
- **GET /projects**: array contents, element shape with lastAccessedAt, initial lastAccessedAt at creation time, access-updates-timestamp, empty state, seedMessages absent from list (detail-only).
- **GET /projects/:id**: 200 shape, lastAccessedAt bump past creation, get/list consistency, post-rename name + bump-past-PATCH, every-GET-bumps, 404 for valid-UUID miss, 404 for non-UUID, initialMessages from template, initialMessages absent on blank, initialMessages preserved across PATCH, seedMessages from template, seedMessages absent on blank, seedMessages preserved across PATCH.
- **PATCH /projects/:id**: rename with lastAccessedAt bump, persistence, rename/list consistency, 404 for nonexistent, missing name, empty/whitespace name (400), >80-char name (400), exactly-80-char name (200), trim semantics.
- **GET /projects/:id/tree**: template project, blank project, nonexistent.
- **Meta file integrity**: missing meta not fabricated on /:id; unparseable meta preserved on /:id, /:id/tree, /:id/file; PATCH rename recovers a corrupted project.
