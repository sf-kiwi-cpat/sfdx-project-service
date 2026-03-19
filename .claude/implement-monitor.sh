#!/bin/bash
# Implementation Monitor — watches for spec:approved PRs and runs /implement
# Usage: ./.claude/implement-monitor.sh
# Stop:  Ctrl+C

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."
INTERVAL="${1:-300}" # default 5 minutes
MODEL="${CLAUDE_MODEL:-opus}"

cd "$REPO_ROOT"

echo "=== Implementation Monitor ==="
echo "Polling every ${INTERVAL}s for spec:approved PRs (model: $MODEL)"
echo "Press Ctrl+C to stop"
echo ""

while true; do
    # Plain bash — no LLM needed for the check
    PRS=$(gh pr list --state open --label spec:approved --json number,headRefName 2>/dev/null || echo "[]")

    if echo "$PRS" | jq -e 'length > 0' >/dev/null 2>&1; then
        echo "[$(date)] Found spec:approved PRs: $PRS"

        # Pass PR data into the prompt so Claude doesn't need to re-query
        {
            echo "The following PRs have the spec:approved label:"
            echo '```json'
            echo "$PRS"
            echo '```'
            echo ""
            cat "$SCRIPT_DIR/loops/implement-monitor.md"
        } | claude --model "$MODEL"
    else
        echo "[$(date)] No spec:approved PRs found"
    fi

    sleep "$INTERVAL"
done
