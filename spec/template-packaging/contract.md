<!-- Human-guarded spec. Drafted by agent; requires human approval before merge. -->

# Template Packaging Contract — slim `content.zip` for fast project creation

## Status

**DRAFT — supersedes an earlier "extract-once + hardlink seed" design.** See
[Decision reversal](#decision-reversal) for why the hardlink approach was
dropped after benchmarking.

## Problem

`POST /v1/projects` with a `template` unzips `templates/dist/<id>/content.zip`
into a new project directory (`src/domain/projects.ts` `createProject`). For
the `data-curator` template this archive is **45 MB / 15,519 files**, and
extraction takes **~8 s** (measured with the production `extract-zip` path).
The cost is dominated by creating ~15.5k filesystem entries, not by
decompression.

Investigation showed **>99% of those files are `node_modules` that the
project does not need at runtime**:

| Tree in `content.zip` (data-curator) | Size | Files | Needed at runtime? |
|---|---:|---:|---|
| **root** `node_modules/` | 83 MB | 6,373 | **No.** No root `package.json` exists for this template, so the build script never installed it — it is stale, untracked local cruft that `zip -r` swept in. It backs `server/index.mjs`, a demo Express server the bundle README states is *not run* inside the workspace container. |
| **bundle** `node_modules/` (`force-app/main/default/uiBundles/App/`) | 111 MB | 7,972 | **Mostly no.** 95% is the dev toolchain (`typescript` 23 MB, `esbuild`, `@babel`, `rollup`, `vite`). The build (`src/domain/build.ts`) and preview server (`sfdx-preview-service`) resolve `vite` / `@vitejs/plugin-react` / `@salesforce/vite-plugin-ui-bundle` **from their own service `node_modules`**, not from the project. Only the 3 runtime deps (`react`, `react-dom`, `@salesforce/sdk-data`) are needed in the project tree. |
| template source (everything else) | ~0.5 MB | ~127 | Yes. |

## Contract

The template build (`scripts/zip-templates.js`) MUST produce a `content.zip`
that contains only the files a created project needs, while remaining
**byte-for-byte equivalent in behavior** for the consuming runtime
(`createProject`, `runViteBuild`, the preview server, and SDR deploy).

### C1 — Drop unmanaged `node_modules`

A `node_modules/` directory MUST be excluded from `content.zip` unless the
build script installed it (i.e. a sibling `package.json` exists at that
directory's parent). This is the build script's own invariant: it runs
`npm install` only next to a `package.json`. Concretely:

- **data-curator** ships **no root `package.json`** → its root `node_modules/`
  MUST NOT be in the archive.
- **local-react-test** ships a **root `package.json`** (legacy layout, Vite
  roots at the project root) → its root `node_modules/` MUST remain in the
  archive.

### C2 — Ship production-only bundle dependencies

For every directory where the build script runs `npm install` (root when a
root `package.json` exists, and each `uiBundles/<bundle>/` with a
`package.json`), the installed `node_modules/` placed into `content.zip` MUST
contain **production dependencies only** (`npm install --omit=dev`). Dev-only
toolchain packages MUST NOT be shipped.

The install MUST be deterministic regardless of any pre-existing
`node_modules/` on the build host (clean install, not an incremental layer
over a dev tree).

### C3 — Behavior is preserved

After C1 + C2, for every built-in template:

- `createProject(templateId)` extracts successfully and produces a project
  whose layout (`sfdx-project.json`, `force-app/...`, `uiBundles/<bundle>/`,
  manifests, `.forceignore`) is unchanged from before.
- `runViteBuild(projectDir)` (the deploy build path) succeeds and emits
  `<bundle>/dist/index.html` plus at least one hashed `.js` asset.
- The preview server (separate repo) continues to root Vite at the bundle dir
  and resolve its toolchain from the service — unaffected, because the
  project tree never supplied that toolchain.
- The end-to-end deploy contract (`npm run test:deploy:live`) still passes:
  deploy succeeds, the UIBundle ships, `appUrl` populates.

### C4 — `-X` mode-bit preservation is retained

The existing `zip -X` behavior (embed Unix mode bits, omit extra attribute
fields so `extract-zip` honors modes without `defaultFileMode`) MUST be
preserved for the slimmed archive.

## Non-goals

- No change to `createProject`, `config.ts`, `src/index.ts`, or any runtime
  code. The fix is entirely in the build script.
- No seed directory, hardlinks, symlinks, warmup hook, or cross-volume
  handling (see reversal below).
- No change to the deployment repo (`vaas-user-workspace`).

## Expected impact (measured)

- data-curator `content.zip`: **45 MB / 15,519 files → 1.5 MB / 455 files**.
- Extraction via the real `createProject` path: **~8.3 s → ~240 ms** (a ~35×
  speedup), on any filesystem (the win is far fewer inodes, not faster I/O),
  with no per-request infrastructure.
- `runViteBuild` over the slimmed project still succeeds (~600 ms–1.2 s) and
  emits a valid bundle.
- Published npm package shrinks by ~190 MB of `templates/dist` payload.

## Decision reversal

An earlier design proposed extracting each template's `node_modules` once at
service startup into a seed directory on the same volume as `PROJECTS_ROOT`,
then **hardlinking** it into each new project (symlinks were ruled out because
the preview server's Vite runs with `server.fs.strict` + realpath, which 403s
on a `node_modules` symlinked outside the project root).

Benchmarking on local APFS overturned it:

- Hardlinking the full tree (`cp -lR`) cost **6.77 s per project** vs today's
  **~8.3 s** — only ~18%, because hardlinking still creates all ~15.5k
  directory entries (it only avoids copying file data). On the production
  filesystem (RHEL9, likely NFS/EFS) where per-file metadata ops dominate even
  more, the gain could vanish or invert.
- The "80×" figure quoted early in design was the **symlink** number
  (0.02 s) — the approach we cannot use.

Slimming the archive removes the files entirely, so per-project cost drops to
sub-second **without** any seed/hardlink machinery, and is filesystem- and
deployment-topology-independent. It is a strictly smaller, lower-risk change
with a larger payoff. The hardlink design is therefore abandoned.

Verification that C3 holds was done before writing this spec: a project built
with production-only bundle deps and no root `node_modules` was run through the
real `runViteBuild`, which succeeded in **1.2 s** and emitted a valid bundle.
