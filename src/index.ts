import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JoernClient } from "./joern-client.js";
import { ArangoClient } from "./arango-client.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { computeManifestHashes, diffManifests, loadManifest, saveManifest } from "./manifest.js";
import type { FileManifest } from "./manifest.js";
import { findUsages } from "./usage-finder.js";
import { getCodeContext } from "./code-context.js";

const JOERN_CLI_PATH = process.env.JOERN_CLI_PATH || "/opt/joern/joern-cli";
const ARANGO_HOST = process.env.ARANGO_HOST || "http://localhost:8529";
const ARANGO_USER = process.env.ARANGO_USER || "root";
const ARANGO_PASS = process.env.ARANGO_PASS || "";
const ARANGO_DB = process.env.ARANGO_DB || "code_intel";

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

if (!process.env.ARANGO_PASS && !process.env.ARANGO_HOST) {
  console.error([
    "code-intel-mcp: ArangoDB connection not configured.",
    "",
    "Set ARANGO_HOST, ARANGO_USER, ARANGO_PASS, ARANGO_DB environment variables.",
    "Or start ArangoDB locally: docker compose up -d arangodb",
    "See .env.example for all configuration options.",
  ].join("\n"));
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
  version: "0.1.0",
});

const joern = new JoernClient(JOERN_CLI_PATH);
const arango = new ArangoClient(ARANGO_HOST, ARANGO_USER, ARANGO_PASS, ARANGO_DB);

