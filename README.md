# code-intel-mcp

Code Intelligence MCP Server — **Joern CPG + ArangoDB** powered code analysis for AI agents.

14 tools for deep code understanding: symbol search, call graphs, data flow tracking, impact analysis, React component trees, and more. Designed for use with Claude Code, Cursor, OpenCode, or any MCP-compatible AI agent.

## Why code-intel-mcp?

| Capability | grep/ripgrep | AST tools | **code-intel-mcp** |
|---|---|---|---|
| Find symbol by name | partial | exact | **exact + fuzzy** |
| Call graph (who calls X?) | no | single file | **multi-file, transitive** |
| Data flow (where does this var go?) | no | no | **yes — taint tracking** |
| Impact analysis (what breaks if X changes?) | no | no | **yes — transitive blast radius** |
| React component tree | no | partial | **JSX-aware** |
| Cross-file call chain A→B | no | no | **pathfinding** |
| Incremental re-indexing | N/A | N/A | **SHA256 diff — only changed files** |

## Quick Start

### Option 1: Docker (recommended)

Everything in one container — Joern, ArangoDB, and the MCP server:

```bash
docker compose up -d
```

Then add to your MCP client config:

```json
{
  "mcpServers": {
    "code-intel": {
      "command": "docker",
      "args": ["exec", "-i", "code-intel-mcp", "node", "dist/index.js"],
      "env": {}
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `JOERN_CLI_PATH` | `/opt/joern/joern-cli` | Path to Joern CLI installation |
| `ARANGO_HOST` | `http://localhost:8529` | ArangoDB host URL |
| `ARANGO_USER` | `root` | ArangoDB username |
| `ARANGO_PASS` | *(empty)* | ArangoDB password |
| `ARANGO_DB` | `code_intel` | ArangoDB database name |

Copy `.env.example` to `.env` and fill in your values.

## Tools Reference

### Indexing

| Tool | Use When | Don't Use When |
|---|---|---|
| `index_project` | First time setup or after code changes | No files changed (check `project_status` first) |
| `project_status` | Before any query to verify index exists | You just indexed and know it's current |
| `list_files` | Verify what's indexed or explore file structure | Searching for a specific symbol (use `symbol_search`) |
| `cache_stats` | Debugging query performance | Routine use |

### Search & Discovery

| Tool | Use When | Don't Use When |
|---|---|---|
| `symbol_search` | You know or partially know a symbol name | You already have the exact name from prior search |
| `find_usages` | "Where is X used?" — calls, imports, references | You need call graph depth traversal (use `get_callers`) |
| `get_code_context` | Starting a new task — orient before diving in | You already know which files matter |

### Call Graph

| Tool | Use When | Don't Use When |
|---|---|---|
| `get_callers` | "Who calls X?" with depth traversal needed | Simple "where is X used?" (use `find_usages` — faster) |
| `get_callees` | "What does X call?" with depth traversal | React component children (use `get_react_components`) |
| `get_call_chain` | "How does A reach B?" — specific path | Open-ended exploration (use `get_callers` depth>1) |

### Analysis

| Tool | Use When | Don't Use When |
|---|---|---|
| `get_data_flow` | Security/taint tracking, variable propagation | Simple "where is X set?" (use `find_usages`) |
| `get_impact_analysis` | Before modifying shared code — blast radius | Single-file changes or you already know dependents |
| `get_react_components` | React/Next.js component tree exploration | Non-React projects (use `get_callees` instead) |
| `get_hook_usage` | React hook adoption patterns (who uses `useAuth`?) | Non-hook searches (use `symbol_search`) |

**`get_data_flow` params:** `{ sourceName: string, functionName: string, projectPath: string, direction?: "forward" | "backward" | "both" }`
  - `sourceName` — variable or parameter to trace
  - `functionName` — function containing that variable (required)
  - `direction` — `forward` (where data goes), `backward` (where it comes from), `both` (default: `forward`)

### Quick Reference

```
New task?           → get_code_context
"Where is X used?"  → find_usages
"Who calls X?"      → get_callers (depth=1 first)
"What does X call?" → get_callees (depth=1 first)
"How does A→B?"     → get_call_chain
"Where does data flow?" → get_data_flow
"What breaks if X?" → get_impact_analysis
"React components?" → get_react_components
"Hook usage?"       → get_hook_usage
"Is project indexed?" → project_status
"Re-index needed?"  → index_project (only if files changed)
```

## Error Codes

All tools return structured error responses. `isError: true` in the response means the tool failed — check `content[0].text` for the message.

