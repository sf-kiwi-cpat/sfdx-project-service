# spec/ — Human-Guarded Contracts

This directory is the **source of truth** for system behavior. Agents must
not modify these files. If a spec seems wrong, surface it to the human.

## Structure

Each feature gets a folder: `spec/<feature>/`

- `contract.spec.ts` — Executable test code (vitest). This is the real contract.
- `contract.md` — Prose derived from the test code. Auto-generated, never manually edited.

## Rules

- **Test code is source of truth.** `contract.md` is always derived from
  `contract.spec.ts`, never the reverse.
- **Never edit `contract.md` directly.** Edit `contract.spec.ts`, then
  regenerate with `/cdd-spec --refresh <feature>`.
- **To change a contract during implementation:** stop, go back to `/cdd-spec`,
  make the change, regenerate both artifacts, get human approval, then resume.
- A `PreToolUse` hook blocks agent writes to `spec/**/*.spec.ts`.

## Imports

Contract specs import from `src/` using relative paths:
```ts
import { buildApp } from '../../src/app.js';
```
The depth is always `../../` since specs live in `spec/<feature>/`.
