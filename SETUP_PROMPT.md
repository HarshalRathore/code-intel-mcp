# Auto-Setup Prompt for code-intel-mcp

Copy the entire content below and paste it into your AI coding agent (Claude Code, Codex, pi, opencode, Cursor, etc.) to automatically set up and configure code-intel-mcp on your machine.

---

````
You are setting up code-intel-mcp — a Code Intelligence MCP Server that provides deep code analysis tools (symbol search, call graphs, impact analysis, React component trees, data flow tracking) powered by ts-morph + ArangoDB.

## Goal

Install and configure code-intel-mcp so the user's AI coding agent can query their codebase intelligently — finding symbols, tracing call chains, analyzing impact, and navigating React components without grep or manual file reading.

## Prerequisites Check

Before proceeding, verify these are available:

```bash
# Node.js 18+
node --version

# Docker (for ArangoDB)
docker --version
```

If Node.js is missing, install it first (https://nodejs.org/ or `nvm install 20`).
If Docker is missing, the user needs to install Docker Desktop or Docker Engine.

## Steps

### Step 1: Install code-intel-mcp

```bash
npm install -g code-intel-mcp
```

Verify the binary is available:
```bash
code-intel-mcp --version 2>/dev/null || echo "Binary not in PATH — check npm global bin directory"
```

### Step 2: Start ArangoDB

ArangoDB is required for storing the code graph. Use Docker (quickest):

```bash
# Run ArangoDB in Docker
docker run -d --name arangodb-codeintel \
  -p 8529:8529 \
  -e ARANGO_ROOT_PASSWORD=code_intel_dev \
  arangodb/arangodb

# Wait a few seconds for it to start
sleep 3

# Verify it's running
curl -s http://localhost:8529/_api/version | head -1
```

If the user already has ArangoDB running elsewhere, skip Docker and note the host/port/credentials for Step 3.

### Step 3: Configure environment

Set environment variables for the MCP server to connect to ArangoDB. Add these to the user's shell profile (`~/.bashrc`, `~/.zshrc`, or `~/.profile`):

```bash
cat >> ~/.bashrc << 'EOF'
# code-intel-mcp ArangoDB config
export ARANGO_HOST="http://localhost:8529"
export ARANGO_USER="root"
export ARANGO_PASS="code_intel_dev"
export ARANGO_DB="code_intel"
EOF
```

Also export them for the current session:
```bash
export ARANGO_HOST="http://localhost:8529"
export ARANGO_USER="root"
export ARANGO_PASS="code_intel_dev"
export ARANGO_DB="code_intel"
```

### Step 4: Index a project

The user needs to index at least one project before querying. Ask the user which project directory to index, or default to the current working directory.

```bash
# Detect current project or ask user
PROJECT_PATH="${PROJECT_PATH:-$(pwd)}"
echo "Indexing project: $PROJECT_PATH"

# Index the project (methods + edges)
code-intel-mcp --index-only "$PROJECT_PATH"
```

**Note:** Full indexing (methods + edges) takes ~8s for 374 files. If only methods are needed, it's faster. The user can also skip edge indexing initially and add it later.

### Step 5: Start the watcher (optional but recommended)

Enable auto-incremental indexing so file changes are detected automatically:

```bash
# Start the watcher for the project
code-intel-mcp --watch "$PROJECT_PATH"
```

Or if running as an MCP server (stdio mode), the watcher is started via the `watch_project` tool after initialization.

### Step 6: Configure the MCP client

**For pi:**

Create or update `~/.pi/agent/mcp.json` (global) or `<project>/.pi/mcp.json` (project-level):

```json
{
  "mcpServers": {
    "code-intel": {
      "command": "code-intel-mcp",
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

**For VS Code:**

Update `<project>/.vscode/mcp.json` (project-level) or `~/.config/Code/User/mcp.json` (global):

```json
{
  "servers": {
    "code-intel": {
      "type": "stdio",
      "command": "code-intel-mcp",
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

**For OpenCode:**

Update `opencode.json`:

```jsonc
{
  "mcp": {
    "code-intel": {
      "type": "local",
      "command": ["code-intel-mcp"],
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

**For Claude Code / Codex:**

Add to `.claude/mcp.json` (project-level) or `~/.claude/mcp.json` (global):

```json
{
  "mcpServers": {
    "code-intel": {
      "command": "code-intel-mcp",
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

**For Cursor:**

Cursor's MCP support varies. If Cursor supports stdio MCP servers, use the same config as VS Code. Otherwise, run in HTTP mode (see Step 7).

Then reload the MCP client:
- pi: `/mcp reconnect` or restart
- VS Code: restart or reload MCP extension
- Claude Code: restart the session
- OpenCode: restart

### Step 7: HTTP Daemon Mode (optional — for gateway/proxy use)

If the user uses harshal-mcp-proxy or wants multiple clients to share one code-intel-mcp instance:

```bash
# Start in HTTP mode
STREAMABLE_HTTP_PORT=3001 code-intel-mcp
```

Then configure the client as remote:

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

### Step 8: Verify everything works

```bash
# Check ArangoDB is reachable
curl -s -u root:code_intel_dev http://localhost:8529/_api/database | head -1

# Check code-intel-mcp binary
code-intel-mcp --version 2>/dev/null || which code-intel-mcp

# Test a quick project status query (requires the server to be running)
# If running in stdio mode, use the client's MCP tool instead:
#   project_status { projectPath: "/path/to/project" }
```

## Verification Checklist

- [ ] `node --version` returns 18+
- [ ] `docker ps` shows `arangodb-codeintel` running
- [ ] `curl http://localhost:8529/_api/version` returns ArangoDB version
- [ ] `code-intel-mcp` binary is in PATH
- [ ] `~/.bashrc` (or equivalent) has ARANGO_* exports
- [ ] At least one project has been indexed
- [ ] MCP client config has the code-intel server entry
- [ ] MCP client reload/restart completed successfully
- [ ] `project_status` tool returns node/edge counts for the indexed project

## Quick Reference for the User

Once set up, the AI agent can use these tools:

```
New task?              → get_code_context
"Where is X used?"     → find_usages
"Who calls X?"         → get_callers (depth=1 first)
"What does X call?"    → get_callees (depth=1 first)
"How does A→B?"        → get_call_chain
"What breaks if X?"    → get_impact_analysis
"React components?"    → get_react_components
"Hook usage?"          → get_hook_usage
```

## Troubleshooting

- **"ArangoDB connection failed"**: ArangoDB is not running. Run `docker start arangodb-codeintel` or recreate the container.
- **"Project not found"**: The project hasn't been indexed yet. Run `index_project { projectPath: "/path/to/project" }` via the MCP tool.
- **"Binary not found"**: npm global bin directory is not in PATH. Add `export PATH="$PATH:$(npm bin -g)"` to shell profile.
- **"Session not found"**: The MCP server restarted. The client should auto-reconnect. If not, restart the client.
- **Slow queries**: The query cache warms up over time. First query on a new project may take 1-2s.
- **File changes not reflected**: Ensure the watcher is started via `watch_project` tool, or run `trigger_reindex` manually.

## Next Steps for the User

After setup is complete, tell the user:

1. **Index additional projects** by calling the `index_project` MCP tool with different `projectPath` values.
2. **Start the watcher** for live incremental updates: `watch_project { projectPath: "/path/to/project" }`.
3. **Explore their code** using the tools above — the agent now has deep code intelligence instead of grep.
````
