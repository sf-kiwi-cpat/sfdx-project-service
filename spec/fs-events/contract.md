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

> **Note on payload assertions.** Tests use `toMatchObject` / explicit
> property checks, which are intentionally permissive. Extra properties on
> event payloads are allowed so that future non-breaking additions
> (e.g. `timestamp`, `size`) remain forward-compatible without requiring a
> spec change.

---

## Event Payload Semantics

### Paths

- `path` is **always relative to the project root**, using POSIX-style
  forward slashes (e.g., `src/components/App.js`).
- Nested paths are preserved (no flattening).

### Content inclusion rules

`content` is included on `file-added` and `file-changed` when **both** of the
following hold:

- **Extension is not binary.** The binary extension list is a **deny-list**:
  `.png`, `.jpg`, `.gif`, `.webp`, `.pdf`, `.zip`, `.woff`, `.woff2`, `.ttf`.
  All nine extensions are asserted in the contract tests. Files with
  **unknown or missing extensions** (e.g. `script.sh`, `Makefile`,
  `unknown.foo`) default to **text** and include content.
- **File size is strictly less than 100KB** (i.e.
  `byteLength < 100 * 1024`). The boundary is pinned by two tests:
  - A file of exactly **99 * 1024 bytes** includes content.
  - A file of **100 * 1024 + 1 bytes** omits content.

Additional runtime consideration: the file must still be readable when the
debounce timer flushes (a race with a subsequent `unlink` may cause content
to be gracefully omitted).

`content` is **never** included on `file-removed`.

### Content encoding

Inline `content` is decoded as **UTF-8**. Files written in other encodings
(Windows-1252, Latin-1, Shift-JIS, UTF-16 without BOM handling, etc.) decode
with the Unicode replacement character (U+FFFD) wherever bytes cannot be
interpreted as UTF-8.

This is documented behaviour, not a bug: the watcher prioritises a fast,
JSON-safe payload on the hot path over encoding detection. Consumers that
require byte-exact content for non-UTF-8 encodings are out of scope for this
endpoint.

### Directories

- **Directory creation and deletion do not produce `file-*` events.**
  `FileEvent.type` is `'add' | 'change' | 'unlink'` and applies only to files.
- Creating an empty directory emits **no** events.
- Creating a file inside a new directory emits exactly **one** `file-added`
  event — for the file itself, not the containing directory.

### Renames

A rename (`fs.rename(a, b)`) is reported as **two** events:

- `file-removed` for the source path.
- `file-added` for the destination path, with content included (subject to
  the usual deny-list + size rules).

The watcher does **not** coalesce renames into a synthetic `change` on the
new path. This is required for editors that save via rename (tempfile +
rename).

### Initial state on subscribe

- The watcher runs with `ignoreInitial: true`. A project that already
  contains files does **not** surface `file-added` events for those
  pre-existing files when a new client subscribes. Only writes made **after**
  subscription produce events.

### Debouncing

Rapid successive writes are collapsed within a debounce window. Debouncing
is **per-path**:

- Multiple writes to the **same path** within the window yield **one**
  event carrying the **latest** content (last-write-wins).
- Writes to **different paths** within the same window yield **one event
  per path** — debouncing is keyed by path, not global.

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

## Configuration Surface

The following environment variables are expected to be read by the watcher
subsystem (both are set in the contract test setup to shrink timing):

| Env var                   | Getter                     | Default (prod) | Purpose                                                                 |
|---------------------------|----------------------------|----------------|-------------------------------------------------------------------------|
| `WATCHER_DEBOUNCE_MS`     | `getWatcherDebounceMs()`   | `300` ms       | Per-path debounce window; rapid writes inside this window coalesce.     |
| `WATCHER_STABILITY_MS`    | `getWatcherStabilityMs()`  | `200` ms       | chokidar `awaitWriteFinish.stabilityThreshold` — file quiescence.       |

Overriding these env vars must not change watcher **behaviour** — only
timing.

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

### Deny-list classification
Files are assumed text unless their extension appears in the binary
deny-list. This keeps unknown / ad-hoc text files (`Makefile`, `.sh`,
novel codebase-specific extensions) useful to downstream consumers without
requiring an allow-list to stay in sync with every new text format.

### UTF-8 only on the hot path
Text content is decoded as UTF-8 without encoding detection. Encoding
sniffing (chardet, jschardet) is probabilistic, adds CPU to a latency-
sensitive path, and is unnecessary for the modern codebases this service
targets (LWC, TypeScript, JSON, Markdown — all UTF-8 by convention).
Legacy-encoded files degrade to replacement characters but remain
JSON-safe; byte-exact handling, if needed, is out of scope for this
endpoint.

### Per-path, last-write-wins debouncing
Editors that save via rename (many editors write to a tempfile then rename)
and tools that perform quick successive writes collapse into a single
event so consumers aren't spammed. Debouncing is keyed by path, so writes
to distinct files in the same window all surface.

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
  `awaitWriteFinish: { stabilityThreshold: <WATCHER_STABILITY_MS>, pollInterval: 50 }`.
- **Debounce window:** `<WATCHER_DEBOUNCE_MS>` (default 300ms, override for
  tests).
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

### Rename

```bash
# fs.rename('a.txt', 'b.txt')
event: file-removed
data: {"path":"a.txt","type":"unlink"}

event: file-added
data: {"path":"b.txt","type":"add","content":"..."}
```

### Not a valid project

```bash
GET /v1/projects/not-a-uuid/fs/events
# → 404 Not Found, Content-Type: application/problem+json
{ "type": "...", "title": "Not Found", "status": 404, "detail": "..." }
```