| Error Message | Cause | Fix |
|---|---|---|
| `ArangoDB connection failed: not authorized` | Wrong `ARANGO_USER` or `ARANGO_PASS` | Check your env vars or `.env` file |
| `ArangoDB connection failed: getaddrinfo EAI_AGAIN` | ArangoDB not reachable | Ensure ArangoDB is running: `docker compose up -d arangodb` |
| `Joern not found` | `JOERN_CLI_PATH` is wrong or Joern not installed | Run `npx code-intel-mcp setup` or set `JOERN_CLI_PATH` |
| `Failed to extract methods from CPG` | Joern failed to parse source file(s) | Check that source files are valid JS/TS/JSX/TSX and Joern supports the language |
| `project not indexed` | `projectPath` has never been indexed | Run `index_project` first |
| `No files found` | `globPattern` matched nothing | Check the glob pattern and that project path is correct |
| `Cache error` | ArangoDB returned partial results | Query was served from cache but may be stale — re-index if needed |
| `TypeError: Cannot read properties of undefined` | Symbol not found in graph | The symbol may not have been indexed (non-method code, runtime-generated functions) |
| `Error listing projects: ArangoDB connection failed` | ArangoDB unreachable | Same as connection errors above |
| `Error deleting project: not authorized` | Wrong credentials | Check `ARANGO_USER` / `ARANGO_PASS` |

**MCP protocol errors:** If you see `method not found`, the server version doesn't support that tool — update `code-intel-mcp`.

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────┐
│  AI Agent       │────▶│  MCP Server  │────▶│  ArangoDB   │
│  (Claude/Cursor)│     │  (Node.js)   │     │  (Graph DB) │
└─────────────────┘     └──────┬───────┘     └──────▲──────┘
                               │                    │
                        ┌──────▼───────┐            │
                        │  Joern CPG   │────────────┘
                        │  (Parser)    │  Import CPG
                        └──────────────┘
```

1. **Joern** parses source code into a Code Property Graph (CPG) — nodes (functions, classes, variables) and edges (calls, imports, data flow)
2. **ArangoDB** stores the CPG as a queryable graph database with indexed collections
3. **MCP Server** exposes 14 tools over the Model Context Protocol for AI agents to query the graph

### Supported Languages

| Language | Joern Frontend | Notes |
|---|---|---|
| JavaScript | `jssrc` | Default — includes JSX/TSX via Babel transpilation |
| TypeScript | `jssrc` | Auto-transpiled before parsing |
| Java | `java` | Full support |
| Python | `python` | Full support |
| C/C++ | `c` / `cpp` | Full support |
| C# | `csharp` | Full support |
| Kotlin | `kotlin` | Full support |
| PHP | `php` | Full support |
| Ruby | `rubysrc` | Full support |
| Swift | `swiftsrc` | Full support |
| Go | `gosrc` | Full support |

## Docker Details

### All-in-one (recommended)

```bash
# Build and start everything
docker compose up -d

# Index a project (mount it in docker-compose volumes first)
docker exec code-intel-mcp node dist/index.js --index /projects/my-project

# View logs
docker logs code-intel-mcp
```

### Separate ArangoDB (if you already have one)

```bash
# Use external ArangoDB
docker run -d \
  -e JOERN_CLI_PATH=/opt/joern/joern-cli \
  -e ARANGO_HOST=https://your-arango.cloud:8529 \
  -e ARANGO_USER=root \
  -e ARANGO_PASS=your-password \
  -e ARANGO_DB=code_intel \
  -v /path/to/your/project:/projects:ro \
  code-intel-mcp
```

## Local Development

```bash
# Clone
git clone https://github.com/HarshalRathore/code-intel-mcp.git
cd code-intel-mcp

# Install dependencies
npm install

# Build
npm run build

# Start ArangoDB
docker compose up -d arangodb

# Setup ArangoDB collections
bash setup-arangodb.sh

# Run the server
npm start

# Or in dev mode
npm run dev
```

## Comparison with Alternatives

| Feature | code-intel-mcp | CodeGraph | AST grep | LSP |
|---|---|---|---|---|
| Cross-file call graph | yes | yes | no | limited |
| Transitive callers (depth>1) | yes | yes | no | no |
| Data flow / taint tracking | yes | no | no | limited |
| Impact analysis | yes | limited | no | no |
| React JSX awareness | yes | no | partial | yes |
| Hook usage tracking | yes | no | no | no |
| Call chain pathfinding | yes | no | no | no |
| Incremental re-indexing | yes (SHA256) | no | N/A | live |
| Persistent graph storage | ArangoDB | SQLite | N/A | memory |
| MCP protocol | yes | yes | no | no |

## License

MIT