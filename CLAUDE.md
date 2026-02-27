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
- **pre-push**: build + all tests with coverage (90% threshold)

Do not skip hooks with `--no-verify`. Only autonomous agents use this repo,
so the friction is intentional.

## Worktrees

Git worktrees share source files but **not** `node_modules`. Run `npm install`
in every new worktree before running tests or starting the server.

A `SessionStart` hook in `.claude/settings.json` handles this automatically for
Claude Code sessions — it detects a missing `node_modules` directory and runs
`npm install`.
