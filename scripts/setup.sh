#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CLAUDE_DIR="$HOME/.claude"
MCP_CONFIG="$CLAUDE_DIR/mcp_config.json"

echo "=== Memory Monitor Setup ==="

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required but not found. Install Node.js >= 18."
  exit 1
fi

NODE_VERSION=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required (found v$NODE_VERSION)"
  exit 1
fi
echo "[ok] Node.js v$(node -v | tr -d 'v')"

# Ensure .claude directory
mkdir -p "$CLAUDE_DIR"

# Register in mcp_config.json
if [ -f "$MCP_CONFIG" ]; then
  # Check if already registered
  if node -e "const c=JSON.parse(require('fs').readFileSync('$MCP_CONFIG','utf-8')); process.exit(c.mcpServers && c.mcpServers['memory-monitor'] ? 0 : 1)" 2>/dev/null; then
    echo "[ok] Already registered in mcp_config.json"
  else
    # Add entry using Node.js for safe JSON manipulation
    node -e "
      const fs = require('fs');
      const c = JSON.parse(fs.readFileSync('$MCP_CONFIG', 'utf-8'));
      if (!c.mcpServers) c.mcpServers = {};
      c.mcpServers['memory-monitor'] = {
        command: 'node',
        args: ['$PROJECT_DIR/mcp-server/index.js']
      };
      fs.writeFileSync('$MCP_CONFIG', JSON.stringify(c, null, 2) + '\n');
    "
    echo "[ok] Registered in mcp_config.json"
  fi
else
  cat > "$MCP_CONFIG" <<MCPEOF
{
  "mcpServers": {
    "memory-monitor": {
      "command": "node",
      "args": ["$PROJECT_DIR/mcp-server/index.js"]
    }
  }
}
MCPEOF
  echo "[ok] Created mcp_config.json"
fi

# Symlink skills
SKILLS_DIR="$CLAUDE_DIR/skills"
mkdir -p "$SKILLS_DIR"
if [ -L "$SKILLS_DIR/memory-monitor" ] || [ -d "$SKILLS_DIR/memory-monitor" ]; then
  rm -rf "$SKILLS_DIR/memory-monitor"
fi
ln -s "$PROJECT_DIR/skills/memory-monitor" "$SKILLS_DIR/memory-monitor"
echo "[ok] Skills linked"

# Symlink commands
COMMANDS_DIR="$CLAUDE_DIR/commands"
mkdir -p "$COMMANDS_DIR"
if [ -L "$COMMANDS_DIR/memory-monitor.md" ] || [ -f "$COMMANDS_DIR/memory-monitor.md" ]; then
  rm -f "$COMMANDS_DIR/memory-monitor.md"
fi
ln -s "$PROJECT_DIR/commands/memory-monitor.md" "$COMMANDS_DIR/memory-monitor.md"
echo "[ok] Commands linked"

echo ""
echo "Setup complete! Restart Claude Code to activate the memory-monitor plugin."
echo "Then use /memory-monitor or call memory-monitor:open_visualization"
