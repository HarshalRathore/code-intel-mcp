import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JoernClient } from "./joern-client.js";
import { ArangoClient } from "./arango-client.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { computeManifestHashes, diffManifests, loadManifest, saveManifest } from "./manifest.js";
import type { FileManifest } from "./manifest.js";
import { findUsages } from "./usage-finder.js";
import { getCodeContext } from "./code-context.js";
import { LiveWatcher } from "./watcher/live-watcher.js";

const JOERN_CLI_PATH = process.env.JOERN_CLI_PATH || "/opt/joern/joern-cli";
const ARANGO_HOST = process.env.ARANGO_HOST || "http://localhost:8529";
const ARANGO_USER = process.env.ARANGO_USER || "root";
const ARANGO_PASS = process.env.ARANGO_PASS || "";
const ARANGO_DB = process.env.ARANGO_DB || "code_intel";
const STREAMABLE_HTTP_PORT = parseInt(process.env.STREAMABLE_HTTP_PORT || "0", 10);
const HTTP_MODE = STREAMABLE_HTTP_PORT > 0;

if (!process.env.JOERN_CLI_PATH && !existsSync(JOERN_CLI_PATH)) {
  console.error([
    "code-intel-mcp: Joern CLI not found.",
    "",
    "Set JOERN_CLI_PATH or install Joern to /opt/joern/joern-cli",
    "Quick install: npx code-intel-mcp setup",
    "Or download from: https://github.com/joernio/joern/releases",
  ].join("\n"));
  process.exit(1);
}

async function checkArangoConnection(): Promise<void> {
  try {
    const arango = new ArangoClient(ARANGO_HOST, ARANGO_USER, ARANGO_PASS, ARANGO_DB);
    await arango.getProjectStatus("/__health_check__");
  } catch (error: any) {
    if (error?.statusCode === 401) {
      console.error("code-intel-mcp: ArangoDB authentication failed. Check ARANGO_USER and ARANGO_PASS.");
      process.exit(1);
    }
  }
}

const server = new McpServer({
  name: "code-intel-mcp",
  version: "0.2.0",
});

const InitializedNotificationSchema = z.object({
  method: z.literal("notifications/initialized"),
  params: z.optional(z.object({})).default({}),
});
server.server.setNotificationHandler(InitializedNotificationSchema, async () => {});

const joern = new JoernClient(JOERN_CLI_PATH);
const arango = new ArangoClient(ARANGO_HOST, ARANGO_USER, ARANGO_PASS, ARANGO_DB);
const liveWatcher = new LiveWatcher(JOERN_CLI_PATH);

async function ensureFreshBeforeQuery(projectPath: string): Promise<void> {
  const projectList = liveWatcher.getProjectList();
  const match = projectList.find(p => p.projectPath === projectPath || p.alias === projectPath.split("/").pop());
  if (match) {
    await liveWatcher.ensureFresh(match.alias);
  }
}