server.tool(
  "symbol_search",
  "Find a symbol (function, class, method, variable) by name when you know or partially know the name. Use this as the primary discovery tool BEFORE get_callers/get_callees/get_impact_analysis — those tools require an exact symbol name that you should resolve here first. Do not use if you already have the exact symbol name from a prior search or from the code you are reading.",
  {
    query: z.string().describe("Symbol name to search for (supports partial match)"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    nodeType: z.enum(["METHOD", "CLASS", "MEMBER", "ALL"]).default("ALL").describe("Type of symbol to search for"),
  },
  async ({ query, projectPath, nodeType }) => {
    try {
      const results = await arango.searchSymbols(query, nodeType, projectPath);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error searching symbols: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_callers",
  "Trace who calls a function — find all callers up to N levels deep. Use after symbol_search to get the exact function name. Prefer depth=1 first; increase depth only when you need transitive callers. Do not use for simple 'where is this used' questions — use find_usages instead, which is faster and covers imports/references beyond just call sites.",
  {
    functionName: z.string().describe("Name of the function to find callers for"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    depth: z.number().min(1).max(5).default(1).describe("How many levels deep to trace (1=direct callers only)"),
  },
  async ({ functionName, projectPath, depth }) => {
    try {
      const results = await arango.getCallers(functionName, projectPath, depth);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error finding callers: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_callees",
  "Trace what a function calls — find all callees up to N levels deep. Use after symbol_search to get the exact function name. Prefer depth=1 first; increase depth only for deep dependency chains. Do not use to find React component children — use get_react_components instead, which understands JSX component calls that regular call graphs may miss.",
  {
    functionName: z.string().describe("Name of the function to find callees for"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    depth: z.number().min(1).max(5).default(1).describe("How many levels deep to trace (1=direct callees only)"),
  },
  async ({ functionName, projectPath, depth }) => {
    try {
      const results = await arango.getCallees(functionName, projectPath, depth);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error finding callees: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_call_chain",
  "Trace the complete call path between two functions (how does function A reach function B?). Use when you need to understand a specific execution path — e.g. 'how does the auth middleware reach the database layer?'. Do not use for open-ended exploration (use get_callers with depth>1 instead) or when you don't know the target function name.",
  {
    fromFunction: z.string().describe("Starting function name"),
    toFunction: z.string().describe("Target function name"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    maxDepth: z.number().min(1).max(10).default(5).describe("Maximum traversal depth"),
  },
  async ({ fromFunction, toFunction, projectPath, maxDepth }) => {
    try {
      const results = await arango.getCallChain(fromFunction, toFunction, projectPath, maxDepth);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error tracing call chain: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_data_flow",
  "Trace how a variable or parameter flows through the code — forward to sinks, backward to sources, or both. Use for security analysis (taint tracking), understanding data transformation pipelines, or debugging where a value originates/propagates. Do not use for simple 'where is this variable set' questions — use find_usages instead.",
  {
    sourceName: z.string().describe("Variable or parameter name to trace data flow from"),
    functionName: z.string().describe("Function containing the source variable"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    direction: z.enum(["forward", "backward", "both"]).default("forward").describe("Direction of data flow trace"),
  },
  async ({ sourceName, functionName, projectPath, direction }) => {
    try {
      const results = await arango.getDataFlow(sourceName, functionName, projectPath, direction);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error tracing data flow: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_impact_analysis",
  "Determine blast radius — what code breaks if a symbol changes. Traces all callers, importers, and dependents transitively. Use BEFORE modifying any shared function, class, or variable to understand the full scope of change. Do not use for single-file changes or when you already know all dependents from a prior get_callers call.",
  {
    symbolName: z.string().describe("Name of the symbol to analyze impact for"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    symbolType: z.enum(["METHOD", "CLASS", "VARIABLE", "AUTO"]).default("AUTO").describe("Type of the symbol"),
    maxResults: z.number().min(1).max(200).default(50).describe("Maximum number of transitively affected results to return"),
  },
  async ({ symbolName, projectPath, symbolType, maxResults }) => {
    try {
      const results = await arango.getImpactAnalysis(symbolName, projectPath, symbolType, maxResults);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error analyzing impact: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "index_project",
  "Parse and index a project's source code into the code graph database. Run this ONCE per project before any other tool — all query tools require an indexed project. Incremental: only re-parses changed files (SHA256 hash diff). Do not re-index unless files changed — check project_status first to see if indexing is current.",
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
      return {
        content: [{ type: "text" as const, text: `Error indexing project: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_react_components",
  "Find React component definitions and their rendered children in TSX/JSX projects. Identifies PascalCase functions as components and traces their JSX element calls. Use this INSTEAD of get_callees for React/Next.js projects — get_callees misses JSX component calls because Joern models them as iterator stubs. Do not use for non-React projects.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    filePath: z.string().optional().describe("Optional: filter to a specific file path"),
  },
  async ({ projectPath, filePath }) => {
    try {
      const results = await arango.getReactComponents(projectPath, filePath);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(results, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error finding React components: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_hook_usage",
  "Find React hook usage patterns — which functions use which hooks and where. Use to trace hook adoption (e.g. 'who uses useAuth?', 'where is useState misused?'). Do not use for non-hook symbol searches — use symbol_search or find_usages instead.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    hookName: z.string().optional().describe("Optional: specific hook name to search for (e.g. 'useAuth'). If omitted, finds all hooks (names starting with 'use')"),
  },
  async ({ projectPath, hookName }) => {
    try {
      const results = await arango.getHookUsage(projectPath, hookName);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(results, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error finding hook usage: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "cache_stats",
  "Diagnostic: query cache hit rate, evictions, and size. Use only when investigating performance — do not call routinely.",
  {},
  async () => {
    const stats = arango.getCacheStats();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "list_files",
  "List indexed source files with method counts. Use to verify a project is indexed correctly or to explore file-level structure. Do not use to search for a specific symbol — use symbol_search instead.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    filePath: z.string().optional().describe("Optional: filter to files matching this path pattern"),
    limit: z.number().min(1).max(200).default(50).describe("Maximum number of files to return"),
  },
  async ({ projectPath, filePath, limit }) => {
    try {
      const results = await arango.listFiles(projectPath, filePath, limit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error listing files: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "find_usages",
  "Find all references to a symbol — calls, imports, definitions, type references. Faster than get_callers and covers more ground (imports, re-exports, type annotations). Prefer this over get_callers for 'where is X used?' questions. Use get_callers only when you specifically need the call graph depth traversal.",
  {
    symbol: z.string().describe("Symbol name to find usages for (e.g. 'useAuth', 'LoginForm', 'generateTokens')"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    sourceDirs: z.array(z.string()).default(["src"]).describe("Source directories to search in"),
  },
  async ({ symbol, projectPath, sourceDirs }) => {
    try {
      const result = findUsages(projectPath, symbol, sourceDirs);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error finding usages: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_code_context",
  "Given a task description, discover relevant entry points and related files with relevance scores. Use at the START of a new task to orient yourself before diving into code — replaces manual file-by-file exploration. Returns ranked entry points and files based on symbol name matching, call graph proximity, and file path relevance. Do not use if you already know which files matter from prior exploration.",
  {
    task: z.string().describe("Natural language description of the task (e.g. 'implement login form validation', 'fix payment processing bug')"),
    projectPath: z.string().describe("Absolute path to the project root directory"),
    maxEntryPoints: z.number().min(1).max(20).default(10).describe("Maximum number of entry points to return"),
    maxRelatedFiles: z.number().min(1).max(20).default(5).describe("Maximum number of related files to return"),
  },
  async ({ task, projectPath, maxEntryPoints, maxRelatedFiles }) => {
    try {
      const result = await getCodeContext(task, projectPath, arango, maxEntryPoints, maxRelatedFiles);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error building code context: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "project_status",
  "Check if a project is indexed, when it was last indexed, and node/edge counts. Use BEFORE index_project to avoid unnecessary re-indexing, and BEFORE any query tool to confirm the project exists in the database. Do not use as a substitute for index_project when a project is not yet indexed.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  async ({ projectPath }) => {
    try {
      const result = await arango.getProjectStatus(projectPath);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error getting project status: ${error}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  await checkArangoConnection();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("code-intel-mcp server running on stdio");
  console.error(`  Joern: ${JOERN_CLI_PATH}`);
  console.error(`  ArangoDB: ${ARANGO_HOST} (db: ${ARANGO_DB})`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});