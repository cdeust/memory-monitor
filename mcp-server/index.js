#!/usr/bin/env node
// Memory Monitor — MCP Server
// Zero-dependency Node.js, stdio JSON-RPC 2.0

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

// ---------------------------------------------------------------------------
// YAML frontmatter parser (regex, no deps)
// ---------------------------------------------------------------------------

function parseYAMLFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const meta = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const kv = line.match(/^(\w[\w\s]*?):\s*(.+)$/);
    if (kv) {
      meta[kv[1].trim().toLowerCase()] = kv[2].trim();
    }
  }
  return { meta, body: match[2].trim() };
}

// ---------------------------------------------------------------------------
// Brain Index — persistence helpers
// ---------------------------------------------------------------------------

const BRAIN_INDEX_PATH = path.join(os.homedir(), ".claude", "brain-index.json");

function loadBrainIndex() {
  try {
    if (fs.existsSync(BRAIN_INDEX_PATH)) {
      return JSON.parse(fs.readFileSync(BRAIN_INDEX_PATH, "utf-8"));
    }
  } catch (e) {
    process.stderr.write(`[memory-monitor] Failed to load brain index: ${e.message}\n`);
  }
  return { version: 1, updatedAt: null, memories: {}, conversations: {}, threads: {} };
}

function saveBrainIndex(index) {
  index.updatedAt = new Date().toISOString();
  fs.writeFileSync(BRAIN_INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Shared keyword extraction
// ---------------------------------------------------------------------------

const TECHNICAL_SHORT_TERMS = new Set([
  "api", "sql", "jwt", "cli", "mcp", "git", "auth", "ssh", "ssl", "tls",
  "csv", "xml", "dom", "cdn", "dns", "tcp", "udp", "url", "uri", "http",
  "grpc", "cors", "crud", "orm", "rpc", "sdk", "npm", "prd", "cicd",
  "aws", "gcp", "k8s", "ci", "cd", "db", "io", "ui", "ux", "pr",
  "env", "pid", "llm", "rag", "gpu", "cpu", "ram", "ssd", "eof",
  "yml", "toml", "json", "html", "css", "wasm", "rust", "node",
  "deno", "bash", "zsh", "vim", "tmux", "redis", "kafka", "nginx",
  "hook", "cron", "mock", "stub", "lint", "type", "enum", "async",
]);

function extractKeywords(text) {
  return new Set(
    text.toLowerCase().split(/\W+/).filter(
      (w) => w.length > 6 || (w.length >= 2 && TECHNICAL_SHORT_TERMS.has(w))
    )
  );
}

function nameMatchesBody(name, body) {
  if (!name || !body || name.length <= 3) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(body);
}

function simpleHash(text) {
  const str = text.slice(0, 500);
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// Brain Index — auto-categorizer
// ---------------------------------------------------------------------------

const CATEGORY_RULES = {
  "bug-fix": ["fix", "bug", "broken", "crash", "error", "issue", "regression", "failing"],
  "feature": ["add", "implement", "new", "build", "create", "introduce", "support"],
  "refactor": ["refactor", "restructure", "clean up", "simplify", "extract", "rename"],
  "research": ["research", "investigate", "explore", "evaluate", "compare", "analyze"],
  "config": ["config", "setup", "install", "environment", "settings", "dependency"],
  "docs": ["document", "readme", "changelog", "comment", "guide", "tutorial"],
  "debug": ["debug", "log", "trace", "inspect", "diagnose", "why is"],
  "architecture": ["architecture", "design", "pattern", "system", "module", "protocol"],
  "deployment": ["deploy", "ci/cd", "pipeline", "release", "docker", "publish", "production"],
  "testing": ["test", "spec", "assert", "mock", "coverage", "unit test"],
};

function categorize(text) {
  const lower = text.toLowerCase();
  const scores = {};

  for (const [category, signals] of Object.entries(CATEGORY_RULES)) {
    let score = 0;
    for (const signal of signals) {
      if (signal.includes(" ")) {
        // Phrase match
        if (lower.includes(signal)) score += 1.5;
      } else {
        // Exact word match
        const regex = new RegExp(`\\b${signal}\\b`, "i");
        if (regex.test(lower)) score += 1.0;
      }
    }
    if (score > 0) scores[category] = score;
  }

  let best = "general";
  let bestScore = 0;
  let bestPhraseCount = 0;
  for (const [cat, sc] of Object.entries(scores)) {
    let phraseCount = 0;
    for (const signal of CATEGORY_RULES[cat]) {
      if (signal.includes(" ") && lower.includes(signal)) phraseCount++;
    }
    if (sc > bestScore + 0.5) {
      bestScore = sc;
      best = cat;
      bestPhraseCount = phraseCount;
    } else if (sc >= bestScore && sc > bestScore - 0.5) {
      if (phraseCount > bestPhraseCount || (phraseCount === bestPhraseCount && sc > bestScore)) {
        bestScore = sc;
        best = cat;
        bestPhraseCount = phraseCount;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Brain Index — auto-tagger
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "i",
  "it", "for", "not", "on", "with", "he", "as", "you", "do", "at",
  "this", "but", "his", "by", "from", "they", "we", "say", "her", "she",
  "or", "an", "will", "my", "one", "all", "would", "there", "their", "what",
  "so", "up", "out", "if", "about", "who", "get", "which", "go", "me",
  "when", "make", "can", "like", "time", "no", "just", "him", "know", "take",
  "people", "into", "year", "your", "good", "some", "could", "them", "see", "other",
  "than", "then", "now", "look", "only", "come", "its", "over", "think", "also",
]);

function autoTag(text) {
  const tokens = text.split(/[\s,;:!?()\[\]{}"'`]+/).filter(Boolean);
  const freq = {};
  const technical = new Set();

  for (const raw of tokens) {
    const lower = raw.toLowerCase();
    if (STOPWORDS.has(lower) || lower.length < 2) continue;

    // Detect technical terms
    if (/[A-Z][a-z]+[A-Z]/.test(raw)) {
      // camelCase — split and add parts
      const parts = raw.split(/(?=[A-Z])/).map((p) => p.toLowerCase());
      for (const p of parts) {
        if (p.length >= 2 && !STOPWORDS.has(p)) technical.add(p);
      }
    }
    if (raw.includes("-") && raw.length > 3) technical.add(lower);
    if (raw.includes(".") && raw.length > 3) technical.add(lower);

    freq[lower] = (freq[lower] || 0) + 1;
  }

  // Collect candidates: freq >= 2 OR length > 8
  const candidates = new Set();
  for (const [word, count] of Object.entries(freq)) {
    if (count >= 2 || word.length > 8) candidates.add(word);
  }
  for (const t of technical) candidates.add(t);

  // Sort by frequency descending, take top 5
  const sorted = [...candidates].sort((a, b) => (freq[b] || 0) - (freq[a] || 0)).slice(0, 5);

  // Convert to kebab-case, limit 3-8 tags
  const tags = sorted.map((t) => t.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  const filtered = tags.filter((t) => t.length > 0);
  return filtered.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Brain Index — lazy sync
// ---------------------------------------------------------------------------

function ensureIndexed(memories, conversations) {
  const index = loadBrainIndex();
  let dirty = false;

  // Index memories by path
  for (const mem of memories) {
    const key = mem.path;
    const textForAnalysis = `${mem.name} ${mem.description} ${mem.body || ""}`;
    const hash = simpleHash(textForAnalysis);

    if (!index.memories[key]) {
      index.memories[key] = {
        category: categorize(textForAnalysis),
        tags: autoTag(textForAnalysis),
        customTags: [],
        status: "active",
        threadId: null,
        crossRefs: [],
        contentHash: hash,
      };
      dirty = true;
    } else if (index.memories[key].contentHash !== hash) {
      const existing = index.memories[key];
      existing.category = categorize(textForAnalysis);
      existing.tags = autoTag(textForAnalysis);
      existing.contentHash = hash;
      dirty = true;
    }
  }

  // Index conversations by sessionId
  for (const conv of conversations) {
    const key = conv.sessionId;
    const textForAnalysis = `${conv.name} ${conv.slug || ""} ${conv.firstMessage || ""}`;
    const hash = simpleHash(textForAnalysis);

    if (!index.conversations[key]) {
      index.conversations[key] = {
        category: categorize(textForAnalysis),
        tags: autoTag(textForAnalysis),
        customTags: [],
        status: "active",
        threadId: null,
        crossRefs: [],
        contentHash: hash,
      };
      dirty = true;
    } else if (index.conversations[key].contentHash !== hash) {
      const existing = index.conversations[key];
      existing.category = categorize(textForAnalysis);
      existing.tags = autoTag(textForAnalysis);
      existing.contentHash = hash;
      dirty = true;
    }
  }

  if (dirty) saveBrainIndex(index);
  return index;
}

// ---------------------------------------------------------------------------
// Memory discovery
// ---------------------------------------------------------------------------

function discoverAllMemories() {
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeDir)) return [];

  const memories = [];
  let idCounter = 0;

  const projectDirs = fs.readdirSync(claudeDir, { withFileTypes: true });
  for (const pdir of projectDirs) {
    if (!pdir.isDirectory()) continue;

    const memoryDir = path.join(claudeDir, pdir.name, "memory");
    if (!fs.existsSync(memoryDir)) continue;

    const files = fs.readdirSync(memoryDir).filter(
      (f) => f.endsWith(".md")
    );

    for (const file of files) {
      const filePath = path.join(memoryDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const stat = fs.statSync(filePath);
        const { meta, body } = parseYAMLFrontmatter(content);
        const isIndex = file === "MEMORY.md";

        memories.push({
          id: `mem_${idCounter++}`,
          file,
          path: filePath,
          project: pdir.name,
          name: isIndex ? `Memory Index — ${pdir.name.replace(/^-Users-[^-]+(-Documents)?(-Developments)?-/, "").replace(/-/g, " ")}` : (meta.name || file.replace(/\.md$/, "")),
          description: isIndex ? "Memory index file listing all memory pointers" : (meta.description || ""),
          type: isIndex ? "memory-index" : (meta.type || "unknown"),
          body,
          nodeType: isIndex ? "memory-index" : "memory",
          modifiedAt: stat.mtime.toISOString(),
          createdAt: stat.birthtime ? stat.birthtime.toISOString() : null,
        });
      } catch (e) {
        process.stderr.write(
          `[memory-monitor] Failed to read ${filePath}: ${e.message}\n`
        );
      }
    }
  }

  return memories;
}

// ---------------------------------------------------------------------------
// Conversation discovery
// ---------------------------------------------------------------------------

const HEAD_BYTES = 32768; // 32KB
const TAIL_BYTES = 8192;  // 8KB

function readHeadTail(filePath) {
  const records = [];
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    // Read head
    const headSize = Math.min(HEAD_BYTES, fileSize);
    const headBuf = Buffer.alloc(headSize);
    fs.readSync(fd, headBuf, 0, headSize, 0);
    const headStr = headBuf.toString("utf-8");
    const headLines = headStr.split("\n");
    // Drop last line (likely incomplete)
    if (headSize < fileSize) headLines.pop();

    for (const line of headLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch (_) {}
    }

    // Read tail (only if file is bigger than head)
    if (fileSize > HEAD_BYTES + TAIL_BYTES) {
      const tailOffset = fileSize - TAIL_BYTES;
      const tailBuf = Buffer.alloc(TAIL_BYTES);
      fs.readSync(fd, tailBuf, 0, TAIL_BYTES, tailOffset);
      const tailStr = tailBuf.toString("utf-8");
      const tailLines = tailStr.split("\n");
      // Drop first line (likely incomplete)
      tailLines.shift();

      for (const line of tailLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed));
        } catch (_) {}
      }
    }
  } catch (e) {
    // Silently skip unreadable files
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return records;
}

// Cache for conversation discovery
let convCache = { data: null, ts: 0 };
const CONV_CACHE_TTL = 60000; // 60 seconds

function generateConvName(summary, slug, sessionId) {
  if (summary) {
    let line = summary.replace(/^#+\s*/, '').replace(/^\*\*.*?\*\*\s*/, '').split('\n')[0].trim();
    if (line.length > 60) line = line.slice(0, 57) + '...';
    return line || slug || sessionId.slice(0, 8);
  }
  return slug || sessionId.slice(0, 8);
}

function discoverConversations() {
  const now = Date.now();
  if (convCache.data && now - convCache.ts < CONV_CACHE_TTL) {
    return convCache.data;
  }

  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeDir)) return [];

  const conversations = [];
  let idCounter = 0;

  const projectDirs = fs.readdirSync(claudeDir, { withFileTypes: true });
  for (const pdir of projectDirs) {
    if (!pdir.isDirectory()) continue;

    const projPath = path.join(claudeDir, pdir.name);
    let entries;
    try {
      entries = fs.readdirSync(projPath, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      // Skip subagent files
      if (entry.name.includes("subagent")) continue;

      const filePath = path.join(projPath, entry.name);
      // Skip files inside subagents directories
      if (filePath.includes("/subagents/")) continue;

      try {
        const records = readHeadTail(filePath);
        if (records.length === 0) continue;

        // Extract metadata
        let sessionId = null;
        let slug = null;
        let firstTimestamp = null;
        let lastTimestamp = null;
        let firstMessage = null;
        let cwd = null;
        let userCount = 0;
        let assistantCount = 0;
        let gitBranch = null;
        let version = null;
        let permissionMode = null;
        const toolsUsed = new Set();
        let summary = null;
        let allTextParts = [];
        let allTextLen = 0;

        for (const rec of records) {
          if (rec.sessionId && !sessionId) sessionId = rec.sessionId;
          if (rec.slug && !slug) slug = rec.slug;
          if (rec.cwd && !cwd) cwd = rec.cwd;
          if (rec.gitBranch && !gitBranch) gitBranch = rec.gitBranch;
          if (rec.version && !version) version = rec.version;
          if (rec.type === 'user' && rec.permissionMode && !permissionMode) permissionMode = rec.permissionMode;

          if (rec.timestamp) {
            const ts = rec.timestamp;
            if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
            if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
          }

          if (rec.type === "user") {
            userCount++;
            if (rec.message && rec.message.content && !rec.isMeta && !rec.toolUseResult) {
              const content = typeof rec.message.content === "string"
                ? rec.message.content
                : Array.isArray(rec.message.content)
                  ? rec.message.content.filter(b => b.type === "text").map(b => b.text).join(" ")
                  : "";
              if (content && !content.startsWith('[Request interrupted')) {
                if (!firstMessage) firstMessage = content;
                if (!summary) summary = content;
                if (allTextLen < 2000) {
                  const chunk = content.slice(0, 2000 - allTextLen);
                  allTextParts.push(chunk);
                  allTextLen += chunk.length;
                }
              }
            }
          }
          if (rec.type === "assistant") assistantCount++;
          if (rec.type === "assistant" && rec.message && rec.message.content && Array.isArray(rec.message.content)) {
            for (const block of rec.message.content) {
              if (block.type === 'tool_use' && block.name) {
                toolsUsed.add(block.name);
              }
            }
          }
        }

        if (!sessionId) sessionId = entry.name.replace(/\.jsonl$/, "");
        const messageCount = userCount + assistantCount;
        if (messageCount === 0) continue;

        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const duration = (firstTimestamp && lastTimestamp) ? new Date(lastTimestamp) - new Date(firstTimestamp) : null;
        const turnCount = assistantCount;
        const allText = allTextParts.join(" ");
        const keywords = extractKeywords(allText);

        conversations.push({
          id: `conv_${idCounter++}`,
          sessionId,
          slug: slug || null,
          project: pdir.name,
          cwd: cwd || null,
          name: generateConvName(summary, slug, sessionId),
          startedAt: firstTimestamp || null,
          endedAt: lastTimestamp || null,
          messageCount,
          firstMessage: firstMessage || null,
          summary: summary || null,
          allText: allText || null,
          keywords,
          gitBranch: gitBranch || null,
          version: version || null,
          toolsUsed: Array.from(toolsUsed),
          permissionMode: permissionMode || null,
          duration: duration || null,
          fileSize: fileSize || null,
          turnCount: turnCount || 0,
          type: "conversation",
          nodeType: "conversation",
          modifiedAt: lastTimestamp || null,
          _filePath: filePath,
        });
      } catch (e) {
        process.stderr.write(
          `[memory-monitor] Failed to read conversation ${filePath}: ${e.message}\n`
        );
      }
    }
  }

  convCache = { data: conversations, ts: now };
  return conversations;
}

function filterRecentConversations(conversations, days = 90) {
  const cutoff = Date.now() - days * 86400000;
  return conversations.filter((c) => {
    if (!c.endedAt) return false;
    return new Date(c.endedAt).getTime() >= cutoff;
  });
}

// ---------------------------------------------------------------------------
// Global node discovery (settings, global CLAUDE.md)
// ---------------------------------------------------------------------------

function discoverGlobalNodes() {
  const nodes = [];
  const claudeDir = path.join(os.homedir(), '.claude');

  // settings.json — what plugins, permissions, hooks are active
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      const stat = fs.statSync(settingsPath);
      nodes.push({
        id: 'global_settings',
        file: 'settings.json',
        path: settingsPath,
        project: '__global__',
        name: 'Global Settings',
        description: 'Enabled plugins, permissions and hooks for Claude Code',
        type: 'settings',
        nodeType: 'settings',
        body: content,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch (_) {}
  }

  // Global CLAUDE.md — instructions that apply to every session
  const globalClaudePath = path.join(claudeDir, 'CLAUDE.md');
  if (fs.existsSync(globalClaudePath)) {
    try {
      const content = fs.readFileSync(globalClaudePath, 'utf-8');
      const stat = fs.statSync(globalClaudePath);
      nodes.push({
        id: 'global_claude_md',
        file: 'CLAUDE.md',
        path: globalClaudePath,
        project: '__global__',
        name: 'Global Instructions',
        description: 'Global CLAUDE.md — instructions applied to every project',
        type: 'global-instruction',
        nodeType: 'global-instruction',
        body: content,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch (_) {}
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Project hub discovery
// ---------------------------------------------------------------------------

function discoverProjectHubs(memories, projectFiles) {
  const projectSet = new Map(); // project -> { modifiedAt }
  for (const n of [...memories, ...projectFiles]) {
    if (!n.project || n.project === '__global__') continue;
    const existing = projectSet.get(n.project);
    const mtime = n.modifiedAt || '';
    if (!existing || mtime > existing.modifiedAt) {
      projectSet.set(n.project, { modifiedAt: mtime });
    }
  }

  const hubs = [];
  let i = 0;
  for (const [proj, meta] of projectSet) {
    const cleanName = proj
      .replace(/^-Users-[^-]+(-Documents)?(-Developments)?-/, '')
      .replace(/-/g, ' ')
      .trim() || proj;
    hubs.push({
      id: `hub_${i++}`,
      project: proj,
      name: cleanName,
      description: `Project hub: ${cleanName}`,
      type: 'project-hub',
      nodeType: 'project-hub',
      body: '',
      modifiedAt: meta.modifiedAt,
    });
  }
  return hubs;
}

// ---------------------------------------------------------------------------
// Plans discovery
// ---------------------------------------------------------------------------

function discoverPlans() {
  const plansDir = path.join(os.homedir(), '.claude', 'plans');
  if (!fs.existsSync(plansDir)) return [];
  const plans = [];
  let idCounter = 0;
  try {
    const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(plansDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const stat = fs.statSync(filePath);
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const name = titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, '').replace(/-/g, ' ');
        const sections = [...content.matchAll(/^##\s+(.+)$/gm)].map(m => m[1].trim());
        const descMatch = content.replace(/^#[^\n]*\n/, '').match(/([^\n#].{10,})/);
        const description = descMatch ? descMatch[1].trim().slice(0, 200) : '';
        plans.push({
          id: `plan_${idCounter++}`,
          file,
          path: filePath,
          project: '__global__',
          name,
          description,
          type: 'plan',
          nodeType: 'plan',
          body: content,
          sections,
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch (_) {}
    }
  } catch (_) {}
  return plans;
}

// ---------------------------------------------------------------------------
// MCP tools discovery
// ---------------------------------------------------------------------------

function discoverMcpTools(allConversations) {
  const seenPaths = new Set();
  const tools = [];
  let idCounter = 0;
  const cwds = [...new Set(allConversations.filter(c => c.cwd).map(c => c.cwd))];
  for (const cwd of cwds) {
    const mcpPath = path.join(cwd, '.mcp.json');
    if (seenPaths.has(mcpPath) || !fs.existsSync(mcpPath)) continue;
    seenPaths.add(mcpPath);
    try {
      const content = fs.readFileSync(mcpPath, 'utf-8');
      const config = JSON.parse(content);
      const servers = config.mcpServers || {};
      const projectEntry = allConversations.find(c => c.cwd === cwd);
      const project = projectEntry ? projectEntry.project : '__unknown__';
      const stat = fs.statSync(mcpPath);
      for (const [serverName, serverConfig] of Object.entries(servers)) {
        const cmd = `${serverConfig.command || 'node'} ${(serverConfig.args || []).join(' ')}`.trim();
        tools.push({
          id: `mcp_${idCounter++}`,
          file: '.mcp.json',
          path: mcpPath,
          project,
          cwd,
          name: serverName,
          description: `MCP server: ${cmd}`,
          type: 'mcp-tool',
          nodeType: 'mcp-tool',
          body: JSON.stringify(serverConfig, null, 2),
          command: serverConfig.command || 'node',
          args: serverConfig.args || [],
          env: serverConfig.env || {},
          modifiedAt: stat.mtime.toISOString(),
        });
      }
    } catch (_) {}
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Plugins discovery
// ---------------------------------------------------------------------------

function discoverPlugins() {
  const pluginsPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(pluginsPath)) return [];
  const plugins = [];
  let idCounter = 0;
  try {
    const data = JSON.parse(fs.readFileSync(pluginsPath, 'utf-8'));
    for (const [pluginId, installations] of Object.entries(data.plugins || {})) {
      const latest = installations[installations.length - 1];
      const shortName = pluginId.split('@')[0];
      plugins.push({
        id: `plugin_${idCounter++}`,
        file: 'installed_plugins.json',
        path: pluginsPath,
        project: '__global__',
        name: shortName,
        description: `Installed plugin · v${latest.version} · ${latest.scope} scope`,
        type: 'plugin',
        nodeType: 'plugin',
        body: JSON.stringify(latest, null, 2),
        pluginId,
        version: latest.version,
        installedAt: latest.installedAt,
        scope: latest.scope,
        modifiedAt: latest.lastUpdated || latest.installedAt,
      });
    }
  } catch (_) {}
  return plugins;
}

// ---------------------------------------------------------------------------
// Todos discovery
// ---------------------------------------------------------------------------

function discoverTodos() {
  const todosDir = path.join(os.homedir(), '.claude', 'todos');
  if (!fs.existsSync(todosDir)) return [];
  const todos = [];
  let idCounter = 0;
  try {
    const files = fs.readdirSync(todosDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(todosDir, file);
      try {
        const items = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!Array.isArray(items) || items.length === 0) continue;
        const stat = fs.statSync(filePath);
        // Extract sessionId from filename pattern: {sessionId}-agent-{agentId}.json
        const match = file.match(/^([a-f0-9-]+)-agent-([a-f0-9]+)\.json$/);
        const sessionId = match ? match[1] : null;
        const agentId = match ? match[2] : null;
        const pending = items.filter(i => i.status !== 'completed').length;
        const completed = items.filter(i => i.status === 'completed').length;
        const name = items[0].content.slice(0, 60) + (items.length > 1 ? ` (+${items.length - 1})` : '');
        const body = items.map(i => `[${i.status === 'completed' ? 'x' : i.status === 'in_progress' ? '~' : ' '}] ${i.content}`).join('\n');
        todos.push({
          id: `todo_${idCounter++}`,
          file,
          path: filePath,
          project: '__global__',
          sessionId,
          agentId,
          name: `Tasks: ${name}`,
          description: `${completed} done · ${pending} pending`,
          type: 'todo',
          nodeType: 'todo',
          body,
          items,
          totalItems: items.length,
          pendingItems: pending,
          completedItems: completed,
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch (_) {}
    }
  } catch (_) {}
  return todos;
}

// ---------------------------------------------------------------------------
// Edge builders for new types
// ---------------------------------------------------------------------------

function buildPlanEdges(plans, memories, projectFiles, hubs) {
  const edges = [];
  for (const plan of plans) {
    // Plans connect to all hubs (global planning applies to all projects)
    for (const hub of hubs) {
      edges.push({ source: plan.id, target: hub.id, weight: 0.4, edgeType: 'plan-hub' });
    }
    // Plans connect to memories with shared keywords
    const planWords = extractKeywords(plan.body);
    for (const mem of memories) {
      const memWords = extractKeywords(mem.body || '');
      let shared = 0;
      for (const w of planWords) if (memWords.has(w)) shared++;
      if (shared >= 3) edges.push({ source: plan.id, target: mem.id, weight: Math.min(shared * 0.1, 0.6), edgeType: 'plan-mem' });
    }
  }
  return edges;
}

function buildMcpToolEdges(mcpTools, hubs, projectFiles) {
  const edges = [];
  for (const tool of mcpTools) {
    // Connect to matching project hub
    const hub = hubs.find(h => h.project === tool.project);
    if (hub) edges.push({ source: tool.id, target: hub.id, weight: 0.8, edgeType: 'mcp-hub' });
    // Connect to matching project-file (CLAUDE.md uses this tool)
    const pf = projectFiles.find(p => p.project === tool.project);
    if (pf) edges.push({ source: tool.id, target: pf.id, weight: 0.6, edgeType: 'mcp-proj' });
  }
  return edges;
}

function buildPluginEdges(plugins, mcpTools, globalNodes) {
  const edges = [];
  for (const plugin of plugins) {
    // Connect plugin to global settings
    for (const g of globalNodes) {
      edges.push({ source: plugin.id, target: g.id, weight: 0.7, edgeType: 'plugin-global' });
    }
    // Connect plugin to matching mcp tools (by name prefix)
    for (const tool of mcpTools) {
      if (tool.name.includes(plugin.name) || plugin.name.includes(tool.name.split('-')[0])) {
        edges.push({ source: plugin.id, target: tool.id, weight: 0.9, edgeType: 'plugin-tool' });
      }
    }
  }
  return edges;
}

function buildTodoEdges(todos, hubs) {
  const edges = [];
  for (const todo of todos) {
    // Connect active todos to all hubs (they represent ongoing work)
    if (todo.pendingItems > 0) {
      for (const hub of hubs) {
        edges.push({ source: todo.id, target: hub.id, weight: 0.3, edgeType: 'todo-hub' });
      }
    }
  }
  return edges;
}

function buildProjectHubEdges(hubs, memories, projectFiles, globalNodes) {
  const edges = [];
  for (const hub of hubs) {
    for (const n of [...memories, ...projectFiles]) {
      if (n.project === hub.project) {
        const isAnchor = n.nodeType === 'memory-index' || n.nodeType === 'project-file';
        edges.push({ source: hub.id, target: n.id, weight: isAnchor ? 0.9 : 0.5, edgeType: 'hub-mem' });
      }
    }
    // Connect all project hubs to global settings
    for (const g of globalNodes) {
      edges.push({ source: g.id, target: hub.id, weight: 0.6, edgeType: 'global-hub' });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Project file discovery (CLAUDE.md)
// ---------------------------------------------------------------------------

let projFileCache = { data: null, ts: 0 };
const PROJ_FILE_CACHE_TTL = 60000;

function discoverProjectFiles(conversations) {
  const now = Date.now();
  if (projFileCache.data && now - projFileCache.ts < PROJ_FILE_CACHE_TTL) {
    return projFileCache.data;
  }

  const seen = new Set();
  const projectFiles = [];
  let idCounter = 0;

  for (const conv of conversations) {
    if (!conv.cwd || seen.has(conv.cwd)) continue;
    seen.add(conv.cwd);

    const claudePath = path.join(conv.cwd, "CLAUDE.md");
    if (fs.existsSync(claudePath)) {
      try {
        const content = fs.readFileSync(claudePath, "utf-8");
        const stat = fs.statSync(claudePath);
        projectFiles.push({
          id: `pf_${idCounter++}`,
          file: "CLAUDE.md",
          path: claudePath,
          project: conv.project,
          cwd: conv.cwd,
          name: `CLAUDE — ${path.basename(conv.cwd)}`,
          description: `Project instructions for ${path.basename(conv.cwd)}`,
          type: "project-file",
          nodeType: "project-file",
          body: content.slice(0, 1000),
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch (_) {}
    }
  }

  projFileCache = { data: projectFiles, ts: now };
  return projectFiles;
}

function buildProjectFileEdges(projectFiles, memories) {
  const edges = [];
  for (const pf of projectFiles) {
    const pfKeywords = extractKeywords(pf.body || "");
    for (const mem of memories) {
      if (mem.project !== pf.project) continue;
      if (mem.nodeType === "memory-index") {
        edges.push({ source: pf.id, target: mem.id, weight: 0.7, edgeType: "proj-mem" });
        continue;
      }
      const memKeywords = extractKeywords(mem.body || "");
      let shared = 0;
      for (const w of pfKeywords) {
        if (memKeywords.has(w)) shared++;
        if (shared >= 2) break;
      }
      if (shared >= 2) {
        edges.push({ source: pf.id, target: mem.id, weight: Math.min(0.3 + shared * 0.05, 0.6), edgeType: "proj-mem" });
      }
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Connection graph builder
// ---------------------------------------------------------------------------

function buildConnectionGraph(memories) {
  const edges = [];

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i];
      const b = memories[j];
      let weight = 0;

      // Same project
      if (a.project === b.project) weight += 0.3;

      // Same type
      if (a.type === b.type) weight += 0.2;

      // Name reference in body (word-boundary, skip short names)
      if (nameMatchesBody(b.name, a.body) || nameMatchesBody(a.name, b.body)) {
        weight += 0.8;
      }

      // Shared keywords
      const wordsA = extractKeywords(a.body);
      const wordsB = extractKeywords(b.body);
      let sharedCount = 0;
      for (const w of wordsA) {
        if (wordsB.has(w)) sharedCount++;
      }
      weight += Math.min(sharedCount * 0.1, 0.5);

      if (weight >= 0.2) {
        edges.push({
          source: a.id,
          target: b.id,
          weight: Math.min(weight, 1),
          edgeType: "mem-mem",
        });
      }
    }
  }

  return edges;
}

function buildBrainEdges(conversations, memories) {
  const edges = [];

  // Conversation ↔ Memory edges
  for (const conv of conversations) {
    const convStart = conv.startedAt ? new Date(conv.startedAt).getTime() : 0;
    const convEnd = conv.endedAt ? new Date(conv.endedAt).getTime() : 0;
    const convText = (conv.allText || conv.firstMessage || "").toLowerCase();
    const convKeywords = conv.keywords || extractKeywords(convText);

    for (const mem of memories) {
      let weight = 0;

      // Same project
      if (conv.project === mem.project) weight += 0.4;

      // Temporal overlap: memory modified during conversation (no buffer)
      const memTime = new Date(mem.modifiedAt).getTime();
      if (convStart && convEnd && memTime >= convStart && memTime <= convEnd) {
        weight += 0.3;
      }
      // Bonus if memory created near conversation start (within 5 min)
      if (mem.createdAt && convStart) {
        const createTime = new Date(mem.createdAt).getTime();
        if (Math.abs(createTime - convStart) < 300000) weight += 0.15;
      }

      // Memory name appears in conversation text (word-boundary)
      if (nameMatchesBody(mem.name, convText)) {
        weight += 0.5;
      }

      // Shared keywords between all user messages and memory body
      if (convKeywords.size > 0) {
        const bodyWords = extractKeywords(mem.body || "");
        let shared = 0;
        for (const w of convKeywords) {
          if (bodyWords.has(w)) shared++;
        }
        weight += Math.min(shared * 0.1, 0.3);
      }

      if (weight >= 0.3) {
        edges.push({
          source: conv.id,
          target: mem.id,
          weight: Math.min(weight, 1),
          edgeType: "conv-mem",
        });
      }
    }
  }

  // Conversation ↔ Conversation edges (content-based)
  for (let i = 0; i < conversations.length; i++) {
    for (let j = i + 1; j < conversations.length; j++) {
      const a = conversations[i];
      const b = conversations[j];
      let weight = 0;

      if (a.project === b.project) {
        weight += 0.10;
        const aEnd = a.endedAt ? new Date(a.endedAt).getTime() : 0;
        const bStart = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        const bEnd = b.endedAt ? new Date(b.endedAt).getTime() : 0;
        const aStart = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const gap = Math.min(Math.abs(aEnd - bStart), Math.abs(bEnd - aStart));
        if (gap < 86400000) weight += 0.10;
      }

      // Shared git branch
      if (a.gitBranch && b.gitBranch && a.gitBranch === b.gitBranch) weight += 0.20;

      // Shared keywords
      const aKeys = a.keywords || extractKeywords(a.allText || a.firstMessage || "");
      const bKeys = b.keywords || extractKeywords(b.allText || b.firstMessage || "");
      let sharedKw = 0;
      for (const w of aKeys) { if (bKeys.has(w)) sharedKw++; }
      if (sharedKw >= 2) weight += Math.min(sharedKw * 0.05, 0.25);

      // Shared tools (>=3 in common)
      if (a.toolsUsed && b.toolsUsed) {
        const aTools = new Set(a.toolsUsed);
        let sharedTools = 0;
        for (const t of b.toolsUsed) { if (aTools.has(t)) sharedTools++; }
        if (sharedTools >= 3) weight += 0.10;
      }

      if (weight >= 0.3) {
        edges.push({
          source: a.id,
          target: b.id,
          weight: Math.min(weight, 1),
          edgeType: "conv-conv",
        });
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// UI server
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Conversation message reader (for UI detail panel)
// ---------------------------------------------------------------------------

function readConversationMessages(filePath) {
  const messages = [];
  if (!filePath) return messages;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed);

        // User messages
        if (rec.type === "user" && rec.message && rec.message.content) {
          // Skip meta/system messages
          if (rec.isMeta) continue;
          // Skip tool results (internal plumbing)
          if (rec.toolUseResult) continue;

          const content =
            typeof rec.message.content === "string"
              ? rec.message.content
              : Array.isArray(rec.message.content)
              ? rec.message.content
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join(" ")
              : "";
          if (content && content.length > 5 && !content.startsWith("[Request interrupted")) {
            messages.push({
              role: "user",
              content,
              timestamp: rec.timestamp || null,
              cwd: rec.cwd || null,
              gitBranch: rec.gitBranch || null,
            });
          }
        }

        // Assistant messages
        if (rec.type === "assistant" && rec.message && rec.message.content) {
          const parts = Array.isArray(rec.message.content)
            ? rec.message.content
            : [{ type: "text", text: String(rec.message.content) }];

          const textBlocks = parts
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text);
          const text = textBlocks.join("\n").trim();

          const toolUses = parts
            .filter((b) => b.type === "tool_use")
            .map((b) => ({
              tool: b.name,
              input: summarizeToolInput(b.name, b.input),
            }));

          if (text || toolUses.length > 0) {
            messages.push({
              role: "assistant",
              content: text || null,
              tools: toolUses.length > 0 ? toolUses : null,
              timestamp: rec.timestamp || null,
              model: rec.message.model || rec.model || null,
              inputTokens: (rec.message.usage && rec.message.usage.input_tokens) || null,
              outputTokens: (rec.message.usage && rec.message.usage.output_tokens) || null,
            });
          }
        }

        // System records (turn duration)
        if (rec.type === "system" && rec.subtype === "turn_duration") {
          messages.push({
            role: "system",
            content: `Turn completed in ${(rec.durationMs / 1000).toFixed(1)}s`,
            timestamp: rec.timestamp || null,
          });
        }
      } catch (_) {}
    }
  } catch (_) {}
  return messages;
}

function summarizeToolInput(toolName, input) {
  if (!input) return null;
  switch (toolName) {
    case "Read":
      return input.file_path ? path.basename(input.file_path) : null;
    case "Edit":
      return input.file_path ? path.basename(input.file_path) : null;
    case "Write":
      return input.file_path ? path.basename(input.file_path) : null;
    case "Bash":
      return input.command ? input.command.slice(0, 120) : null;
    case "Glob":
      return input.pattern || null;
    case "Grep":
      return input.pattern ? `/${input.pattern}/` : null;
    case "Agent":
      return input.description || null;
    default:
      return null;
  }
}

function findConvFile(node) {
  if (!node.sessionId) return null;
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  const projPath = path.join(claudeDir, node.project);
  try {
    const files = fs.readdirSync(projPath);
    for (const f of files) {
      if (f.endsWith(".jsonl") && f.includes(node.sessionId)) {
        return path.join(projPath, f);
      }
    }
    // Try matching by filename pattern
    for (const f of files) {
      if (f === node.sessionId + ".jsonl") {
        return path.join(projPath, f);
      }
    }
  } catch (_) {}
  return null;
}

let activeServer = null;
let idleTimer = null;

function startUIServer(graphData) {
  return new Promise((resolve, reject) => {
    if (activeServer) {
      resetIdleTimer();
      resolve(activeServer.url);
      return;
    }

    const htmlPath = path.join(__dirname, "..", "ui", "index.html");
    let html;
    try {
      html = fs.readFileSync(htmlPath, "utf-8");
    } catch (e) {
      reject(new Error(`Could not read UI file: ${e.message}`));
      return;
    }

    // Prepare client data (strip internal fields, keep everything else for async loading)
    const clientData = {
      nodes: graphData.nodes.map(n => {
        const { _filePath, allText: _at, keywords: _kw, ...rest } = n;
        return rest;
      }),
      edges: graphData.edges,
    };
    // Serialize once for the API endpoint
    const clientDataJSON = JSON.stringify(clientData);

    // Tell the UI to fetch data async instead of inlining it
    html = html.replace(
      "/*__GRAPH_DATA__*/",
      `window.__GRAPH_DATA_URL__ = "/api/graph";`
    );

    const server = http.createServer((req, res) => {
      resetIdleTimer();
      const url = new URL(req.url, "http://localhost");

      // Async graph data endpoint
      if (url.pathname === "/api/graph") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(clientDataJSON);
        return;
      }

      // Brain visualization (volumetric particle mode)
      if (url.pathname === "/brain") {
        const brainPath = path.join(__dirname, "..", "ui", "brain.html");
        try {
          let brainHtml = fs.readFileSync(brainPath, "utf-8");
          brainHtml = brainHtml.replace("/*__GRAPH_DATA__*/", `window.__GRAPH_DATA_URL__ = "/api/graph";`);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
          res.end(brainHtml);
        } catch (e) {
          res.writeHead(404); res.end("Brain visualization not found: " + e.message);
        }
        return;
      }

      // API: fetch conversation messages or memory body on demand
      if (url.pathname === "/api/detail") {
        const nodeId = url.searchParams.get("id");
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-cache");
        try {
          const node = graphData.nodes.find(
            (n) => n.id === nodeId || n.sessionId === nodeId || n.path === nodeId
          );
          if (!node) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: "Node not found" }));
            return;
          }

          if (node.nodeType === "conversation") {
            // Read conversation messages from JSONL file
            const filePath = node._filePath || findConvFile(node);
            const messages = readConversationMessages(filePath);
            res.writeHead(200);
            res.end(JSON.stringify({
              type: "conversation",
              messages,
              summary: node.summary || null,
              firstMessage: node.firstMessage || null,
            }));
          } else {
            // Memory — body and description served on demand
            res.writeHead(200);
            res.end(JSON.stringify({
              type: "memory",
              body: node.body || "",
              description: node.description || "",
            }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      // API: analytics metrics for n8n / RAG integration
      if (url.pathname === "/api/analytics") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Access-Control-Allow-Origin", "*");
        try {
          const convs = graphData.nodes.filter(n => n.nodeType === "conversation");

          let totalMessages = 0, totalMs = 0, totalBytes = 0;
          convs.forEach(n => {
            totalMessages += n.messageCount || 0;
            if (n.startedAt && n.endedAt) totalMs += new Date(n.endedAt) - new Date(n.startedAt);
            totalBytes += n.fileSize || 0;
          });

          // Heatmap: 7 days x 24 hours
          const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
          convs.forEach(n => {
            if (!n.startedAt) return;
            const d = new Date(n.startedAt);
            heatmap[d.getDay()][d.getHours()]++;
          });

          // Weekly trend (last 90 days)
          const now = Date.now();
          const weeklyMap = {};
          convs.forEach(n => {
            if (!n.startedAt) return;
            const t = new Date(n.startedAt).getTime();
            if (now - t > 90 * 86400000) return;
            const d = new Date(n.startedAt);
            const weekStart = new Date(d);
            weekStart.setDate(d.getDate() - d.getDay());
            const key = weekStart.toISOString().slice(0, 10);
            weeklyMap[key] = (weeklyMap[key] || 0) + 1;
          });
          const weeklyTrend = Object.entries(weeklyMap)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([week, count]) => ({ week, count }));

          // Categories
          const categories = {};
          convs.forEach(n => {
            const cat = n.category || "general";
            categories[cat] = (categories[cat] || 0) + 1;
          });

          // Tools
          const tools = {};
          convs.forEach(n => {
            if (!n.toolsUsed) return;
            n.toolsUsed.forEach(t => { tools[t] = (tools[t] || 0) + 1; });
          });

          // Quality buckets
          const qualityBuckets = { "<1m": 0, "1-5m": 0, "5-30m": 0, "30m-2h": 0, ">2h": 0 };
          convs.forEach(n => {
            if (!n.startedAt || !n.endedAt) return;
            const mins = (new Date(n.endedAt) - new Date(n.startedAt)) / 60000;
            if (mins < 1) qualityBuckets["<1m"]++;
            else if (mins < 5) qualityBuckets["1-5m"]++;
            else if (mins < 30) qualityBuckets["5-30m"]++;
            else if (mins < 120) qualityBuckets["30m-2h"]++;
            else qualityBuckets[">2h"]++;
          });

          // Projects
          const projects = {};
          convs.forEach(n => {
            const proj = (n.project || "unknown").replace(/^-Users-[^-]+-/, "").replace(/-/g, "/");
            projects[proj] = (projects[proj] || 0) + 1;
          });

          // Lightweight conversation metadata for RAG
          const conversations = convs.map(n => ({
            id: n.sessionId || n.id,
            name: n.name,
            project: (n.project || "").replace(/^-Users-[^-]+-/, "").replace(/-/g, "/"),
            startedAt: n.startedAt || null,
            duration: n.startedAt && n.endedAt ? new Date(n.endedAt) - new Date(n.startedAt) : null,
            messageCount: n.messageCount || 0,
            toolsUsed: n.toolsUsed || [],
            category: n.category || "general",
          }));

          res.writeHead(200);
          res.end(JSON.stringify({
            totalSessions: convs.length,
            totalMessages,
            totalHours: parseFloat((totalMs / 3600000).toFixed(1)),
            totalMB: parseFloat((totalBytes / 1048576).toFixed(1)),
            heatmap,
            weeklyTrend,
            categories,
            tools,
            qualityBuckets,
            projects,
            conversations,
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(html);
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}`;
      activeServer = { server, url, port };
      resetIdleTimer();
      resolve(url);
    });

    server.on("error", reject);
  });
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (activeServer) {
      activeServer.server.close();
      activeServer = null;
      process.stderr.write("[memory-monitor] UI server closed (idle timeout)\n");
    }
  }, 5 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = {
  get_memory_graph: {
    description:
      "Returns memories and conversations as a brain-mapping graph with typed edges for visualization",
    inputSchema: {
      type: "object",
      properties: {
        include_conversations: {
          type: "boolean",
          description: "Include conversation nodes in the graph (default: true)",
        },
        days: {
          type: "number",
          description: "Only include conversations from the last N days (default: 90)",
        },
      },
      required: [],
    },
    handler: async ({ include_conversations, days } = {}) => {
      const includeConv = include_conversations !== false;
      const dayLimit = days || 90;

      const memories = discoverAllMemories();
      const memEdges = buildConnectionGraph(memories);
      const memNodes = memories.map(({ body, ...rest }) => rest);

      if (!includeConv) {
        return {
          nodes: memNodes,
          edges: memEdges,
          totalMemories: memNodes.length,
          totalConversations: 0,
          totalEdges: memEdges.length,
        };
      }

      const allConvs = discoverConversations();
      const convs = filterRecentConversations(allConvs, dayLimit);
      const brainEdges = buildBrainEdges(convs, memories);
      const projectFiles = discoverProjectFiles(allConvs);
      const projEdges = buildProjectFileEdges(projectFiles, memories);
      const globalNodes = discoverGlobalNodes();
      const hubs = discoverProjectHubs(memories, projectFiles);
      const hubEdges = buildProjectHubEdges(hubs, memories, projectFiles, globalNodes);

      // Lazy-sync brain index
      const brainIndex = ensureIndexed(memories, allConvs);

      // Strip internal fields from conv nodes and merge brain index fields
      const convNodes = convs.map(({ _filePath, ...rest }) => {
        const entry = brainIndex.conversations[rest.sessionId];
        if (entry) {
          rest.category = entry.category;
          rest.tags = entry.tags;
          rest.customTags = entry.customTags;
          rest.status = entry.status;
          rest.threadId = entry.threadId;
          rest.crossRefs = entry.crossRefs || [];
        }
        return rest;
      });

      // Merge brain index fields onto memory nodes
      const enrichedMemNodes = memNodes.map((node) => {
        const entry = brainIndex.memories[node.path];
        if (entry) {
          node.category = entry.category;
          node.tags = entry.tags;
          node.customTags = entry.customTags;
          node.status = entry.status;
          node.threadId = entry.threadId;
          node.crossRefs = entry.crossRefs || [];
        }
        return node;
      });

      const plans = discoverPlans();
      const mcpTools = discoverMcpTools(allConvs);
      const plugins = discoverPlugins();
      const todos = discoverTodos();
      const planEdges = buildPlanEdges(plans, memories, projectFiles, hubs);
      const mcpEdges = buildMcpToolEdges(mcpTools, hubs, projectFiles);
      const pluginEdges = buildPluginEdges(plugins, mcpTools, globalNodes);
      const todoEdges = buildTodoEdges(todos, hubs);

      const allNodes = [...enrichedMemNodes, ...convNodes, ...projectFiles, ...globalNodes, ...hubs, ...plans, ...mcpTools, ...plugins, ...todos];
      const rawEdges = [...memEdges, ...brainEdges, ...projEdges, ...hubEdges, ...planEdges, ...mcpEdges, ...pluginEdges, ...todoEdges];

      // Add cross-reference edges
      const nodeIdByKey = {};
      for (const mem of memories) nodeIdByKey[mem.path] = mem.id;
      for (const conv of convs) nodeIdByKey[conv.sessionId] = conv.id;

      for (const [key, entry] of Object.entries(brainIndex.memories)) {
        if (entry.crossRefs && nodeIdByKey[key]) {
          for (const ref of entry.crossRefs) {
            if (nodeIdByKey[ref]) {
              rawEdges.push({ source: nodeIdByKey[key], target: nodeIdByKey[ref], weight: 1.0, edgeType: "cross-ref" });
            }
          }
        }
      }
      for (const [key, entry] of Object.entries(brainIndex.conversations)) {
        if (entry.crossRefs && nodeIdByKey[key]) {
          for (const ref of entry.crossRefs) {
            if (nodeIdByKey[ref]) {
              rawEdges.push({ source: nodeIdByKey[key], target: nodeIdByKey[ref], weight: 1.0, edgeType: "cross-ref" });
            }
          }
        }
      }

      // Deduplicate edges — keep highest weight per pair
      const edgeMap = new Map();
      for (const edge of rawEdges) {
        const k = edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`;
        const existing = edgeMap.get(k);
        if (!existing || edge.weight > existing.weight) edgeMap.set(k, edge);
      }
      const allEdges = Array.from(edgeMap.values());

      return {
        nodes: allNodes,
        edges: allEdges,
        totalMemories: enrichedMemNodes.length,
        totalConversations: convNodes.length,
        totalProjectFiles: projectFiles.length,
        totalEdges: allEdges.length,
        totalPlans: plans.length,
        totalMcpTools: mcpTools.length,
        totalPlugins: plugins.length,
        totalTodos: todos.length,
      };
    },
  },

  get_memory_stats: {
    description:
      "Returns summary statistics about memories and conversations: counts by type, project, and recency",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    handler: async () => {
      const memories = discoverAllMemories();
      const byType = {};
      const byProject = {};
      const now = Date.now();
      let recent7d = 0;
      let recent30d = 0;

      for (const m of memories) {
        byType[m.type] = (byType[m.type] || 0) + 1;

        const projName = m.project.replace(/^-Users-[^-]+-Developments-/, "").replace(/^-Users-[^-]+-/, "");
        byProject[projName] = (byProject[projName] || 0) + 1;

        const age = now - new Date(m.modifiedAt).getTime();
        if (age < 7 * 86400000) recent7d++;
        if (age < 30 * 86400000) recent30d++;
      }

      // Conversation stats
      const allConvs = discoverConversations();
      const convByProject = {};
      let convRecent7d = 0;
      let convRecent30d = 0;

      for (const c of allConvs) {
        const projName = c.project.replace(/^-Users-[^-]+-Developments-/, "").replace(/^-Users-[^-]+-/, "");
        convByProject[projName] = (convByProject[projName] || 0) + 1;

        if (c.endedAt) {
          const age = now - new Date(c.endedAt).getTime();
          if (age < 7 * 86400000) convRecent7d++;
          if (age < 30 * 86400000) convRecent30d++;
        }
      }

      return {
        total: memories.length,
        byType,
        byProject,
        recent7d,
        recent30d,
        conversations: {
          total: allConvs.length,
          byProject: convByProject,
          recent7d: convRecent7d,
          recent30d: convRecent30d,
        },
      };
    },
  },

  search_memories: {
    description:
      "Full-text search across all memories with optional type, project, category, tag, status, and thread filters",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string",
        },
        type: {
          type: "string",
          description: "Filter by memory type (user, feedback, project, reference)",
        },
        project: {
          type: "string",
          description: "Filter by project name (substring match)",
        },
        category: {
          type: "string",
          description: "Filter by brain index category",
        },
        tag: {
          type: "string",
          description: "Filter by brain index tag (auto or custom)",
        },
        status: {
          type: "string",
          description: "Filter by brain index status",
        },
        thread: {
          type: "string",
          description: "Filter by brain index thread ID",
        },
      },
      required: ["query"],
    },
    handler: async ({ query, type, project, category, tag, status, thread }) => {
      let memories = discoverAllMemories();
      const allConvs = discoverConversations();
      const brainIndex = ensureIndexed(memories, allConvs);
      const q = query.toLowerCase();

      if (type) {
        memories = memories.filter((m) => m.type === type);
      }
      if (project) {
        const p = project.toLowerCase();
        memories = memories.filter((m) => m.project.toLowerCase().includes(p));
      }

      let results = memories
        .filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.description.toLowerCase().includes(q) ||
            m.body.toLowerCase().includes(q)
        )
        .map(({ body, ...rest }) => rest);

      // Apply brain index filters
      if (category || tag || status || thread) {
        results = results.filter((r) => {
          const entry = brainIndex.memories[r.path];
          if (!entry) return false;
          if (category && entry.category !== category) return false;
          if (tag && !(entry.tags || []).includes(tag) && !(entry.customTags || []).includes(tag)) return false;
          if (status && entry.status !== status) return false;
          if (thread && entry.threadId !== thread) return false;
          return true;
        });
      }

      return { results, count: results.length };
    },
  },

  search_conversations: {
    description:
      "Search conversations by slug, first message content, or project with optional category, tag, status, and thread filters",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string (matches slug and first message)",
        },
        project: {
          type: "string",
          description: "Filter by project name (substring match)",
        },
        days: {
          type: "number",
          description: "Only search within the last N days (default: 90)",
        },
        category: {
          type: "string",
          description: "Filter by brain index category",
        },
        tag: {
          type: "string",
          description: "Filter by brain index tag (auto or custom)",
        },
        status: {
          type: "string",
          description: "Filter by brain index status",
        },
        thread: {
          type: "string",
          description: "Filter by brain index thread ID",
        },
      },
      required: ["query"],
    },
    handler: async ({ query, project, days, category, tag, status, thread }) => {
      const allConvs = discoverConversations();
      const memories = discoverAllMemories();
      const brainIndex = ensureIndexed(memories, allConvs);
      let convs = filterRecentConversations(allConvs, days || 90);
      const q = query.toLowerCase();

      if (project) {
        const p = project.toLowerCase();
        convs = convs.filter((c) => c.project.toLowerCase().includes(p));
      }

      let results = convs
        .filter(
          (c) =>
            (c.name && c.name.toLowerCase().includes(q)) ||
            (c.slug && c.slug.toLowerCase().includes(q)) ||
            (c.firstMessage && c.firstMessage.toLowerCase().includes(q))
        )
        .map(({ _filePath, ...rest }) => rest);

      // Apply brain index filters
      if (category || tag || status || thread) {
        results = results.filter((r) => {
          const entry = brainIndex.conversations[r.sessionId];
          if (!entry) return false;
          if (category && entry.category !== category) return false;
          if (tag && !(entry.tags || []).includes(tag) && !(entry.customTags || []).includes(tag)) return false;
          if (status && entry.status !== status) return false;
          if (thread && entry.threadId !== thread) return false;
          return true;
        });
      }

      return { results, count: results.length };
    },
  },

  get_memory_detail: {
    description: "Returns the full content of a single memory by its ID",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Memory ID (e.g. mem_0)",
        },
      },
      required: ["id"],
    },
    handler: async ({ id }) => {
      const memories = discoverAllMemories();
      const memory = memories.find((m) => m.id === id);
      if (!memory) {
        throw new Error(`Memory not found: ${id}`);
      }
      const brainIndex = loadBrainIndex();
      const brainEntry = brainIndex.memories[memory.path] || null;
      return { ...memory, brainIndex: brainEntry };
    },
  },

  get_conversation_detail: {
    description:
      "Returns detailed information about a single conversation by ID or session ID",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Conversation ID (e.g. conv_0) or session UUID",
        },
      },
      required: ["id"],
    },
    handler: async ({ id }) => {
      const allConvs = discoverConversations();
      const conv = allConvs.find(
        (c) => c.id === id || c.sessionId === id
      );
      if (!conv) {
        throw new Error(`Conversation not found: ${id}`);
      }

      // Read more of the file to get first 5 user messages
      const filePath = conv._filePath;
      const userMessages = [];
      try {
        const headBuf = Buffer.alloc(Math.min(65536, fs.statSync(filePath).size));
        const fd = fs.openSync(filePath, "r");
        fs.readSync(fd, headBuf, 0, headBuf.length, 0);
        fs.closeSync(fd);
        const lines = headBuf.toString("utf-8").split("\n");
        for (const line of lines) {
          if (userMessages.length >= 5) break;
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const rec = JSON.parse(trimmed);
            if (rec.type === "user" && rec.message && rec.message.content) {
              const content = typeof rec.message.content === "string"
                ? rec.message.content
                : Array.isArray(rec.message.content)
                  ? rec.message.content.filter(b => b.type === "text").map(b => b.text).join(" ")
                  : "";
              if (content) userMessages.push(content.slice(0, 300));
            }
          } catch (_) {}
        }
      } catch (_) {}

      // Find linked memory IDs
      const memories = discoverAllMemories();
      const brainEdges = buildBrainEdges([conv], memories);
      const linkedMemoryIds = brainEdges
        .filter((e) => e.edgeType === "conv-mem")
        .map((e) => e.target);

      const { _filePath, ...result } = conv;
      const brainIdx = loadBrainIndex();
      const brainEntry = brainIdx.conversations[conv.sessionId] || null;
      return {
        ...result,
        userMessages,
        linkedMemoryIds,
        brainIndex: brainEntry,
      };
    },
  },

  open_visualization: {
    description:
      "Launches the interactive brain-mapping visualization in a browser showing memories and conversations",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    handler: async () => {
      const memories = discoverAllMemories();
      const memEdges = buildConnectionGraph(memories);

      const allConvs = discoverConversations();
      const convs = filterRecentConversations(allConvs, 90);
      const brainEdges = buildBrainEdges(convs, memories);
      const projectFiles = discoverProjectFiles(allConvs);
      const projEdges = buildProjectFileEdges(projectFiles, memories);
      const globalNodes = discoverGlobalNodes();
      const hubs = discoverProjectHubs(memories, projectFiles);
      const hubEdges = buildProjectHubEdges(hubs, memories, projectFiles, globalNodes);

      // Lazy-sync brain index
      const brainIndex = ensureIndexed(memories, allConvs);

      // Enrich memory nodes with brain index fields
      const enrichedMemories = memories.map((mem) => {
        const entry = brainIndex.memories[mem.path];
        if (entry) {
          mem.category = entry.category;
          mem.tags = entry.tags;
          mem.customTags = entry.customTags;
          mem.status = entry.status;
          mem.threadId = entry.threadId;
          mem.crossRefs = entry.crossRefs || [];
        }
        return mem;
      });

      const convNodes = convs.map((conv) => {
        const entry = brainIndex.conversations[conv.sessionId];
        const enriched = { ...conv };
        if (entry) {
          enriched.category = entry.category;
          enriched.tags = entry.tags;
          enriched.customTags = entry.customTags;
          enriched.status = entry.status;
          enriched.threadId = entry.threadId;
          enriched.crossRefs = entry.crossRefs || [];
        }
        return enriched;
      });

      const plans = discoverPlans();
      const mcpTools = discoverMcpTools(allConvs);
      const plugins = discoverPlugins();
      const todos = discoverTodos();
      const planEdges = buildPlanEdges(plans, memories, projectFiles, hubs);
      const mcpEdges = buildMcpToolEdges(mcpTools, hubs, projectFiles);
      const pluginEdges = buildPluginEdges(plugins, mcpTools, globalNodes);
      const todoEdges = buildTodoEdges(todos, hubs);

      const allNodes = [...enrichedMemories, ...convNodes, ...projectFiles, ...globalNodes, ...hubs, ...plans, ...mcpTools, ...plugins, ...todos];
      const rawEdges = [...memEdges, ...brainEdges, ...projEdges, ...hubEdges, ...planEdges, ...mcpEdges, ...pluginEdges, ...todoEdges];

      // Add cross-reference edges
      const nodeIdByKey = {};
      for (const mem of memories) nodeIdByKey[mem.path] = mem.id;
      for (const conv of convs) nodeIdByKey[conv.sessionId] = conv.id;

      for (const [key, entry] of Object.entries(brainIndex.memories)) {
        if (entry.crossRefs && nodeIdByKey[key]) {
          for (const ref of entry.crossRefs) {
            if (nodeIdByKey[ref]) {
              rawEdges.push({ source: nodeIdByKey[key], target: nodeIdByKey[ref], weight: 1.0, edgeType: "cross-ref" });
            }
          }
        }
      }
      for (const [key, entry] of Object.entries(brainIndex.conversations)) {
        if (entry.crossRefs && nodeIdByKey[key]) {
          for (const ref of entry.crossRefs) {
            if (nodeIdByKey[ref]) {
              rawEdges.push({ source: nodeIdByKey[key], target: nodeIdByKey[ref], weight: 1.0, edgeType: "cross-ref" });
            }
          }
        }
      }

      // Deduplicate edges — keep highest weight per pair
      const edgeMap2 = new Map();
      for (const edge of rawEdges) {
        const k = edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`;
        const existing = edgeMap2.get(k);
        if (!existing || edge.weight > existing.weight) edgeMap2.set(k, edge);
      }
      const allEdges = Array.from(edgeMap2.values());

      // graphData keeps _filePath for server-side API; stripped in HTML injection
      const graphData = { nodes: allNodes, edges: allEdges };
      const url = await startUIServer(graphData);

      const { exec } = require("child_process");
      const openCmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
          ? "start"
          : "xdg-open";
      exec(`${openCmd} "${url}"`);

      return {
        url,
        message: `Brain mapping visualization opened at ${url}`,
        totalMemories: enrichedMemories.length,
        totalConversations: convNodes.length,
        totalProjectFiles: projectFiles.length,
        totalProjectHubs: hubs.length,
        totalGlobalNodes: globalNodes.length,
        totalEdges: allEdges.length,
        totalPlans: plans.length,
        totalMcpTools: mcpTools.length,
        totalPlugins: plugins.length,
        totalTodos: todos.length,
      };
    },
  },

  reindex_brain: {
    description:
      "Performs a full reindex of the brain index: discovers all memories and conversations, rebuilds auto-fields (category, tags). Use force to rebuild everything.",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Force rebuild of all entries, not just missing/changed (default: false)",
        },
      },
      required: [],
    },
    handler: async ({ force } = {}) => {
      const memories = discoverAllMemories();
      const allConvs = discoverConversations();
      const index = loadBrainIndex();
      let indexed = 0;
      let updated = 0;
      let orphaned = 0;

      // Process memories
      for (const mem of memories) {
        const key = mem.path;
        const textForAnalysis = `${mem.name} ${mem.description} ${mem.body || ""}`;
        const hash = simpleHash(textForAnalysis);

        if (!index.memories[key]) {
          index.memories[key] = {
            category: categorize(textForAnalysis),
            tags: autoTag(textForAnalysis),
            customTags: [],
            status: "active",
            threadId: null,
            crossRefs: [],
            contentHash: hash,
          };
          indexed++;
        } else if (force || index.memories[key].contentHash !== hash) {
          const existing = index.memories[key];
          existing.category = categorize(textForAnalysis);
          existing.tags = autoTag(textForAnalysis);
          existing.contentHash = hash;
          updated++;
        }
      }

      // Process conversations
      for (const conv of allConvs) {
        const key = conv.sessionId;
        const textForAnalysis = `${conv.name} ${conv.slug || ""} ${conv.firstMessage || ""}`;
        const hash = simpleHash(textForAnalysis);

        if (!index.conversations[key]) {
          index.conversations[key] = {
            category: categorize(textForAnalysis),
            tags: autoTag(textForAnalysis),
            customTags: [],
            status: "active",
            threadId: null,
            crossRefs: [],
            contentHash: hash,
          };
          indexed++;
        } else if (force || index.conversations[key].contentHash !== hash) {
          const existing = index.conversations[key];
          existing.category = categorize(textForAnalysis);
          existing.tags = autoTag(textForAnalysis);
          existing.contentHash = hash;
          updated++;
        }
      }

      // Detect orphaned entries
      const memPaths = new Set(memories.map((m) => m.path));
      for (const key of Object.keys(index.memories)) {
        if (!memPaths.has(key)) orphaned++;
      }
      const convIds = new Set(allConvs.map((c) => c.sessionId));
      for (const key of Object.keys(index.conversations)) {
        if (!convIds.has(key)) orphaned++;
      }

      saveBrainIndex(index);
      return { indexed, updated, orphaned };
    },
  },

  get_brain_index: {
    description:
      "Returns the brain index entries, optionally filtered by category, tag, status, thread, or node type",
    inputSchema: {
      type: "object",
      properties: {
        filter_category: {
          type: "string",
          description: "Filter by category (e.g. bug-fix, feature, refactor)",
        },
        filter_tag: {
          type: "string",
          description: "Filter by tag (matches both auto and custom tags)",
        },
        filter_status: {
          type: "string",
          description: "Filter by status (e.g. active, archived)",
        },
        filter_thread: {
          type: "string",
          description: "Filter by thread ID",
        },
        node_type: {
          type: "string",
          description: "Filter by node type: memory or conversation",
        },
      },
      required: [],
    },
    handler: async ({ filter_category, filter_tag, filter_status, filter_thread, node_type } = {}) => {
      const memories = discoverAllMemories();
      const allConvs = discoverConversations();
      const index = ensureIndexed(memories, allConvs);
      const results = [];

      function matchesFilters(entry) {
        if (filter_category && entry.category !== filter_category) return false;
        if (filter_tag && !(entry.tags || []).includes(filter_tag) && !(entry.customTags || []).includes(filter_tag)) return false;
        if (filter_status && entry.status !== filter_status) return false;
        if (filter_thread && entry.threadId !== filter_thread) return false;
        return true;
      }

      if (!node_type || node_type === "memory") {
        for (const mem of memories) {
          const entry = index.memories[mem.path];
          if (entry && matchesFilters(entry)) {
            const { body, ...rest } = mem;
            results.push({ ...rest, ...entry, indexKey: mem.path });
          }
        }
      }

      if (!node_type || node_type === "conversation") {
        for (const conv of allConvs) {
          const entry = index.conversations[conv.sessionId];
          if (entry && matchesFilters(entry)) {
            const { _filePath, ...rest } = conv;
            results.push({ ...rest, ...entry, indexKey: conv.sessionId });
          }
        }
      }

      return { entries: results, count: results.length };
    },
  },

  update_brain_entry: {
    description:
      "Manually override fields on a brain index entry (category, tags, customTags, status, threadId)",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The index key (memory path or conversation sessionId)",
        },
        category: {
          type: "string",
          description: "Override category",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Override auto-tags",
        },
        customTags: {
          type: "array",
          items: { type: "string" },
          description: "Set custom tags",
        },
        status: {
          type: "string",
          description: "Set status (e.g. active, archived, pinned)",
        },
        threadId: {
          type: "string",
          description: "Assign to a thread group",
        },
      },
      required: ["key"],
    },
    handler: async ({ key, category, tags, customTags, status, threadId }) => {
      const index = loadBrainIndex();
      let entry = index.memories[key] || index.conversations[key];
      const section = index.memories[key] ? "memories" : index.conversations[key] ? "conversations" : null;

      if (!entry || !section) {
        throw new Error(`Brain index entry not found: ${key}`);
      }

      if (category !== undefined) entry.category = category;
      if (tags !== undefined) entry.tags = tags;
      if (customTags !== undefined) entry.customTags = customTags;
      if (status !== undefined) entry.status = status;
      if (threadId !== undefined) entry.threadId = threadId;

      saveBrainIndex(index);
      return { key, section, entry };
    },
  },

  manage_thread: {
    description:
      "CRUD operations for thread groups: create, update, delete, or list threads",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "delete", "list"],
          description: "Action to perform",
        },
        id: {
          type: "string",
          description: "Thread ID (required for update/delete)",
        },
        name: {
          type: "string",
          description: "Thread name",
        },
        description: {
          type: "string",
          description: "Thread description",
        },
        color: {
          type: "string",
          description: "Thread color (hex or named)",
        },
      },
      required: ["action"],
    },
    handler: async ({ action, id, name, description, color }) => {
      const index = loadBrainIndex();

      switch (action) {
        case "create": {
          const threadId = `thread_${Date.now().toString(36)}`;
          index.threads[threadId] = {
            name: name || threadId,
            description: description || "",
            color: color || "#888888",
            createdAt: new Date().toISOString(),
          };
          saveBrainIndex(index);
          return { id: threadId, ...index.threads[threadId] };
        }
        case "update": {
          if (!id || !index.threads[id]) throw new Error(`Thread not found: ${id}`);
          if (name !== undefined) index.threads[id].name = name;
          if (description !== undefined) index.threads[id].description = description;
          if (color !== undefined) index.threads[id].color = color;
          saveBrainIndex(index);
          return { id, ...index.threads[id] };
        }
        case "delete": {
          if (!id || !index.threads[id]) throw new Error(`Thread not found: ${id}`);
          const deleted = index.threads[id];
          delete index.threads[id];
          saveBrainIndex(index);
          return { id, deleted };
        }
        case "list": {
          const threads = Object.entries(index.threads).map(([tid, t]) => ({ id: tid, ...t }));
          return { threads, count: threads.length };
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  },

  add_cross_reference: {
    description:
      "Adds a bidirectional cross-reference between two brain index entries",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source entry key (memory path or conversation sessionId)",
        },
        target: {
          type: "string",
          description: "Target entry key (memory path or conversation sessionId)",
        },
      },
      required: ["source", "target"],
    },
    handler: async ({ source, target }) => {
      const index = loadBrainIndex();
      const sourceEntry = index.memories[source] || index.conversations[source];
      const targetEntry = index.memories[target] || index.conversations[target];

      if (!sourceEntry) throw new Error(`Source entry not found: ${source}`);
      if (!targetEntry) throw new Error(`Target entry not found: ${target}`);

      if (!sourceEntry.crossRefs) sourceEntry.crossRefs = [];
      if (!targetEntry.crossRefs) targetEntry.crossRefs = [];

      if (!sourceEntry.crossRefs.includes(target)) sourceEntry.crossRefs.push(target);
      if (!targetEntry.crossRefs.includes(source)) targetEntry.crossRefs.push(source);

      saveBrainIndex(index);
      return { source: { key: source, crossRefs: sourceEntry.crossRefs }, target: { key: target, crossRefs: targetEntry.crossRefs } };
    },
  },

  remove_cross_reference: {
    description:
      "Removes a bidirectional cross-reference between two brain index entries",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source entry key (memory path or conversation sessionId)",
        },
        target: {
          type: "string",
          description: "Target entry key (memory path or conversation sessionId)",
        },
      },
      required: ["source", "target"],
    },
    handler: async ({ source, target }) => {
      const index = loadBrainIndex();
      const sourceEntry = index.memories[source] || index.conversations[source];
      const targetEntry = index.memories[target] || index.conversations[target];

      if (!sourceEntry) throw new Error(`Source entry not found: ${source}`);
      if (!targetEntry) throw new Error(`Target entry not found: ${target}`);

      if (sourceEntry.crossRefs) {
        sourceEntry.crossRefs = sourceEntry.crossRefs.filter((r) => r !== target);
      }
      if (targetEntry.crossRefs) {
        targetEntry.crossRefs = targetEntry.crossRefs.filter((r) => r !== source);
      }

      saveBrainIndex(index);
      return { source: { key: source, crossRefs: sourceEntry.crossRefs || [] }, target: { key: target, crossRefs: targetEntry.crossRefs || [] } };
    },
  },
};

// ---------------------------------------------------------------------------
// MCP JSON-RPC transport (stdio)
// ---------------------------------------------------------------------------

const SERVER_INFO = {
  name: "memory-monitor",
  version: "3.0.0",
};

function makeResponse(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function makeError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return makeResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
      return null;

    case "tools/list":
      return makeResponse(id, {
        tools: Object.entries(TOOLS).map(([name, def]) => ({
          name,
          description: def.description,
          inputSchema: def.inputSchema,
        })),
      });

    case "tools/call": {
      const toolName = (params || {}).name;
      const toolArgs = (params || {}).arguments || {};
      const tool = TOOLS[toolName];

      if (!tool) {
        return makeResponse(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: `Unknown tool: ${toolName}` },
                null,
                2
              ),
            },
          ],
        });
      }

      try {
        const result = await tool.handler(toolArgs);
        return makeResponse(id, {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        });
      } catch (err) {
        return makeResponse(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: err.message }, null, 2),
            },
          ],
          isError: true,
        });
      }
    }

    default:
      if (id !== undefined) {
        return makeError(id, -32601, `Method not found: ${method}`);
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// stdio transport — newline-delimited JSON-RPC
// ---------------------------------------------------------------------------

let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();

  let lines = buffer.split("\n");
  buffer = lines.pop();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Content-Length")) continue;

    try {
      const msg = JSON.parse(trimmed);
      handleRequest(msg)
        .then((response) => {
          if (response) {
            process.stdout.write(response + "\n");
          }
        })
        .catch((e) => {
          process.stderr.write(
            `[memory-monitor] Handler error: ${e.message}\n`
          );
        });
    } catch (e) {
      process.stderr.write(
        `[memory-monitor] Failed to parse message: ${e.message}\n`
      );
    }
  }
});

process.on("SIGTERM", () => {
  if (activeServer) activeServer.server.close();
  process.exit(0);
});
process.on("SIGINT", () => {
  if (activeServer) activeServer.server.close();
  process.exit(0);
});

process.stderr.write(`[memory-monitor] MCP server started (v3.0.0)\n`);
