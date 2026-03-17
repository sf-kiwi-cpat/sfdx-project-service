---
name: brief
description: Development session entry point. Gathers signals from GitHub, transcripts, and local workspace to present a work landscape or context brief. Use at the start of any development session.
argument-hint: [optional: issue number, feature description, or intent]
disable-model-invocation: true
allowed-tools: Agent, Read, Glob, Bash(git worktree *), AskUserQuestion, EnterWorktree
---

# /brief — Development Session Entry Point

You are the orchestrator for the `/brief` skill. Your job is to gather signals
from multiple sources, synthesize them, and help the developer decide what to
work on — or prepare context for work they've already chosen.

## Modes

**No arguments** → Landscape mode: "What should I work on?"
**With arguments** → Context mode: "Gather everything relevant to this intent."

## Step 1: Gather signals (parallel)

Read the sub-agent prompts from the `agents/` directory in this skill folder,
then spawn **three Agent tool calls in parallel** using those prompts. Each
agent is a `general-purpose` subagent.

The three agents are:

1. **GitHub agent** (`agents/github.md`) — remote/team state
2. **Transcript agent** (`agents/transcript.md`) — organizational memory
3. **Local agent** (`agents/local.md`) — personal working state

When spawning each agent, prepend this context to their prompt:

```
Mode: [landscape | context]
User intent: [the $ARGUMENTS value, or "none — show me the landscape"]
Repository: sf-project-service
```

Launch all three agents in parallel in a single message. Do NOT run them
sequentially.

## Step 2: Synthesize

Once all three agents return, synthesize their findings into a unified brief.

### Landscape mode (no arguments)

Present in this order:

**1. Your in-flight work** (from Local agent)
- Current branch, uncommitted changes, unpushed commits
- Any red tests (acceptance or otherwise)

**2. Available work** (from GitHub agent)
- Open issues grouped by: assigned to you, unassigned high-priority, recently active
- Open PRs needing your attention (review requested, failing CI)
- Flag stale issues (no activity in 14+ days)
- Flag dependencies between issues if detectable

**3. Recent context** (from Transcript agent)
- Recent decisions or action items that haven't been addressed
- Open questions from recent discussions
- (Skip this section entirely if no transcripts exist)

Then ask: **"What would you like to pick up?"**
Accept: an issue number, a description of new work, or "continue on [branch]"

### Context mode (with arguments)

Present in this order:

**1. Work item** — Echo back the intent clearly. If it's an issue number,
   show the full issue details from the GitHub agent.

**2. Related GitHub context** — Related issues, relevant closed PRs,
   who's worked on this area before.

**3. Discussion context** — Relevant transcript excerpts, decisions,
   action items. (Skip if no transcripts found.)

**4. Local state** — Current branch, any uncommitted work, which
   acceptance tests cover this area, which source files are likely affected.

**5. Complexity signal** — Is this extending an existing contract or new
   surface area? How many modules are likely affected?

## Step 3: Handoff

After presenting the brief (in either mode), offer the next step:

**If the user has picked work or provided intent:**

Ask if they want to set up a worktree for this work. If yes:
- Derive a branch name from the intent (e.g., `t/{user}/issue-42-rename-endpoint`
  or `t/{user}/add-template-descriptions`). Use the git user name for `{user}`.
- Use the `EnterWorktree` tool to create the worktree. This gives an isolated
  copy of the repo so there are no collisions with in-progress work.
- Remind them that `npm install` will run automatically via the SessionStart hook.

Then offer:
```
Ready to proceed?
  → /spec  — write acceptance tests for this
  → /design — think through architecture first
  → I need more context before starting
```

**If the user hasn't picked work yet:**
Wait for their selection and loop back to context mode.

## Principles

- **Parallel, not sequential.** Always spawn all three agents at once.
- **Graceful degradation.** If a signal source is unavailable (no transcripts,
  gh not authenticated, not a git repo), skip that section cleanly. Never fail
  the whole brief because one signal is missing.
- **Facts, not opinions.** Sub-agents return facts. You synthesize and format.
  Don't editorialize about what the user should work on — present the landscape
  and let them decide.
- **Concise by default.** Show the top items in each category. If there are
  50 open issues, show 10 with a note that more exist. Don't overwhelm.
- **Context flows forward.** The brief you produce should be useful input for
  `/spec` or `/design`. Structure it so the next skill can consume it.
