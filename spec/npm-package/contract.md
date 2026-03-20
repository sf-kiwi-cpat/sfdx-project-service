<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->
<!-- Regenerate with: /spec --refresh npm-package -->

# npm Package Shape Contract

**Source of truth:** `spec/npm-package/contract.spec.ts`
**Issue:** #80 — Make package npm-consumable: add files and bin fields

## Overview

The sf-project-service package must be consumable as an npm tarball.
Consumers install the tarball into a Docker image and start the service via `npx`.

## Contract

### package.json fields

| Field | Value | Purpose |
|-------|-------|---------|
| `files` | `["dist", "templates", "README.md"]` | Restrict `npm pack` to production artifacts only |
| `bin.sf-project-service` | `"./dist/index.js"` | Enable `npx sf-project-service` |

### Entry point

- `src/index.ts` must start with `#!/usr/bin/env node` shebang
- TypeScript preserves shebangs in compiled output, enabling direct execution

### Tarball contents

After `npm run build`, `npm pack` must produce a tarball containing **only**:

- `package.json`
- `README.md`
- `dist/**` (compiled JavaScript)
- `templates/**` (project templates)

The tarball must **not** contain:

- `src/` (TypeScript source)
- `spec/` or `tests/` (test files)
- `Dockerfile`
- `tsconfig.json`
- Dotfiles (`.eslintrc`, `.prettierrc`, etc.)

## Summary

- **3 describe blocks**, **8 tests**
- Groups: package.json fields (2), entry point (1), tarball contents (5)
