# Contributing

Fastify REST API wrapping SFDX project operations. Development uses a
contract-driven workflow where you write specs and agents write code.

## Prerequisites

Node.js 20+, npm 10+, Git, [GitHub CLI](https://cli.github.com/) (`gh`),
and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`).

## Quick start

```bash
git clone <repo-url> && cd sf-project-service
npm install        # installs deps + git hooks
npm run dev        # dev server on http://localhost:3000
npm test           # all tests with coverage
```

See [docs/development.md](docs/development.md) for Docker, debugging, and
detailed setup.

## The workflow

Not everything needs the full workflow. Bug fixes, chores, and refactors can
skip it. For features and behavioral changes, the process is:

1. `/cdd-brief` gathers context and helps you pick work.
2. `/cdd-spec` turns your intent into executable contract tests.
3. `/cdd-implement` writes code to make those tests pass (runs automatically).
4. `/cdd-code-review` reviews the implementation (runs automatically).

You define what the system does. Agents figure out how. Your main job is
writing specs, approving them, and merging PRs.

See [docs/workflow-guide.md](docs/workflow-guide.md) for the full walkthrough.

## Further reading

- [Development Guide](docs/development.md) for environment setup and testing
- [Workflow Guide](docs/workflow-guide.md) for the contract-driven process
- [Architecture](docs/architecture.md) for system design
- [API Reference](docs/api.md) for endpoint docs
