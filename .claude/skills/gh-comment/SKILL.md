---
name: gh-comment
description: Post or update a comment on a GitHub PR with standard agent branding. Use this skill anytime an agent needs to leave a comment on a PR.
disable-model-invocation: false
allowed-tools: Bash, Read
---

# /gh-comment — Post Agent Comments to GitHub PRs

Use this skill whenever you need to leave a comment on a GitHub PR. It
standardizes format and branding so readers always know when a comment
came from an AI agent and which skill or workflow produced it.

## Comment Format

Every agent-posted PR comment follows this structure:

```
🤖 {Name}

---

{body}
```

**Name** — a short label identifying what produced the comment. Use
the skill or context name naturally:

| Source               | Name            |
| -------------------- | --------------- |
| `/cdd-code-review`   | CDD Code Review |
| `/cdd-spec-review`   | CDD Spec Review |
| Ad-hoc code review   | Code Review     |
| Quick feedback       | Quick Review    |
| Implementation notes | Implementation  |

You can use any descriptive name — the table above is guidance, not
an exhaustive list.

**Body** — the actual comment content in markdown. Structure this
however the calling skill or task requires. The body starts after the
horizontal rule and can contain any valid markdown.

## Posting Procedure

### 1. Determine PR number

If not provided as an argument, detect from the current branch:

```bash
PR_NUMBER=$(gh pr list --head "$(git branch --show-current)" --json number -q '.[0].number')
```

If no PR is found, skip posting and report that no PR exists.

### 2. Build the full comment

Combine the header and body:

```bash
COMMENT_BODY="$(cat <<EOF
🤖 ${COMMENT_NAME}

---

${BODY}
EOF
)"
```

### 3. Dedup — patch existing or create new (with revision history)

Each comment type gets **one living comment** per PR. If a previous
comment from the same agent/type exists, update it in place — but
preserve the previous verdict in a collapsed revision history so
reviewers can trace how findings evolved across passes.

The dedup key is the first line: `🤖 {Name}`.

```bash
DEDUP_KEY="🤖 ${COMMENT_NAME}"

EXISTING=$(gh pr view "$PR_NUMBER" --json comments \
  --jq ".comments[] | select(.body | startswith(\"${DEDUP_KEY}\"))")
EXISTING_URL=$(echo "$EXISTING" | jq -r '.url' | tail -1)
COMMENT_ID=$(echo "$EXISTING_URL" | grep -oE '[0-9]+$')

if [ -n "$COMMENT_ID" ]; then
  # Extract previous verdict line (first line after the --- separator)
  PREV_BODY=$(echo "$EXISTING" | jq -r '.body' | tail -1)
  PREV_UPDATED=$(echo "$EXISTING" | jq -r '.updatedAt' | tail -1)
  PREV_VERDICT=$(echo "$PREV_BODY" | sed -n '/^---$/,/^$/{ /^---$/d; /^$/d; p; }' | head -1)

  # Extract existing revision history if present
  PREV_HISTORY=$(echo "$PREV_BODY" | sed -n '/<details><summary>Revision history/,/<\/details>/p')

  # Build revision history section
  TIMESTAMP=$(echo "$PREV_UPDATED" | cut -dT -f1)
  if [ -n "$PREV_HISTORY" ]; then
    # Append to existing history (insert before </details>)
    NEW_HISTORY=$(echo "$PREV_HISTORY" | sed "s|</details>|- **${TIMESTAMP}:** ${PREV_VERDICT}\n</details>|")
  else
    # Create new history section
    NEW_HISTORY="<details><summary>Revision history</summary>

- **${TIMESTAMP}:** ${PREV_VERDICT}
</details>"
  fi

  # Append history to new comment body
  COMMENT_BODY="${COMMENT_BODY}

${NEW_HISTORY}"

  gh api "repos/{owner}/{repo}/issues/comments/${COMMENT_ID}" \
    -X PATCH -f body="$COMMENT_BODY"
else
  gh pr comment "$PR_NUMBER" --body "$COMMENT_BODY"
fi
```

**Revision history format:** When a comment is updated, the previous
verdict line is preserved in a collapsed `<details>` block at the bottom:

```
✅ SOLID — all gaps resolved

...current review body...

<details><summary>Revision history</summary>

- **2026-03-26:** ⚠️ HAS GAPS — 3 must-address items found
</details>
```

This keeps the thread clean (one comment) while preserving full
traceability of how the review evolved.

## Example

A CDD Code Review posting its findings — set the variables, then follow
the posting procedure above:

```bash
COMMENT_NAME="CDD Code Review"
BODY="## Contract Verification
Zero discrepancies found.

## Quality Findings
...

## Verdict
PASS — ready for human merge"

# Then: steps 1-3 from Posting Procedure above
```

## Review Labels

When the comment is a **code review** (CDD or ad-hoc), apply labels to
the PR based on the verdict. This keeps label hygiene consistent across
all review workflows.

**Do NOT use `gh pr edit` for labels** — it fails silently due to GitHub's
Projects Classic deprecation. Use the REST API:

**PASS:**

```bash
OWNER_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api "repos/$OWNER_REPO/issues/$PR_NUMBER/labels" -X POST -f "labels[]=impl:agent-approved"
gh api "repos/$OWNER_REPO/issues/$PR_NUMBER/labels/impl:agent-comments" -X DELETE 2>/dev/null
```

**NEEDS WORK:**

```bash
OWNER_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api "repos/$OWNER_REPO/issues/$PR_NUMBER/labels" -X POST -f "labels[]=impl:agent-comments"
gh api "repos/$OWNER_REPO/issues/$PR_NUMBER/labels/impl:agent-approved" -X DELETE 2>/dev/null
```

## Key Rules

1. **Always use this format.** Never post bare comments to PRs without
   the `🤖 {Name}` header. This is how humans distinguish agent output
   from human comments.

2. **One comment per type per PR.** The dedup logic ensures re-runs
   update the existing comment rather than creating duplicates.
   Previous verdicts are preserved in a collapsed revision history.

3. **The body is yours.** This skill owns the envelope (header + dedup).
   The calling skill or agent owns the body content and can structure it
   however they need.

4. **Label on review verdicts.** When the comment is a code review,
   always apply the corresponding label (see Review Labels above).
