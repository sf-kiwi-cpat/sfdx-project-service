<!--
  AUTO-GENERATED from contract.spec.ts — do NOT hand-edit.
  Regenerate with /cdd-spec --refresh fs-events.
-->

# Filesystem Events Contract Specification

## Overview

The filesystem events endpoint streams **real-time file change events** for a
project as Server-Sent Events (SSE). Any write to the project directory —
regardless of source (agent tool calls, MCP tools, shell commands, manual
edits) — is captured and broadcast to all connected subscribers.

This gives downstream consumers (e.g., the App Studio UI) a source-agnostic
channel to react to filesystem reality without coupling to any specific tool
taxonomy.

## Endpoint

### `GET /v1/projects/:id/fs/events`

Stream filesystem change events for a project via SSE.

**Response:**
- **200 OK** with `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  and `Connection: keep-alive`
- Immediately emits a `connected` event identifying the subscription
- Emits `file-added`, `file-changed`, and `file-removed` events as files
  inside the project directory are created, modified, and deleted

**Event Format:**
```
event: <name>
data: <JSON>

```

---

## Events

### `connected`

Emitted once, immediately upon subscription.

```json
{ "projectId": "<uuid>" }
```

### `file-added`

Emitted when a file is created.

```json
{
  "path": "src/components/App.js",
  "type": "add",
  "content": "export default function App() {}"
}
```

### `file-changed`

Emitted when a file's contents are modified.

```json
{
  "path": "change-me.txt",
  "type": "change",
  "content": "updated"
}
```

### `file-removed`

Emitted when a file is deleted. `content` is always absent.

```json
{
  "path": "delete-me.txt",
  "type": "unlink"
}
```

---

## Event Payload Semantics

### Paths

- `path` is **always relative to the project root**, using POSIX-style
  forward slashes (e.g., `src/components/App.js`).
- Nested paths are preserved (no flattening).

### Content

- `content` is included on `file-added` and `file-changed` **when**:
  - The file extension is **not** in the known-binary list
    (`.png`, `.jpg`, `.gif`, `.webp`, `.pdf`, `.zip`, `.woff`, `.woff2`, `.ttf`).
    All nine extensions are asserted in the contract tests.
  - The file is **smaller than 100KB**.
  - The file was still readable when the debounce timer flushed (a race
    with a subsequent `unlink` may cause content to be gracefully omitted).
- `content` is **never** included on `file-removed`.

### Debouncing

Rapid successive writes to the same path are collapsed into a single event
within a debounce window. The event carries the **latest** content at the
time the window flushes (last-write-wins).

---

## Ignored Paths

The watcher silently ignores the following paths — no events are emitted:

- **Dotfiles** at any depth (`.hidden`, `.env`, ...)
- **`node_modules/`** — dependency trees
- **`.git/`** — version control internals
- **`.sf/`** — Salesforce CLI state
- **`.project-meta.json`** — internal project metadata written by the service

This aligns with the ignore semantics used by `shouldIgnoreEntry()` in
`src/domain/files.ts`, extended with `.project-meta.json`.

---

## Error Responses (RFC 9457)

All error responses use `application/problem+json`.

| HTTP | Title     | When                                                         |
|------|-----------|--------------------------------------------------------------|
| 404  | Not Found | Project ID does not exist                                    |
| 404  | Not Found | Project ID is not a well-formed UUID                         |

Errors are returned as normal HTTP responses — the SSE stream is never
opened for a failing request.

---

## Lifecycle

### Connection

1. Client issues `GET /v1/projects/:id/fs/events`.
2. Service validates the project (`getProjectDir`) — 404 if missing/invalid.
3. Service opens the SSE stream and writes a `connected` event.
4. Service subscribes the client to the project's watcher. The first
   subscriber starts the underlying filesystem watcher; subsequent
   subscribers attach to the existing one.

### Sharing a watcher

- Two concurrent subscribers to the same project receive **the same
  events** — they share the underlying watcher via reference counting.

### Disconnect and teardown

- When a client disconnects, its subscription is removed.
- When the **last** subscriber disconnects, the underlying watcher is torn
  down cleanly.
- A subsequent subscribe rebuilds the watcher and works correctly from a
  clean state.

### Heartbeat

- A periodic SSE comment (`:heartbeat\n\n`) is emitted so proxies and load
  balancers don't close the idle connection. Not observable as a named
  event.

---

## Design Principles

### Source-agnostic
Filesystem watching catches **every** write — agent tool calls, MCP tools,
shell commands, manual edits — because it observes the filesystem itself.
Alternatives that filter agent tool-result events (or refresh on every
tool-result) miss manual edits, MCP side effects, and shell commands.

### Payload efficiency
Text content under 100KB ships with the event, enabling zero-round-trip
updates for downstream consumers. Binary files and large files get a
notification without content — the consumer can decide whether to fetch.

### Last-write-wins debouncing
Editors that save via rename (many editors write to a tempfile then rename)
and tools that perform quick successive writes collapse into a single
event so consumers aren't spammed.

### Refcounted watcher lifecycle
Watchers are started lazily on first subscriber and torn down when the
last subscriber disconnects. This bounds memory and FD usage to projects
that are actively being observed.

---

## Implementation Notes (non-binding)

These notes describe the expected implementation but are not part of the
external contract. The contract is defined entirely by the observable
behavior above.

- **Watcher:** `chokidar` with `persistent: true`, `ignoreInitial: true`,
  `awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }`.
- **Debounce window:** 300ms by default (configurable via
  `WATCHER_DEBOUNCE_MS` for tests).
- **Manager:** `WatcherManager` singleton with
  `subscribe(projectId, projectDir, listener)` → unsubscribe, and
  `closeAll()` for graceful shutdown from `app.onClose`.
- **Route pattern:** mirrors `src/routes/deploy.routes.ts` lines 96–165
  (`reply.hijack()` + raw response writes).

---

## Examples

### Subscribe and observe a write

```bash
# Connect
GET /v1/projects/<uuid>/fs/events
# → 200 OK, Content-Type: text/event-stream

event: connected
data: {"projectId":"<uuid>"}

# Another process writes src/App.js
event: file-added
data: {"path":"src/App.js","type":"add","content":"export default ..."}

# Same file modified
event: file-changed
data: {"path":"src/App.js","type":"change","content":"...new..."}

# Deleted
event: file-removed
data: {"path":"src/App.js","type":"unlink"}
```

### Not a valid project

```bash
GET /v1/projects/not-a-uuid/fs/events
# → 404 Not Found, Content-Type: application/problem+json
{ "type": "...", "title": "Not Found", "status": 404, "detail": "..." }
```
