#!/usr/bin/env bash
# Start the iteration 5 docs session on the API credits of the wiki-audit profile.
set -euo pipefail
cd "$(dirname "$0")"
export ANTHROPIC_PROFILE=wiki-audit
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
AGENT_ID=$(jq -r '.resources["./agents/tab-mcp-docs-writer.md"].id' claude-lock.json)
ENV_ID=$(jq -r '.resources["./environments/tab-mcp-docs.yaml"].id' claude-lock.json)
STYLE_ID=$(ant files upload --file writing-style.md --expires-in-seconds 86400 --transform id -r)
ant beta:sessions create \
  --agent "$AGENT_ID" --environment-id "$ENV_ID" \
  --title "tab-mcp iteration 5 docs $(date +%F)" \
  --resource '{type: github_repository, url: "https://github.com/ractive/tab-mcp", mount_path: /workspace/tab-mcp}' \
  --resource '{type: github_repository, url: "https://github.com/ractive/hyalo", mount_path: /workspace/hyalo}' \
  --resource "{type: file, file_id: $STYLE_ID, mount_path: /mnt/session/uploads/writing-style.md}" \
  --budget '{type: limit, max_list_cost: {amount: "6000", currency: USD}}' \
  --initial-event "{type: user.define_outcome, description: $(jq -Rs . task.md), max_iterations: 3, rubric: {type: text, content: $(jq -Rs . rubric.md)}}" \
  --transform id -r --format-error yaml