server.tool(
  "symbol_search",
  "grep -r 'functionName' src/ → USE THIS INSTEAD. Find any function, class, method, or variable by name (partial match, exact file:line location).",
  {
    query: z.string().describe("Symbol name to search for (supports partial match)"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    nodeType: z.enum(["METHOD", "CLASS", "MEMBER", "ALL"]).default("ALL").describe("Type of symbol to search for"),
  },
  async ({ query, projectPath, nodeType }) => {
    try {
      await ensureFreshBeforeQuery(projectPath);
      const results = await arango.searchSymbols(query, nodeType, projectPath);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error searching symbols: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "get_callers",
  "grep -rn 'functionName(' src/ → USE THIS INSTEAD. Shows every caller of a function up to N levels deep — follows the full call chain, not just string matches.",
  {
    functionName: z.string().describe("Name of the function to find callers for"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    depth: z.number().min(1).max(5).default(1).describe("How many levels deep to trace (1=direct callers only)"),
  },
  async ({ functionName, projectPath, depth }) => {
    try {
      await ensureFreshBeforeQuery(projectPath);
      const results = await arango.getCallers(functionName, projectPath, depth);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error finding callers: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "get_callees",
  "grep -A 50 'function login(' src/ → USE THIS INSTEAD. Shows everything a function calls across the whole dependency tree. For React components, use get_react_components instead.",
  {
    functionName: z.string().describe("Name of the function to find callees for"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    depth: z.number().min(1).max(5).default(1).describe("How many levels deep to trace (1=direct callees only)"),
  },
  async ({ functionName, projectPath, depth }) => {
    try {
      await ensureFreshBeforeQuery(projectPath);
      const results = await arango.getCallees(functionName, projectPath, depth);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error finding callees: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "get_call_chain",
  "Trace the call path from function A to function B. Like running a debugger trace without running the code. Shows the exact execution route.",
  {
    fromFunction: z.string().describe("Starting function name"),
    toFunction: z.string().describe("Target function name"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    maxDepth: z.number().min(1).max(10).default(5).describe("Maximum traversal depth"),
  },
  async ({ fromFunction, toFunction, projectPath, maxDepth }) => {
    try {
      await ensureFreshBeforeQuery(projectPath);
      const results = await arango.getCallChain(fromFunction, toFunction, projectPath, maxDepth);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error tracing call chain: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "get_data_flow",
  "grep -rn 'userId' src/ → USE THIS INSTEAD for tracking data. Traces how a variable flows through the code — forward to sinks, backward to sources. Answers: where does this value come from and where does it end up?",
  {
    sourceName: z.string().describe("Variable or parameter name to trace data flow from"),
    functionName: z.string().describe("Function containing the source variable"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    direction: z.enum(["forward", "backward", "both"]).default("forward").describe("Direction of data flow trace"),
  },
  async ({ sourceName, functionName, projectPath, direction }) => {
    try {
      await ensureFreshBeforeQuery(projectPath);
      const results = await arango.getDataFlow(sourceName, functionName, projectPath, direction);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error tracing data flow: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "get_impact_analysis",
  "MUST RUN before changing shared code. grep -rn 'import.*foo' src/ → USE THIS INSTEAD. Shows blast radius — every file that breaks if this symbol changes, following imports and calls transitively.",
  {
    symbolName: z.string().describe("Name of the symbol to analyze impact for"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    symbolType: z.enum(["METHOD", "CLASS", "VARIABLE", "AUTO"]).default("AUTO").describe("Type of the symbol"),
    maxResults: z.number().min(1).max(200).default(50).describe("Maximum number of transitively affected results to return"),
  },
  async ({ symbolName, projectPath, symbolType, maxResults }) => {
    try {
      await ensureFreshBeforeQuery(projectPath);
      const results = await arango.getImpactAnalysis(symbolName, projectPath, symbolType, maxResults);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error analyzing impact: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "index_project",
  "REQUIRED FIRST — parse project code into the graph DB. Run once per project, then all query tools work. Incremental: only re-parses files with changed SHA256 hashes. Like 'git init' for code search.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    projectAlias: z.string().optional().describe("Human-readable name for the project (defaults to directory name)"),
    language: z.enum(["jssrc", "javascript", "java", "python", "c", "cpp", "csharp", "ghidra", "kotlin", "php", "rubysrc", "swiftsrc"]).default("jssrc").describe("Joern language frontend (use 'jssrc' for JS/TS projects)"),
    sourceDirs: z.array(z.string()).default(["src"]).describe("Source directories to include (relative to projectPath, e.g. ['src', 'lib'])"),
  },
  async ({ projectPath, projectAlias, language, sourceDirs }) => {
    try {
      const alias = projectAlias || projectPath.split("/").pop() || "unknown";
      const manifestDir = join(projectPath, ".code-intel");
      const manifestPath = join(manifestDir, "manifest.json");

      const currentHashes = computeManifestHashes(projectPath, sourceDirs);

      const existingManifest = loadManifest(manifestPath);

      if (existingManifest) {
        const diff = diffManifests(existingManifest.fileHashes, currentHashes);
        const hasChanges = diff.added.length > 0 || diff.modified.length > 0 || diff.deleted.length > 0;

        if (!hasChanges) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "unchanged",
                project: alias,
                path: projectPath,
                message: "No source file changes detected since last index",
                lastIndexedAt: existingManifest.indexedAt,
                totalNodes: existingManifest.totalNodes,
                totalEdges: existingManifest.totalEdges,
              }, null, 2),
            }],
          };
        }

        if (diff.deleted.length > 0) {
          await arango.deleteProjectFiles(alias, diff.deleted);
        }

        const parseResult = await joern.parseProject(projectPath, language, sourceDirs);
        const importResult = await arango.importCpg(parseResult.cpgBinPath, alias, projectPath, joern);

        const cpgBinHash = await joern.computeCpgBinHash(parseResult.cpgBinPath);
        const newManifest: FileManifest = {
          projectPath,
          projectAlias: alias,
          indexedAt: new Date().toISOString(),
          fileHashes: currentHashes,
          sourceDirs,
          language,
          totalNodes: importResult.nodeCount,
          totalEdges: importResult.edgeCount,
          cpgBinHash,
        };
        saveManifest(manifestPath, newManifest);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "incremental_update",
              project: alias,
              path: projectPath,
              changes: {
                addedFiles: diff.added.length,
                modifiedFiles: diff.modified.length,
                deletedFiles: diff.deleted.length,
                unchangedFiles: diff.unchanged.length,
              },
              nodes: importResult.nodeCount,
              edges: importResult.edgeCount,
            }, null, 2),
          }],
        };
      }

      if (!existsSync(manifestDir)) mkdirSync(manifestDir, { recursive: true });

      const parseResult = await joern.parseProject(projectPath, language, sourceDirs);
      const importResult = await arango.importCpg(parseResult.cpgBinPath, alias, projectPath, joern);

      const cpgBinHash = await joern.computeCpgBinHash(parseResult.cpgBinPath);
      const manifest: FileManifest = {
        projectPath,
        projectAlias: alias,
        indexedAt: new Date().toISOString(),
        fileHashes: currentHashes,
        sourceDirs,
        language,
        totalNodes: importResult.nodeCount,
        totalEdges: importResult.edgeCount,
        cpgBinHash,
      };
      saveManifest(manifestPath, manifest);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "full_index",
            project: alias,
            path: projectPath,
            language,
            nodes: importResult.nodeCount,
            edges: importResult.edgeCount,
            collections: importResult.collections,
          }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error indexing project: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "get_react_components",
  "grep -rn '<ComponentName' src/**/*.tsx → USE THIS INSTEAD. Find all React component definitions and what they render. get_callees misses JSX — this catches it.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    filePath: z.string().optional().describe("Optional: filter to a specific file path"),
  },
  async ({ projectPath, filePath }) => {
    try {
      await ensureFreshBeforeQuery(projectPath);
      const results = await arango.getReactComponents(projectPath, filePath);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error finding React components: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "get_hook_usage",
  "grep -rn 'useAuth' src/ → USE THIS INSTEAD. Find which components and functions use which React hooks — with full call context, not just string matches.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    hookName: z.string().optional().describe("Optional: specific hook name to search for (e.g. 'useAuth'). If omitted, finds all hooks (names starting with 'use')"),
  },
  async ({ projectPath, hookName }) => {
    try {
      await ensureFreshBeforeQuery(projectPath);
      const results = await arango.getHookUsage(projectPath, hookName);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error finding hook usage: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "cache_stats",
  "Check query cache hit rate and size. Only call when debugging slow queries — not needed for normal usage.",
  {},
  async () => {
    const stats = arango.getCacheStats();
    return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
  }
);

server.tool(
  "list_files",
  "find src/ -type f → USE THIS INSTEAD. List indexed source files with method counts. Like 'find' but each file shows how many functions/classes it contains.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    filePath: z.string().optional().describe("Optional: filter to files matching this path pattern"),
    limit: z.number().min(1).max(200).default(50).describe("Maximum number of files to return"),
  },
  async ({ projectPath, filePath, limit }) => {
    try {
      await ensureFreshBeforeQuery(projectPath);
      const results = await arango.listFiles(projectPath, filePath, limit);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error listing files: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "find_usages",
  "grep -rn 'symbolName' src/ → USE THIS INSTEAD. Finds every reference — calls, imports, definitions, type annotations — across your whole project. Not just string matches but semantic references.",
  {
    symbol: z.string().describe("Symbol name to find usages for (e.g. 'useAuth', 'LoginForm', 'generateTokens')"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    sourceDirs: z.array(z.string()).default(["src"]).describe("Source directories to search in"),
  },
  async ({ symbol, projectPath, sourceDirs }) => {
    try {
      const result = findUsages(projectPath, symbol, sourceDirs);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error finding usages: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "get_code_context",
  "Don't read 5 random files to figure out where to start. USE THIS INSTEAD. Give your task description, get back the most relevant files and entry points ranked by relevance.",
  {
    task: z.string().describe("Natural language description of the task (e.g. 'implement login form validation', 'fix payment processing bug')"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    maxEntryPoints: z.number().min(1).max(20).default(10).describe("Maximum number of entry points to return"),
    maxRelatedFiles: z.number().min(1).max(20).default(5).describe("Maximum number of related files to return"),
  },
  async ({ task, projectPath, maxEntryPoints, maxRelatedFiles }) => {
    try {
      await ensureFreshBeforeQuery(projectPath);
      const result = await getCodeContext(task, projectPath, arango, maxEntryPoints, maxRelatedFiles);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error building code context: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "project_status",
  "Check if a project is indexed and ready to query. Run this first before any code search — like 'ping' for the graph database.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  async ({ projectPath }) => {
    try {
      const result = await arango.getProjectStatus(projectPath);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error getting project status: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "list_projects",
  "List all projects currently indexed in the code intelligence database. Returns project paths, aliases, and basic stats.",
  {},
  async () => {
    try {
      const projects = await arango.listProjects();
      return { content: [{ type: "text" as const, text: JSON.stringify(projects, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error listing projects: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "delete_project",
  "Delete all indexed data for a project from the database. Use with caution — this removes all nodes and edges for the project and cannot be undone.",
  {
    projectAlias: z.string().describe("The project alias (slug) to delete, e.g. 'my-project' from an earlier index_project call"),
  },
  async ({ projectAlias }) => {
    try {
      liveWatcher.unwatchProject(projectAlias);
      const result = await arango.dropProject(projectAlias);
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...result }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error deleting project: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "watch_project",
  "Start watching a project for automatic incremental re-indexing. Uses in-process chokidar + manifest diff safety net. No daemon, no IPC — runs inside the MCP server.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    projectAlias: z.string().optional().describe("Human-readable alias (defaults to directory name)"),
    sourceDirs: z.array(z.string()).default(["src"]).describe("Source directories to watch (relative to projectPath)"),
    language: z.enum(["jssrc", "javascript", "java", "python", "c", "cpp", "csharp", "ghidra", "kotlin", "php", "rubysrc", "swiftsrc"]).default("jssrc").describe("Joern language frontend"),
  },
  async ({ projectPath, projectAlias, sourceDirs, language }) => {
    try {
      const alias = projectAlias || projectPath.split("/").pop() || "unknown";

      const manifestDir = join(projectPath, ".code-intel");
      const manifestPath = join(manifestDir, "manifest.json");
      if (!existsSync(manifestPath)) {
        return {
          content: [{ type: "text" as const, text: `Project '${alias}' must be indexed first (run index_project). Cannot watch an unindexed project.` }],
          isError: true,
        };
      }

      liveWatcher.watchProject(projectPath, alias, sourceDirs, language);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            project: alias,
            path: projectPath,
            message: `Watching ${alias} — file changes will trigger automatic reindexing after 2s debounce. Manifest diff runs before each query as safety net.`,
          }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error watching project: ${error}` }], isError: true };
    }
  }
);

server.tool(
  "unwatch_project",
  "Stop watching a project. The project's indexed data is preserved — only the automatic re-indexing is disabled.",
  {
    projectAlias: z.string().describe("The project alias to stop watching"),
  },
  async ({ projectAlias }) => {
    liveWatcher.unwatchProject(projectAlias);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ success: true, project: projectAlias, message: `Stopped watching ${projectAlias}` }, null, 2),
      }],
    };
  }
);

server.tool(
  "watcher_status",
  "Check the status of the automatic re-indexer. Returns watched projects and whether the watcher is running. (In-process — no daemon.)",
  {},
  async () => {
    const status = liveWatcher.getStatus();
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...status, architecture: "in-process (no daemon, no IPC)" }, null, 2) }] };
  }
);

server.tool(
  "trigger_reindex",
  "Manually trigger incremental re-index for a watched project. Bypasses the debounce window.",
  {
    projectAlias: z.string().describe("The project alias to re-index"),
    full: z.boolean().default(false).describe("If true, perform a full re-index (diff all files vs manifest)"),
  },
  async ({ projectAlias, full }) => {
    try {
      const status = liveWatcher.getStatus();
      if (!status.watchedProjects.includes(projectAlias)) {
        return { content: [{ type: "text" as const, text: `Project '${projectAlias}' is not being watched. Use watch_project first.` }], isError: true };
      }

      const projectList = liveWatcher.getProjectList();
      const project = projectList.find(p => p.alias === projectAlias);
      const sourceDirs = project?.sourceDirs || ["src"];
      const language = project?.language || "jssrc";
      const projectPath = project?.projectPath || projectAlias;

      const result = await liveWatcher.triggerReindex(
        projectPath,
        projectAlias,
        sourceDirs,
        language,
        full
      );

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error triggering reindex: ${error}` }], isError: true };
    }
  }
);

async function main() {
  await checkArangoConnection();

  const shutdown = () => {
    liveWatcher.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (HTTP_MODE) {
    let httpTransport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => randomUUID(),
    });
    let isInitialized = false;

    /**
     * Handle re-initialization: swap the transport so a new client (e.g., proxy restart)
     * can initialize again without restarting the entire server daemon.
     *
     * The StreamableHTTPServerTransport is stateful — once initialized, it rejects
     * all subsequent initialize requests with 400. We work around this by:
     *   1. Closing the old transport (cleans up SSE streams, session state)
     *   2. Creating a fresh transport
     *   3. Reconnecting the McpServer (Protocol.connect() accepts a new transport
     *      after close() sets _transport = undefined)
     *   4. Routing the current request through the new transport
     */
    async function ensureFreshTransport(): Promise<void> {
      await httpTransport.close();
      httpTransport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: () => randomUUID(),
      });
      await server.connect(httpTransport);
      isInitialized = false;
      console.error("[code-intel] Transport reset for new client session");
    }

    const httpServer = createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${STREAMABLE_HTTP_PORT}`);
      if (url.pathname === "/mcp" || url.pathname === "/") {
        let body: unknown = undefined;
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.from(chunk as Buffer));
          }
          if (chunks.length > 0) {
            body = JSON.parse(Buffer.concat(chunks).toString());
            // Detect re-initialization: a fresh initialize request when already initialized
            if (isInitialized && typeof body === "object" && body !== null) {
              const msg = body as { method?: string };
              if (msg.method === "initialize") {
                await ensureFreshTransport();
              }
            }
          }
        }
        await httpTransport.handleRequest(req, res, body);
        // Mark as initialized after a successful initialize request
        if (req.method === "POST" && !isInitialized && typeof body === "object" && body !== null) {
          const msg = body as { method?: string };
          if (msg.method === "initialize") {
            isInitialized = true;
          }
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await server.connect(httpTransport);

    return new Promise<void>((resolve) => {
      httpServer.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(`[code-intel] Port ${STREAMABLE_HTTP_PORT} already in use (another daemon running). Exiting.`);
          process.exit(0);
        }
        console.error("[code-intel] HTTP server error:", err);
        process.exit(1);
      });
      httpServer.listen(STREAMABLE_HTTP_PORT, "127.0.0.1", () => {
        console.error(`code-intel-mcp server running on Streamable HTTP`);
        console.error(`  HTTP: http://127.0.0.1:${STREAMABLE_HTTP_PORT}/mcp`);
        console.error(`  Joern: ${JOERN_CLI_PATH}`);
        console.error(`  ArangoDB: ${ARANGO_HOST} (db: ${ARANGO_DB})`);
        console.error(`  Architecture: in-process live watcher (no daemon, no IPC)`);
        resolve();
      });
    });
  } else {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error("code-intel-mcp server running on stdio");
    console.error(`  Joern: ${JOERN_CLI_PATH}`);
    console.error(`  ArangoDB: ${ARANGO_HOST} (db: ${ARANGO_DB})`);
    console.error(`  Architecture: in-process live watcher (no daemon, no IPC)`);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});