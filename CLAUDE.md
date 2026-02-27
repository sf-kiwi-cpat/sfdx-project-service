# SF Project Service — Claude Code Notes

## Development

```bash
npm install   # install dependencies (required in new worktrees)
npm test      # run tests (vitest)
npm run lint  # lint with eslint
npm run dev   # start dev server with watch mode
```

## Worktrees

Git worktrees share source files but **not** `node_modules`. Run `npm install`
in every new worktree before running tests or starting the server.

A `SessionStart` hook in `.claude/settings.json` handles this automatically for
Claude Code sessions — it detects a missing `node_modules` directory and runs
`npm install`.
