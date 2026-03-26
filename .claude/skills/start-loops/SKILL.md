---
name: start-loops
description: Start all CDD background agent loops from a single command. Use this whenever the user says "start loops", "start the loops", "start CDD loops", "start monitoring", or wants to begin the automated CDD pipeline. Sets up 5 recurring cron jobs that poll for labeled PRs and dispatch CDD skills via subagents, all from one session.
---

# Start CDD Loops

Set up all 5 CDD monitor loops as recurring cron jobs in the current session.
Each loop polls every 5 minutes for PRs with specific labels assigned to the
current `gh` user, and dispatches work to a subagent via the Agent tool to keep
the main session's context clean.

## Procedure

1. **Read the loop definitions**: Use Glob to find all `.claude/loops/cdd-*.md`
   files, then Read each one.

2. **Extract the prompt from each file**: Each file has a `## Start` section
   containing a fenced code block with a `/loop 5m ...` command. Extract
   everything after the `/loop 5m ` prefix — that is the raw prompt for that
   loop.

3. **Start each loop**: For each extracted prompt, invoke the `/loop` skill
   with these args:

   ```
   5m Use the Agent tool to spawn a foreground subagent (do NOT use run_in_background) for this task: <raw-prompt>
   ```

   Call them sequentially — each `/loop` invocation creates a cron job and
   returns immediately, so this is fast.

4. **Confirm**: After all loops are running, print a summary:

   | Loop | Watches for | Action |
   |------|-------------|--------|
   | spec-review | `spec:agent-reviewing` | Runs `/cdd-spec-review` |
   | spec-fix | `spec:agent-comments` | Fixes spec findings |
   | implement | `spec:human-approved` | Runs `/cdd-implement` |
   | code-review | `impl:agent-reviewing` | Runs `/cdd-code-review` |
   | impl-fix | `impl:agent-comments` | Fixes code findings |

## Why subagents

Each cron fires its prompt into this session. That prompt spawns a subagent via
the Agent tool, so the heavy lifting (reading code, running tests, posting
comments) happens in the subagent's context — not the main session. This keeps
the main context window clean and avoids accumulating noise from cycles that
find nothing to do.

## Permissions

Subagents inherit your full permission stack (managed > local > project > user).
However, enterprise/managed settings take absolute precedence and may require
manual approval for certain tools regardless of local config.

Subagents MUST run in **foreground** (the default) — not background. Foreground
subagents pass permission prompts through to the user and **wait** for approval.
Background subagents cannot wait and will fail on unapproved tools. Since
enterprise restrictions may block commands that can't be pre-approved, foreground
mode is essential for the loops to work reliably.

## Notes

- Loops are **assignee-scoped**: they only pick up PRs assigned to the `gh`
  authenticated user, so multiple developers can run loops without conflicts.
- If a loop cycle finds no matching PRs, the subagent does nothing and returns
  quickly.
- The fix loops (spec-fix, impl-fix) have built-in max-retry safety — they
  stop after 3 review cycles and escalate to a human.
