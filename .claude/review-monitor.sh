#!/bin/bash
# Review Monitor — watches for impl:ready PRs and runs /review
# Usage: ./.claude/review-monitor.sh
# Stop:  Ctrl+C

set -euo pipefail

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

    if [ "$PRS" != "[]" ] && [ "$PRS" != "" ]; then
        echo "[$(date)] Found impl:ready PRs: $PRS"

        # NOW spawn Claude with the best model to do the real work
        claude --model "$MODEL" < "$SCRIPT_DIR/loops/review-monitor.md"
    else
        echo "[$(date)] No impl:ready PRs found"
    fi

    sleep "$INTERVAL"
done
