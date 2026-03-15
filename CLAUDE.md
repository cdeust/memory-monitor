# Memory Monitor Plugin

Neural brain map visualization for Claude Code's persistent memory system.

## Installation

### Via Marketplace (recommended)
```
/plugin marketplace add cdeust/memory-monitor
/plugin install memory-monitor
```

### Manual Setup
```bash
git clone https://github.com/cdeust/memory-monitor.git
cd memory-monitor
./scripts/setup.sh
```

## Slash Commands

After installation, the following commands are available from any Claude Code session:

- `/memory-monitor` — Launch the interactive brain map visualization in the browser

## MCP Tools

- **get_memory_graph** — Returns all memories and computed connections as JSON
- **get_memory_stats** — Summary counts by type, project, and recency
- **search_memories** — Full-text search across all memories with optional filters
- **get_memory_detail** — Full content of a single memory by ID
- **open_visualization** — Launch the Three.js neural brain map in the browser

## How It Works

The MCP server scans `~/.claude/projects/*/memory/` for `.md` files with YAML frontmatter, computes connections between memories based on shared references and content similarity, then renders the graph as an interactive Three.js 3D visualization with bloom, vignette, synaptic flow particles, and force-directed clustering.

Zero external dependencies — the MCP server is pure Node.js (stdio JSON-RPC 2.0) and the visualization is a self-contained HTML file.
