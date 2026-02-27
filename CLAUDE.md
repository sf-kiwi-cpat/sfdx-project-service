# SF Project Service — Claude Code Notes

## Development

```bash
npm install   # install dependencies (required in new worktrees)
npm test      # run tests (vitest)
npm run test:unit          # unit tests only (3 files)
npm run test:integration   # integration tests only (4 files)
npm run test:coverage      # all tests + coverage report
npm run lint  # lint with eslint
npm run dev   # start dev server with watch mode
```

## Git Hooks (husky)

Hooks run automatically after `npm install` (via `prepare` script).

- **pre-commit**: lint-staged (prettier + eslint --fix on staged .ts) + unit tests
- **pre-push**: build + all tests with coverage (90% threshold; 85% for branches)

Do not skip hooks with `--no-verify`. Only autonomous agents use this repo,
so the friction is intentional.

Coverage thresholds are in `vitest.config.ts`. Coverage must run against
the full test suite (not unit-only) — integration tests provide most coverage.

## Docker

```bash
npm run build && docker build -t sf-project-service .   # build image (needs dist/ and node_modules/ on host)
docker run -p 3000:3000 sf-project-service               # run container
```

## Architecture

- ESM project (`"type": "module"`), Node.js >= 20, TypeScript strict mode
- Express REST API wrapping an SFDX project
- `.claude/settings.json` is team-shared (checked into git); `.claude/settings.local.json` is personal (gitignored)

## Worktrees

Git worktrees share source files but **not** `node_modules`. Run `npm install`
in every new worktree before running tests or starting the server.

A `SessionStart` hook in `.claude/settings.json` handles this automatically for
Claude Code sessions — it detects a missing `node_modules` directory and runs
`npm install`.

> **Gotcha:** `WorktreeCreate` hooks _replace_ the default git worktree creation
> (designed for non-git VCS). Do not use them for post-creation setup like
> `npm install` — use `SessionStart` instead.

## Gotchas

- Deleting a GitHub Actions workflow file does **not** remove its required status
  check from branch protection. Clean up via: `gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks -X PATCH --input <(echo '{"strict":true,"contexts":[]}')`
