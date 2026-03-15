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
  for (const [cat, sc] of Object.entries(scores)) {
    if (sc > bestScore) {
      bestScore = sc;
      best = cat;
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
      (f) => f.endsWith(".md") && f !== "MEMORY.md"
    );

    for (const file of files) {
      const filePath = path.join(memoryDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const stat = fs.statSync(filePath);
        const { meta, body } = parseYAMLFrontmatter(content);

        memories.push({
          id: `mem_${idCounter++}`,
          file,
          path: filePath,
          project: pdir.name,
          name: meta.name || file.replace(/\.md$/, ""),
          description: meta.description || "",
          type: meta.type || "unknown",
          body,
          nodeType: "memory",
          modifiedAt: stat.mtime.toISOString(),
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

      // Name reference in body
      if (
        a.body.toLowerCase().includes(b.name.toLowerCase()) ||
        b.body.toLowerCase().includes(a.name.toLowerCase())
      ) {
        weight += 0.8;
      }

      // Shared keywords (words > 6 chars)
      const wordsA = new Set(
        a.body
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 6)
      );
      const wordsB = new Set(
        b.body
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 6)
      );
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
    const oneHour = 3600000;
    const msgLower = (conv.firstMessage || "").toLowerCase();
    const msgWords = new Set(
      msgLower.split(/\W+/).filter((w) => w.length > 6)
    );

    for (const mem of memories) {
      let weight = 0;

      // Same project
      if (conv.project === mem.project) weight += 0.4;

      // Temporal overlap: memory modifiedAt within conv timeframe ± 1hr
      const memTime = new Date(mem.modifiedAt).getTime();
      if (convStart && convEnd && memTime >= convStart - oneHour && memTime <= convEnd + oneHour) {
        weight += 0.3;
      }

      // Memory name appears in first message
      if (msgLower && mem.name && msgLower.includes(mem.name.toLowerCase())) {
        weight += 0.5;
      }

      // Shared keywords between firstMessage and memory body
      if (msgWords.size > 0) {
        const bodyWords = new Set(
          (mem.body || "").toLowerCase().split(/\W+/).filter((w) => w.length > 6)
        );
        let shared = 0;
        for (const w of msgWords) {
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

  // Conversation ↔ Conversation edges
  for (let i = 0; i < conversations.length; i++) {
    for (let j = i + 1; j < conversations.length; j++) {
      const a = conversations[i];
      const b = conversations[j];
      let weight = 0;

      // Same project
      if (a.project === b.project) {
        weight += 0.15;

        // Temporal proximity: same project, within 24hrs
        const aEnd = a.endedAt ? new Date(a.endedAt).getTime() : 0;
        const bStart = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        const bEnd = b.endedAt ? new Date(b.endedAt).getTime() : 0;
        const aStart = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const gap = Math.min(
          Math.abs(aEnd - bStart),
          Math.abs(bEnd - aStart)
        );
        if (gap < 86400000) weight += 0.25;
      }

      if (weight >= 0.2) {
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

    // Inject graph data (strip heavy fields from client payload — served on demand via API)
    const clientData = {
      nodes: graphData.nodes.map(({ _filePath, body, firstMessage, summary, ...rest }) => rest),
      edges: graphData.edges,
    };
    html = html.replace(
      "/*__GRAPH_DATA__*/",
      `window.__GRAPH_DATA__ = ${JSON.stringify(clientData)};`
    );

    const server = http.createServer((req, res) => {
      resetIdleTimer();
      const url = new URL(req.url, "http://localhost");

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

      const allNodes = [...enrichedMemNodes, ...convNodes];
      const allEdges = [...memEdges, ...brainEdges];

      // Add cross-reference edges
      const nodeIdByKey = {};
      for (const mem of memories) nodeIdByKey[mem.path] = mem.id;
      for (const conv of convs) nodeIdByKey[conv.sessionId] = conv.id;

      for (const [key, entry] of Object.entries(brainIndex.memories)) {
        if (entry.crossRefs && nodeIdByKey[key]) {
          for (const ref of entry.crossRefs) {
            if (nodeIdByKey[ref]) {
              allEdges.push({ source: nodeIdByKey[key], target: nodeIdByKey[ref], weight: 1.0, edgeType: "cross-ref" });
            }
          }
        }
      }
      for (const [key, entry] of Object.entries(brainIndex.conversations)) {
        if (entry.crossRefs && nodeIdByKey[key]) {
          for (const ref of entry.crossRefs) {
            if (nodeIdByKey[ref]) {
              allEdges.push({ source: nodeIdByKey[key], target: nodeIdByKey[ref], weight: 1.0, edgeType: "cross-ref" });
            }
          }
        }
      }

      return {
        nodes: allNodes,
        edges: allEdges,
        totalMemories: enrichedMemNodes.length,
        totalConversations: convNodes.length,
        totalEdges: allEdges.length,
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

      const allNodes = [...enrichedMemories, ...convNodes];
      const allEdges = [...memEdges, ...brainEdges];

      // Add cross-reference edges
      const nodeIdByKey = {};
      for (const mem of memories) nodeIdByKey[mem.path] = mem.id;
      for (const conv of convs) nodeIdByKey[conv.sessionId] = conv.id;

      for (const [key, entry] of Object.entries(brainIndex.memories)) {
        if (entry.crossRefs && nodeIdByKey[key]) {
          for (const ref of entry.crossRefs) {
            if (nodeIdByKey[ref]) {
              allEdges.push({ source: nodeIdByKey[key], target: nodeIdByKey[ref], weight: 1.0, edgeType: "cross-ref" });
            }
          }
        }
      }
      for (const [key, entry] of Object.entries(brainIndex.conversations)) {
        if (entry.crossRefs && nodeIdByKey[key]) {
          for (const ref of entry.crossRefs) {
            if (nodeIdByKey[ref]) {
              allEdges.push({ source: nodeIdByKey[key], target: nodeIdByKey[ref], weight: 1.0, edgeType: "cross-ref" });
            }
          }
        }
      }

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
        totalEdges: allEdges.length,
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
