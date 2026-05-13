<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->
<!-- Regenerate with: /cdd-spec --refresh visualize -->

# Metadata Visualization Endpoints Contract

Exposes the Salesforce Metadata Visualizer framework as a set of HTTP endpoints under `/v1/projects/:id/visualize/`, so a browser host (an LWC, a demo page, etc.) can iframe a plugin's prebuilt React UI and round-trip parsed metadata through the host page.

The host iframes a plugin's React UI via `/ui/:pluginId/`, relays `REQUEST_PLUGIN_DATA` messages from the iframe to `POST /visualize`, and posts `PLUGIN_DATA_RESPONSE` back. The plugin's React app uses the framework's standard `HostCommunicationUtils.getPluginData()` and is not aware of any particular host.

The `schema` plugin (ERD) is the demo target. The `flexipage` plugin ships in the same npm package and is expected to register, but is not a first-class demo artifact.

## GET `/v1/projects/:id/visualize/plugins`

List registered visualizer plugins.

### 200 — Success
- Lists registered plugins with `id`, `name`, and `filePatterns`. The `schema` plugin is always present and handles `.object-meta.xml`.

### 404 — Not Found
- Returns 404 for a nonexistent project.

## GET `/v1/projects/:id/visualize/files`

List project files that any registered plugin can handle.

### 200 — Success
- Lists metadata files under the project that a plugin can handle. Each entry is `{path, fileName, pluginId}`.
- Uses forward slashes in paths on all platforms.
- Omits files no registered plugin can handle (e.g. `sfdx-project.json`).

### 404 — Not Found
- Returns 404 for a nonexistent project.

## POST `/v1/projects/:id/visualize`

Parse a metadata file. Request body: `{filePath}` (project-relative). Response: `{ok: true, pluginId, data}` where `data` is the plugin's parsed output — for `schema`, this is `{objects[], relationships[], metadata}`.

### 200 — Success
- Parses a schema metadata file and returns the ERD payload (objects + relationships).
- Returns a single-object payload when the anchor has no resolvable relationships — matches the schema plugin's subgraph-discovery behavior in its native VS Code host.

### 400 — Bad Request
- Returns 400 when `filePath` is missing.
- Returns 400 for path traversal attempts (e.g. `../../etc/passwd`).

### 404 — Not Found
- Returns 404 for a nonexistent project.
- Returns 404 when `filePath` resolves to a nonexistent file.

### 415 — Unsupported Media Type
- Returns 415 when no registered plugin handles the given file type (e.g. `sfdx-project.json`).

## GET `/v1/projects/:id/visualize/ui/:pluginId/`

Serve the plugin's prebuilt React `index.html`, with server-side adaptations required to make it run outside of a VS Code webview.

### 200 — Success
- Serves the plugin React `index.html` as `text/html`.
- Rewrites `@dist/` placeholders in the HTML to a path relative to the iframe URL (e.g. `../../platform/design-system/platform.css` from `/v1/projects/:id/visualize/ui/:pluginId/`). The relative form resolves correctly when the service is mounted behind a reverse proxy with a path prefix; an absolute form would bypass the prefix and 404 at the proxy. No raw `@dist/` references escape to the browser.
- Injects a `<script>` that defines `window.__ExtensionHostPostMessage` to forward messages to `window.parent` — enables the plugin's built-in host-communication utils to round-trip data through the embedding page.

### 404 — Not Found
- Returns 404 for a nonexistent project.
- Returns 404 for an unknown `pluginId`.

## GET `/v1/projects/:id/visualize/ui/:pluginId/assets/:asset`

Serve the static JS/CSS bundle for a plugin's React app.

### 200 — Success
- Serves a plugin build asset (JS) with the correct MIME type.

### 4xx — Path traversal
- Returns 400 or 404 for path traversal within the asset route. The contract asserts the security property (no content is served from outside the plugin's build directory) and does not pin a specific status code.

### 404 — Not Found
- Returns 404 for a missing asset.

## GET `/v1/projects/:id/visualize/platform/design-system/platform.css`

Serve the design-system CSS referenced by plugin HTML. Plugins reference this via the `@dist/design-system/platform.css` placeholder; the `/ui/:pluginId/` route rewrites that placeholder to a relative path that resolves to this URL.

The response is the SDK's shipped `vscode-design-system.css` followed by a service-bundled light-mode overlay. The overlay is the platform host's reasonable default for "no consumer-supplied CSS" — without it, the SDK falls through to dark VS Code defaults that clash with light app shells outside VS Code. The contract pins the **`--mv-*` semantic tokens** (the documented contract surface plugin authors style against, per the SDK's design-system README) as the durable layer. A separate implementation-side `--vscode-*` safety net covers the SDK base styles (body, scrollbar, anchors, focus) that read `--vscode-*` directly outside the `--mv-*` indirection layer; that layer is implementation detail and intentionally not part of this contract.

Consumer-specific styling (e.g. App Studio SLDS values) is explicitly **out of scope** of this contract. Project Service stays consumer-agnostic; consumer-specific overlays are a future concern.

### 200 — Success
- Serves the response as `text/css`.
- Sets `Cache-Control: public, max-age=…` so the browser can reuse the asset.
- Appends a light-mode design-system overlay after the SDK base CSS so the canvas paints light by default. Verified by:
  - The response defines `--mv-canvas-bg: #ffffff` (the Canvas/Shell semantic token resolved to a light value), proving the overlay is present.
  - The light-mode `:root` block appears AFTER the SDK base content, anchored on `::-webkit-scrollbar` (a SDK-base-only structural selector). Cascade ordering proves the overlay overrides — and is not overridden by — the SDK base.

### 404 — Not Found
- Returns 404 for a nonexistent project.

## CORS — Cross-origin from the Lightning org

The App Studio LWC runs on the Lightning org origin while Project Service runs on localhost. Every endpoint the LWC or its iframe calls from the browser must permit cross-origin access.

- Allows a cross-origin `GET /plugins` from the Lightning origin (`Access-Control-Allow-Origin` present).
- Responds to a preflight `OPTIONS` for `POST /visualize` (200 or 204, with `Access-Control-Allow-Origin` and `Access-Control-Allow-Methods` including `POST`).
- Allows a cross-origin `GET` on the plugin UI route.

The specific allowlist (which origins, how it's configured) is an implementation concern — the contract asserts only the minimum observable cross-origin behavior.

## Concurrency

Two parallel `POST /visualize` calls on the same project must each return their own correct result. How the implementation achieves this — request-scoped engines, a serialization queue, or an upstream framework fix — is its concern.

- Parallel `POST /visualize` calls on the same project each return their own correct result. Anchoring on `SchemaTestA__c` returns the connected subgraph `{A, B}`; anchoring in parallel on a disconnected lone object returns just that object. The two payloads differ in identity and cardinality, so cross-contamination between the parallel calls is observable.

## Error Format

All errors return `application/problem+json` with RFC 9457 structure:
```json
{ "status": 400, "title": "Bad Request", "detail": "..." }
```

---

*8 top-level describe blocks, 29 tests*
