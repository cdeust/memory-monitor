---
name: memory-monitor
description: Visualize Claude Code memory files as an interactive Divergent-inspired node graph
tools:
  - memory-monitor:get_memory_graph
  - memory-monitor:get_memory_stats
  - memory-monitor:search_memories
  - memory-monitor:get_memory_detail
  - memory-monitor:open_visualization
---

# Memory Monitor

Visualize and explore Claude Code's memory system as an interactive graph.

## Available Tools

- **get_memory_graph** — Returns all memories and computed connections as JSON for visualization
- **get_memory_stats** — Summary counts by type, project, and recency
- **search_memories** — Full-text search across all memories with optional type/project filters
- **get_memory_detail** — Full content of a single memory by ID
- **open_visualization** — Launch the interactive Divergent-inspired visualization in the browser

## Usage

Use `open_visualization` to launch the interactive graph in a browser. Use the other tools to query memory data programmatically.
