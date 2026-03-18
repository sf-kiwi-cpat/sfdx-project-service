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

    if [ "$PRS" != "[]" ] && [ "$PRS" != "" ]; then
        echo "[$(date)] Found spec:approved PRs: $PRS"

        # NOW spawn Claude with the best model to do the real work
        claude --model "$MODEL" < "$SCRIPT_DIR/loops/implement-monitor.md"
    else
        echo "[$(date)] No spec:approved PRs found"
    fi

    sleep "$INTERVAL"
done
