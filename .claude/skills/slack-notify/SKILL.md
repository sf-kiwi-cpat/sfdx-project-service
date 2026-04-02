---
name: slack-notify
description: Post a bot-branded message to the correct GitHub bot thread in #app-studio-alerts. Use this whenever a CDD loop or skill needs to notify Slack about a PR event.
disable-model-invocation: false
allowed-tools: mcp__slack__slack_search_public_and_private, mcp__slack__slack_send_message, Bash
---

# /slack-notify — Post to PR Thread in #app-studio-alerts

Posts a bot-branded message as a reply in the GitHub bot's thread for a PR.
This is the single source of truth for how CDD loops and skills notify Slack.

## Arguments

```
/slack-notify PR_NUMBER SKILL_NAME BODY
```

- **PR_NUMBER** — the GitHub PR number (e.g., `138`)
- **SKILL_NAME** — the skill or loop posting the message (e.g., `CDD Code Review`)
- **BODY** — the message content (everything after the skill name)

If called without arguments, detect PR_NUMBER from the current branch:
```bash
PR_NUMBER=$(gh pr list --head "$(git branch --show-current)" --json number -q '.[0].number')
```

## Procedure

### Step 1: Build the PR URL

```bash
OWNER_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
PR_URL="https://github.com/${OWNER_REPO}/pull/${PR_NUMBER}"
```

### Step 2: Find the GitHub bot's thread

Search Slack for the PR URL in #app-studio-alerts:

```
slack_search_public_and_private(
  query: "${PR_URL} in:#app-studio-alerts",
  include_bots: true,
  include_context: false,
  limit: 10
)
```

### Step 3: Identify the correct thread parent

From the search results, find the message that meets **all** of these:

1. **Author is the GitHub bot** — user ID `U01V33YP01W`
2. **Is a thread parent** — the message's permalink `thread_ts` equals its
   own `message_ts`, OR it has a `reply_count` field
3. **Contains the PR URL** — the PR URL from Step 1 appears in the result
   (Slack indexes attachment content even though the MCP tool shows empty text)

If multiple GitHub bot messages match (e.g., the bot posts on PR open and
on PR merge), prefer the **earliest** one (lowest `message_ts`) — that's
the "PR opened" notification where the conversation thread lives.

### Step 4: Validate or abort

- **If a matching thread is found:** proceed to Step 5
- **If NO matching thread is found:** do NOT post a top-level message.
  Report: "No GitHub bot thread found for PR #N in #app-studio-alerts —
  skipping Slack notification." and stop.

### Step 5: Format and send the message

Build the message with the bot-branded header:

```
:robot_face: *{SKILL_NAME}* | PR #{PR_NUMBER}
{BODY}
```

Send as a thread reply:

```
slack_send_message(
  channel_id: "C0ANF2KL5HT",
  thread_ts: "{parent_message_ts}",
  message: "{formatted_message}"
)
```

## Examples

### Code review passed
```
/slack-notify 138 CDD Code Review :white_check_mark: *PASS* — zero contract discrepancies, clean diff
Labels: `impl:agent-reviewing` → `impl:agent-approved`
```

Produces:
```
:robot_face: *CDD Code Review* | PR #138
:white_check_mark: *PASS* — zero contract discrepancies, clean diff
Labels: `impl:agent-reviewing` → `impl:agent-approved`
```

### Spec review found gaps
```
/slack-notify 42 CDD Spec Review :warning: *HAS GAPS* — 2 must-address items
Labels: `spec:agent-reviewing` → `spec:agent-comments`
```

### Max retries hit
```
/slack-notify 42 CDD Spec Fix :rotating_light: Max retries (3) — human intervention needed
The spec fix loop has cycled 3 times without passing review.
```

## Key Rules

1. **Never create top-level messages.** Every notification threads under
   the GitHub bot's PR message. This keeps #app-studio-alerts organized
   with one thread per PR, anchored by the GitHub integration.

2. **Always verify the thread.** Match on PR URL + GitHub bot author.
   Do not match on "PR #N" text — that can appear in replies inside
   unrelated threads and cause messages to land in the wrong place.

3. **Always include the bot header.** The `:robot_face: *{SKILL_NAME}*`
   prefix lets developers instantly distinguish agent messages from human
   ones when scanning a thread.

4. **Keep messages lean.** The label transition line is the signal —
   don't restate what it already communicates (e.g., "ready for merge"
   or "findings posted to PR"). The PR URL is also redundant since the
   thread is anchored to the GitHub bot's PR notification.
