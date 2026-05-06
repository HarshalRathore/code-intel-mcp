# code-intel-mcp

Code Intelligence MCP Server — **ts-morph (TypeScript Compiler API) + ArangoDB** powered code analysis for AI agents.

20 tools for deep code understanding: symbol search, call graphs, impact analysis, React component trees, hook tracking, and more. Designed for use with Claude Code, Cursor, OpenCode, pi, or any MCP-compatible AI agent.

## Why code-intel-mcp?

| Capability | grep/ripgrep | AST tools | **code-intel-mcp** |
|---|---|---|---|
| Find symbol by name | partial | exact | **exact + fuzzy** |
| Call graph (who calls X?) | no | single file | **multi-file, transitive** |
| Impact analysis (what breaks if X changes?) | no | no | **yes — transitive blast radius** |
| React component tree | no | partial | **JSX-aware** |
| Hook usage tracking | no | no | **yes — who uses useAuth?** |
| Cross-file call chain A→B | no | no | **pathfinding via ArangoDB** |
| Auto incremental indexing | N/A | N/A | **chokidar + ts-morph — 200ms** |
| No JVM / No Docker | N/A | N/A | **pure Node.js** |

## Quick Start

### Prerequisites

- **Node.js** 18+
- **ArangoDB** — local or remote ([Docker](https://hub.docker.com/_/arangodb) / [Cloud](https://cloud.arangodb.com/))

### Setup ArangoDB

```bash
# Docker (quickest)
docker run -d --name arangodb -p 8529:8529 -e ARANGO_ROOT_PASSWORD=code_intel_dev arangodb/arangodb

# Or use docker-compose from the project
docker compose up -d arangodb
```

### Install

**From npm (recommended, no clone needed):**

```bash
npm install -g code-intel-mcp
```

**Or clone from source:**

```bash
git clone https://github.com/HarshalRathore/code-intel-mcp.git
cd code-intel-mcp
npm install
npm run build
```

### Add to MCP Client

```json
{
  "mcpServers": {
    "code-intel": {
      "command": "node",
      "args": ["/usr/lib/node_modules/code-intel-mcp/dist/index.js"],
      "env": {
        "ARANGO_HOST": "http://localhost:8529",
        "ARANGO_USER": "root",
        "ARANGO_PASS": "code_intel_dev",
        "ARANGO_DB": "code_intel"
      }
    }
  }
}
```

## Auto-Setup with AI Agent (Recommended)

Want an AI agent to set this up for you end-to-end? Copy the prompt from [`SETUP_PROMPT.md`](./SETUP_PROMPT.md) and paste it into Claude Code, Codex, pi, OpenCode, or Cursor.

```bash
# macOS
cat $(npm root -g)/code-intel-mcp/SETUP_PROMPT.md | pbcopy

# Linux
cat $(npm root -g)/code-intel-mcp/SETUP_PROMPT.md | xclip

# Or read it directly
cat $(npm root -g)/code-intel-mcp/SETUP_PROMPT.md
```

The prompt covers: prerequisite checks, npm install, ArangoDB setup, environment config, project indexing, watcher setup, MCP client configs for all major agents, verification, and troubleshooting — all in one shot.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ARANGO_HOST` | `http://localhost:8529` | ArangoDB host URL |
| `ARANGO_USER` | `root` | ArangoDB username |
| `ARANGO_PASS` | *(empty)* | ArangoDB password |
| `ARANGO_DB` | `code_intel` | ArangoDB database name |
| `STREAMABLE_HTTP_PORT` | *(empty)* | Set to `3001` for HTTP mode instead of stdio |

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────┐
│  AI Agent       │────▶│  MCP Server  │────▶│  ArangoDB   │
│  (Claude, pi)   │     │  (Node.js)   │     │  (Graph DB) │
└─────────────────┘     └──────┬───────┘     └──────▲──────┘
                               │                    │
                        ┌──────▼───────┐            │
                        │  ts-morph     │────────────┘
                        │  (Parser)     │  Upsert nodes
                        └──────┬───────┘  + edges
                               │
                        ┌──────▼───────┐
                        │  chokidar    │
                        │  (Watcher)   │
                        └──────────────┘
```

### How It Works

1. **ts-morph** (TypeScript Compiler API) parses `.ts`, `.tsx`, `.js`, `.jsx` files directly — no transpilation needed
2. Function/class declarations are extracted from the AST and stored as **nodes** in ArangoDB
3. Call expressions are resolved via TypeScript's **type checker** and stored as **edges** (call graph)
4. **chokidar** watches source directories — file changes trigger automatic re-indexing after a 2-second debounce
5. A **manifest SHA256 diff** runs before every query as a safety net, catching any changes the watcher might have missed
6. **ArangoDB** stores the graph — all query tools (`symbol_search`, `get_callers`, etc.) read from ArangoDB

### Key Design Decisions

| Decision | Why |
|----------|-----|
| **ts-morph instead of Joern** | No JVM, no 83s full reparse, no silent file drops. Incremental per-file parsing in ~200ms. Native TypeScript support without transpilation. |
| **ArangoDB for storage** | Graph-native queries (traversals, multi-hop paths). Persistent across restarts. Query cache with 5-minute TTL. |
| **In-process watcher** | chokidar runs inside the MCP server process — no daemon, no IPC, no Unix sockets, no orphaned state. Crash recovery is automatic. |
| **Full-project reparse for edge recompute** | Type checker needs full program context for accurate call resolution. ~8s for 374 files. |
| **Manifest safety net** | SHA256 comparison before each query catches missed watcher events. |

## Tools Reference

### Project Lifecycle

| Tool | Description | Use When |
|---|---|---|
| `index_project` | Full index of a project — parses all files, extracts methods + edges | First time setup |
| `project_status` | Check index health — node/edge/file counts | Before any query to verify freshness |
| `watch_project` | Start chokidar watcher for auto incremental indexing | After indexing — enables live updates |
| `unwatch_project` | Stop watching a project | No longer need live updates |
| `watcher_status` | Check watcher health — which projects are watched | Debugging incremental indexing |
| `trigger_reindex` | Force re-index (incremental or full `{full:true}`) | When watcher missed changes or to rebuild edges |
| `delete_project` | Remove all indexed data for a project | Cleanup |
| `list_projects` | List all indexed projects | Overview |

### Search & Discovery

| Tool | Description | Use When |
|---|---|---|
| `symbol_search` | Find any function/class by name (partial match, file:line) | You know or partially know a symbol name |
| `find_usages` | Text-based semantic search — calls, imports, references | "Where is X used?" — fastest option |
| `get_code_context` | NL task → ranked entry points + related files | Starting a new task — orient before coding |
| `list_files` | List indexed files with method counts | Explore project structure |

### Call Graph

| Tool | Description | Use When |
|---|---|---|
| `get_callers` | Who calls X? (depth 1–5, transitive) | "Who calls this function?" |
| `get_callees` | What does X call? (depth 1–5, transitive) | "What does this function depend on?" |
| `get_call_chain` | Pathfinding: how does A reach B? | Execution trace between two functions |

### Analysis

| Tool | Description | Use When |
|---|---|---|
| `get_impact_analysis` | Blast radius — direct + transitive callers/callees | Before modifying shared code |
| `get_react_components` | React component tree — PascalCase names + callees | Navigating a React/Next.js codebase |
| `get_hook_usage` | Hook adoption — who uses `useAuth`, `useState`, etc. | Understanding hook propagation |

### Debug

| Tool | Description | Use When |
|---|---|---|
| `cache_stats` | Query cache hit rate/size | Debugging slow queries |
| `list_projects` | All indexed projects with stats | Overview |

### Quick Reference

```
New task?              → get_code_context
"Where is X used?"     → find_usages
"Who calls X?"         → get_callers (depth=1 first)
"What does X call?"    → get_callees (depth=1 first)
"How does A→B?"        → get_call_chain
"What breaks if X?"    → get_impact_analysis
"React components?"    → get_react_components
"Hook usage?"          → get_hook_usage
"First time setup?"    → index_project → watch_project
"Is project indexed?"  → project_status
```

## Auto Incremental Indexing

code-intel-mcp automatically detects file changes and re-indexes them incrementally:

```
✏️ You edit a file
  │
  ▼ 2s debounce (batches rapid consecutive edits)
🔄 ts-morph parses only the changed file(s) (~50–200ms)
  │
  ▼
📥 Type checker resolves call edges (~100–500ms)
  │
  ▼
🗄️ ArangoDB: delete old nodes + upsert new nodes + delete old edges + insert new edges
  │
  ▼
✅ Next query immediately finds new symbols + edges
```

### Performance

| Operation | Time |
|---|---|
| Index 1 new file (methods only) | ~50ms |
| Index 4 new files (methods only) | ~230ms |
| Index 1 changed file + recompute edges | ~1–5s |
| Full edge recompute (374 files, 2800+ edges) | ~8s |
| File deletion cleanup | ~240ms |
| Server startup + project load | ~5–10s |

### Safeguards

| Mechanism | Purpose |
|---|---|
| **2s debounce** | Batches rapid consecutive edits into one reindex |
| **`batch.reindexing` lock** | Skips flush while a reindex is already running; edits queue up |
| **`reindexingAliases` set** | Queries return cached (stale) data instead of blocking |
| **`reindexMutex` (edge chain)** | Serializes edge writes to ArangoDB |
| **`Set` dedup** | Same file changed 100 times = 1 entry |
| **File refresh** | Changed files are re-read from disk via `refreshFromFileSystemSync()` |
| **Manifest safety net** | SHA256 comparison before each query catches watcher drift |
| **Graceful shutdown** | Pending dirty batch is flushed on SIGTERM |

## Streamable HTTP Mode (Daemon)

Instead of stdio, run as a persistent HTTP daemon:

```bash
# If installed from npm
STREAMABLE_HTTP_PORT=3001 code-intel-mcp

# If running from source
STREAMABLE_HTTP_PORT=3001 node dist/index.js
```

Then configure your MCP client as a remote server:

```json
{
  "mcpServers": {
    "code-intel": {
      "type": "remote",
      "url": "http://127.0.0.1:3001/mcp",
      "transport": "streamable_http"
    }
  }
}
```

This is useful when:
- You want the server to stay alive between agent sessions
- You use it with a gateway/proxy (like harshal-mcp-proxy)
- You need to share it across multiple clients

**Re-initialization:** When the client reconnects (e.g., after restating the gateway), the server detects the new `initialize` request, swaps the internal transport, and accepts the new session — no need to restart the daemon.

## Supported File Types

| Type | Status | Notes |
|------|--------|-------|
| `.ts` | ✅ Full support | TypeScript compiler API natively |
| `.tsx` | ✅ Full support | JSX, "use client", React components |
| `.js` | ✅ Full support | ES modules, CommonJS |
| `.jsx` | ✅ Full support | JSX syntax |
| Nested functions | ✅ Full support | Arrow functions inside React components extracted as individual methods |

## Error Codes

| Error | Cause | Fix |
|---|---|---|
| `ArangoDB connection failed` | ArangoDB not running | `docker compose up -d arangodb` |
| `Session not found` | Client session expired after server restart | Reconnect (re-initialize) |
| `Server already initialized` | Re-initialize request while server already active | **Auto-fixed** — transport swap handles this |
| `Project not found` | `projectPath` never indexed | Run `index_project` first |
| `Project not being watched` | Watcher not started | Run `watch_project` after indexing |

## Supported Languages

code-intel-mcp uses the TypeScript compiler API and supports any language it can parse:

| Language | Status | Notes |
|---|---|---|
| TypeScript | ✅ Full | Native AST parsing, type-checked call resolution |
| JavaScript | ✅ Full | ES modules + CommonJS |
| JSX / TSX | ✅ Full | React components, JSX syntax |

For non-JS/TS languages, consider tools like [CodeGraph](https://github.com/opencode-ai/codegraph) which provide similar MCP tools for Java, Python, Go, etc.

## Comparison with Alternatives

| Feature | code-intel-mcp | CodeGraph | Joern | LSP |
|---|---|---|---|---|
| Cross-file call graph | ✅ | ✅ | ✅ | limited |
| Transitive callers (depth>1) | ✅ | ✅ | ✅ | no |
| Impact analysis | ✅ | limited | ✅ | no |
| React JSX awareness | ✅ | no | partial | ✅ |
| Hook usage tracking | ✅ | no | no | no |
| Call chain pathfinding | ✅ | no | ✅ | no |
| Auto incremental indexing | ✅ (chokidar + ts-morph) | no | no | live |
| No JVM / No transpilation | ✅ pure Node.js | ❌ Go binary | ❌ JVM + Scala | varies |
| Index time (374 files) | **~8s** (full) / **~200ms** (incr) | varies | **~83s** (full) | N/A |
| Memory per index | ~150MB | ~200MB | ~1GB | ~500MB |
| Startup time | ~1s | ~0.5s | ~30s (JVM) | ~5s |
| MCP protocol | ✅ | ✅ | ❌ (library) | ❌ |

## Local Development

For contributing or hacking on code-intel-mcp itself:

```bash
git clone https://github.com/HarshalRathore/code-intel-mcp.git
cd code-intel-mcp

# Install dependencies
npm run build

# Start ArangoDB
docker compose up -d arangodb

# Run in dev mode
npm run dev

# Or with HTTP mode
STREAMABLE_HTTP_PORT=3001 npm run dev
```

## License

MIT
