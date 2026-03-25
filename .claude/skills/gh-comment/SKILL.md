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

| Source                | Name              |
|-----------------------|-------------------|
| `/cdd-code-review`   | CDD Code Review   |
| `/cdd-spec-review`   | CDD Spec Review   |
| Ad-hoc code review   | Code Review       |
| Quick feedback        | Quick Review      |
| Implementation notes  | Implementation    |

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

### 3. Dedup — patch existing or create new

Each comment type gets **one living comment** per PR. If a previous
comment from the same agent/type exists, update it in place instead of
creating a duplicate.

The dedup key is the first line: `🤖 {Name}`.

```bash
DEDUP_KEY="🤖 ${COMMENT_NAME}"

EXISTING_URL=$(gh pr view "$PR_NUMBER" --json comments \
  --jq ".comments[] | select(.body | startswith(\"${DEDUP_KEY}\")) | .url" \
  | tail -1)
COMMENT_ID=$(echo "$EXISTING_URL" | grep -oE '[0-9]+$')

if [ -n "$COMMENT_ID" ]; then
  gh api "repos/{owner}/{repo}/issues/comments/${COMMENT_ID}" \
    -X PATCH -f body="$COMMENT_BODY"
else
  gh pr comment "$PR_NUMBER" --body "$COMMENT_BODY"
fi
```

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

## Key Rules

1. **Always use this format.** Never post bare comments to PRs without
   the `🤖 {Name}` header. This is how humans distinguish agent output
   from human comments.

2. **One comment per type per PR.** The dedup logic ensures re-runs
   update the existing comment rather than creating duplicates.

3. **The body is yours.** This skill owns the envelope (header + dedup).
   The calling skill or agent owns the body content and can structure it
   however they need.
