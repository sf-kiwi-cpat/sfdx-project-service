# SF Project Service — Claude Code Notes

## Development

```bash
npm install   # install dependencies (required in new worktrees)
npm test      # run tests (vitest)
npm run lint  # lint with eslint
npm run dev   # start dev server with watch mode
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
