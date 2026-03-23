#!/bin/bash
# Review Monitor — watches for impl:ready PRs and runs /review
# Usage: ./.claude/review-monitor.sh
# Stop:  Ctrl+C

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."
INTERVAL="${1:-300}" # default 5 minutes
MODEL="${CLAUDE_MODEL:-opus}"

cd "$REPO_ROOT"

echo "=== Review Monitor ==="
echo "Polling every ${INTERVAL}s for impl:ready PRs (model: $MODEL)"
echo "Press Ctrl+C to stop"
echo ""

while true; do
    # Plain bash — no LLM needed for the check
    PRS=$(gh pr list --state open --label impl:ready --json number,headRefName,title 2>/dev/null || echo "[]")

    if echo "$PRS" | jq -e 'length > 0' >/dev/null 2>&1; then
        echo "[$(date)] Found impl:ready PRs: $PRS"

        # Pass PR data into the prompt so Claude doesn't need to re-query
        {
            echo "The following PRs have the impl:ready label:"
            echo '```json'
            echo "$PRS"
            echo '```'
            echo ""
            cat "$SCRIPT_DIR/loops/review-monitor.md"
        } | claude --model "$MODEL"
    else
        echo "[$(date)] No impl:ready PRs found"
    fi

    sleep "$INTERVAL"
done
