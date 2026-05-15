# Tier 3 — live deploy tests

These tests deploy every built-in template (`templates/src/*`) against a
**real Salesforce org** and verify the end-to-end contract.

They run only when invoked explicitly via:

```bash
npm run test:deploy:live
```

They are excluded from `npm test`, `npm run test:integration`, and
pre-commit / pre-push hooks so that CI and day-to-day `vitest run`
never accidentally deploy to an org.

## Prerequisites

**One-time**: authenticate the sf CLI and set a default target org.

```bash
sf org login web --set-default
```

**Target org features**: the test harness does not provision an org
for you. The target org must have **Agentforce Vibe for Multi-Framework
(Beta)** enabled (`Setup → Apps → React Development with Agentforce
Vibes and Salesforce Multi-Framework (Beta)`). Templates that ship a
UIBundle — which is all of the built-in templates — will fail
otherwise.

## Targeting a non-default org

By default the test uses `sf config get target-org`. Override per-run
with an environment variable:

```bash
SF_TARGET_ORG=my-scratch-alias npm run test:deploy:live
```

The named alias must already be authed locally (`sf org login web -a
my-scratch-alias`). `SF_TARGET_ORG` only selects from local credentials;
it does not carry tokens.

## What the tests verify

For every template:

- Project creation via `POST /v1/projects` completes without error
- The deployment reaches a terminal `Succeeded` or `SucceededWithWarnings`
  state
- A `UIBundle` component is in the deployed component set
- The `complete` event payload includes an `appUrl` of the form
  `https://<org>/lwr/application/ai/c-<bundle>`
- Total wall-clock elapsed is under 180 seconds

On completion, the suite writes `tests/live/.last-run.json` with
per-template timings so you can track performance drift over time.

## Auto-skip behavior

If no default org is configured (`sf config get target-org` returns
empty) and `SF_TARGET_ORG` is unset, the suite logs a helpful message
and exits cleanly without running any deploy. This is what lets CI
still invoke the script safely — it becomes a no-op in the absence of
credentials.

## When to run it

Run before merging any PR that touches:

- `src/domain/deploy.ts`, `src/domain/deploy-auth.ts`
- `src/domain/build.ts`
- `src/routes/deploy.routes.ts`
- `templates/src/**` (any template source)
- New templates added under `templates/src/`

See the top-level `CLAUDE.md` for the guardrail wording.
