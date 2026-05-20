<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->

# DELETE /v1/projects/:id Contract Specification

## Overview

`DELETE /v1/projects/:id` removes a project's directory from disk. Projects in this service are local-disk artifacts: the API never claims ownership of remote org state. Any metadata that has previously been deployed to a linked Salesforce org is left in place — there is no org-side teardown.

The endpoint completes the basic CRUD surface alongside `POST /v1/projects`, `GET /v1/projects`, `GET /v1/projects/:id`, and `PATCH /v1/projects/:id`.

## Endpoints

### DELETE `/v1/projects/:id`

**Delete a project from disk.**

**Path parameters:**

- `id` (string): Project identifier — a UUID assigned at creation time

**Responses:**

- **204 No Content** — Project existed and was removed
  - Response body is empty (no JSON payload)
  - The project's directory under `PROJECTS_ROOT` is removed entirely, including nested files
  - The project no longer appears in `GET /v1/projects`
  - Subsequent `GET /v1/projects/:id`, `PATCH /v1/projects/:id`, and `GET /v1/projects/:id/tree` calls for the same id return `404`
  - Any in-flight `GET /v1/projects/:id/fs/events` SSE subscribers for the deleted project have their HTTP connection closed by the server before this 204 is returned
  - The per-project chokidar watcher backing the fs-events stream is torn down so no further filesystem events are processed for the deleted id

- **404 Not Found** — `id` does not resolve to an existing project
  - Response: RFC 9457 Problem Detail (`application/problem+json`)
  - Returned in all of these cases:
    - `id` is a well-formed UUID but no matching project exists
    - `id` is not a UUID
    - `id` contains path-traversal segments (e.g., `..`)
    - `id` was previously deleted (a second `DELETE` of the same id)

**Idempotency:**

A second `DELETE` on a previously deleted id returns `404`, mirroring `GET /v1/projects/:id` and `PATCH /v1/projects/:id`. Strict `404` is preferred over idempotent `204` because:

- It matches every other `/:id` route — no per-route surprise.
- It distinguishes "I successfully deleted N projects" from "I attempted N deletes" — useful for UIs that show batch results.

Callers that prefer "delete-or-noop" semantics can ignore `404` client-side.

## Side effects

- The project's directory under `PROJECTS_ROOT` is removed recursively.
- The project no longer appears in `GET /v1/projects`.
- All subsequent `/v1/projects/:id*` routes for the deleted id return `404`.
- Sibling projects are untouched — their directories, metadata, and `lastAccessedAt` values do not change.
- Any active `GET /v1/projects/:id/fs/events` SSE stream for the deleted project is forcibly closed by the server. Reconnecting clients will hit `404` on the next subscribe and stop.
- The per-project chokidar watcher is torn down. No further filesystem events are processed for the deleted id, regardless of whether disk-level activity continues against the path.
- Sibling projects' active fs-events SSE streams are unaffected.

## Out of scope

- Removing deployed metadata from any linked Salesforce org. The org keeps whatever was previously deployed.
- Soft-delete / archive semantics. There is no recovery endpoint.
- Bulk delete.
- Deployment SSE streams (`GET /v1/projects/:id/deployments/:deploymentId/events`). Those are deployment-id keyed and their lifetime is governed by the deployment record, not by the project directory. A deploy worker whose project dir disappears will fail naturally and emit a final `complete` event with the failure.

## Design principles

- **Symmetry with other `/:id` routes** — All identifier-resolution failures (non-UUID, missing, traversal) collapse to `404` with no information leak about id format.
- **Local-disk only** — The endpoint matches the project model: projects are filesystem artifacts; remote org state is the org's responsibility.
- **Strict idempotency over forgiving idempotency** — A second delete is not a silent success. Surfacing `404` lets clients distinguish actual deletes from no-ops.
- **No leaked subscriptions** — DELETE owns the project's full server-side lifetime. Any subsystem that holds resources keyed by `projectId` (today: the fs-events watcher) is torn down as part of delete, before the 204 returns.
- **Explicit close, not protocol event** — When DELETE forces an SSE stream closed, the server simply ends the HTTP response. No special `project-deleted` SSE event is sent. This matches standard `EventSource` semantics: the client observes a normal stream-end and may attempt to reconnect, at which point a `404` will stop the reconnect loop.

## Error case summary

| HTTP | Cause                                                    | Body                       |
| ---- | -------------------------------------------------------- | -------------------------- |
| 204  | Project existed; directory removed                       | (empty)                    |
| 404  | Valid UUID that does not exist                           | RFC 9457 Problem Detail    |
| 404  | Id is not a UUID                                         | RFC 9457 Problem Detail    |
| 404  | Id contains path-traversal segments                      | RFC 9457 Problem Detail    |
| 404  | Project was previously deleted (second DELETE same id)   | RFC 9457 Problem Detail    |
