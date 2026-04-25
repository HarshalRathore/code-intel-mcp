import { Database, aql } from "arangojs";
import { JoernClient, CpgMethod, CpgCallEdge } from "./joern-client.js";
import { QueryCache, makeCacheKey } from "./cache.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CpgNode {
  _key: string;
  name: string;
  label: string;
  filename: string;
  TYPE_FULL_NAME: string;
  lineNumber: number;
  code: string;
  projectAlias: string;
  projectPath: string;
}

export interface CpgEdge {
  _from: string;
  _to: string;
  label: string;
  projectAlias: string;
}

export interface SearchResult {
  name: string;
  label: string;
  filename: string;
  lineNumber: number;
  TYPE_FULL_NAME: string;
  code: string;
}

export interface CallerResult {
  caller: string;
  callerFile: string;
  callerLine: number;
  callee: string;
}

export interface CalleeResult {
  callee: string;
  calleeFile: string;
  calleeLine: number;
  caller: string;
}

export interface CallChainResult {
  from: string;
  to: string;
  paths: Array<{
    chain: string[];
    files: string[];
  }>;
}

export interface ImpactResult {
  symbol: string;
  directCallers: Array<{ name: string; file: string; line: number }>;
  directCallees: Array<{ name: string; file: string; line: number }>;
  transitivelyAffected: Array<{ name: string; file: string; line: number }>;
}

export interface ImportResult {
  nodeCount: number;
  edgeCount: number;
  collections: string[];
}

export class ArangoClient {
  private db: Database;
  private nodesColl: any;
  private edgesColl: any;
  private dbName: string;
  private cache: QueryCache;

  constructor(host: string, user: string, password: string, dbName: string, cache?: QueryCache) {
    this.dbName = dbName;
    this.db = new Database({
      url: host,
      auth: { username: user, password },
      databaseName: dbName,
    });
    this.nodesColl = this.db.collection("cpg_nodes");
    this.edgesColl = this.db.collection("cpg_edges");
    this.cache = cache || new QueryCache(500, 5 * 60 * 1000);
  }

  async ensureConnection(): Promise<void> {
    try {
      await this.db.version();
    } catch (error) {
      throw new Error(`ArangoDB connection failed: ${error}`);
    }
  }

  async createGraph(): Promise<void> {
    try {
      await this.db.createGraph("cpg_graph", [
        {
          collection: "cpg_edges",
          from: ["cpg_nodes"],
          to: ["cpg_nodes"],
        },
      ]);
    } catch (error) {
      const err = error as { errorNum?: number; errorMessage?: string };
      if (err.errorNum !== 1925) {
        throw new Error(`Failed to create cpg_graph: ${err.errorMessage || error}`);
      }
    }
  }

  async searchSymbols(
    query: string,
    nodeType: string,
    projectPath: string
  ): Promise<SearchResult[]> {
    await this.ensureConnection();
    const cacheKey = makeCacheKey("searchSymbols", { query, nodeType, projectPath });
    const cached = this.cache.get<SearchResult[]>(cacheKey);
    if (cached) return cached;

    const typeFilter =
      nodeType === "ALL" ? "" : `FILTER n.label == @nodeType`;
    const projectFilter = `FILTER n.projectPath == @projectPath`;

    const cursor = await this.db.query(
      aql`
        FOR n IN cpg_nodes
        ${projectFilter ? aql`FILTER n.projectPath == ${projectPath}` : aql``}
        ${typeFilter ? (nodeType === "ALL" ? aql`` : aql`FILTER n.label == ${nodeType}`) : aql``}
        FILTER CONTAINS(LOWER(n.name), LOWER(${query}))
        LIMIT 50
        RETURN {
          name: n.name,
          label: n.label,
          filename: n.filename,
          lineNumber: n.lineNumber,
          TYPE_FULL_NAME: n.TYPE_FULL_NAME,
          code: n.code
        }
      `,
      { cache: true, ttl: 300 }
    );

    const results = await cursor.all();
    this.cache.set(cacheKey, results);
    return results;
  }

  async getCallers(
    functionName: string,
    projectPath: string,
    depth: number
  ): Promise<CallerResult[]> {
    await this.ensureConnection();
    const cacheKey = makeCacheKey("getCallers", { functionName, projectPath, depth });
    const cached = this.cache.get<CallerResult[]>(cacheKey);
    if (cached) return cached;

    if (depth === 1) {
      const cursor = await this.db.query(
        aql`
          FOR target IN cpg_nodes
          FILTER LOWER(target.name) == LOWER(${functionName})
          FILTER target.label == "METHOD"
          FILTER target.projectPath == ${projectPath}
          FOR caller IN 1..1 INBOUND target cpg_edges
          FILTER caller.label == "METHOD"
          RETURN DISTINCT {
            caller: caller.name,
            callerFile: caller.filename,
            callerLine: caller.lineNumber,
            callee: target.name
          }
        `,
        { cache: true, ttl: 300 }
      );
      const results = await cursor.all();
      this.cache.set(cacheKey, results);
      return results;
    }

    const cursor = await this.db.query(aql`
      FOR target IN cpg_nodes
      FILTER LOWER(target.name) == LOWER(${functionName})
      FILTER target.label == "METHOD"
      FILTER target.projectPath == ${projectPath}
      FOR v, e, p IN 1..${depth} INBOUND target GRAPH 'cpg_graph'
      FILTER v.label == "METHOD"
        RETURN DISTINCT {
          caller: v.name,
          callerFile: v.filename,
          callerLine: v.lineNumber,
          callee: target.name
        }
    `);
    const results = await cursor.all();
    this.cache.set(cacheKey, results);
    return results;
  }

  async getCallees(
    functionName: string,
    projectPath: string,
    depth: number
  ): Promise<CalleeResult[]> {
    await this.ensureConnection();
    const cacheKey = makeCacheKey("getCallees", { functionName, projectPath, depth });
    const cached = this.cache.get<CalleeResult[]>(cacheKey);
    if (cached) return cached;

    if (depth === 1) {
      const cursor = await this.db.query(
        aql`
          FOR source IN cpg_nodes
          FILTER LOWER(source.name) == LOWER(${functionName})
          FILTER source.label == "METHOD"
          FILTER source.projectPath == ${projectPath}
          FOR callee IN 1..1 OUTBOUND source cpg_edges
          FILTER callee.label == "METHOD"
          RETURN DISTINCT {
            callee: callee.name,
            calleeFile: callee.filename,
            calleeLine: callee.lineNumber,
            caller: source.name
          }
        `,
        { cache: true, ttl: 300 }
      );
      const results = await cursor.all();
      this.cache.set(cacheKey, results);
      return results;
    }

    const cursor = await this.db.query(aql`
      FOR source IN cpg_nodes
      FILTER LOWER(source.name) == LOWER(${functionName})
      FILTER source.label == "METHOD"
      FILTER source.projectPath == ${projectPath}
      FOR v, e, p IN 1..${depth} OUTBOUND source GRAPH 'cpg_graph'
      FILTER v.label == "METHOD"
        RETURN DISTINCT {
          callee: v.name,
          calleeFile: v.filename,
          calleeLine: v.lineNumber,
          caller: source.name
        }
    `);
    const results = await cursor.all();
    this.cache.set(cacheKey, results);
    return results;
  }

  async getCallChain(
    fromFunction: string,
    toFunction: string,
    projectPath: string,
    maxDepth: number
  ): Promise<CallChainResult> {
    await this.ensureConnection();
    const cacheKey = makeCacheKey("getCallChain", { fromFunction, toFunction, projectPath, maxDepth });
    const cached = this.cache.get<CallChainResult>(cacheKey);
    if (cached) return cached;

    const cursor = await this.db.query(aql`
      FOR fromNode IN cpg_nodes
      FILTER LOWER(fromNode.name) == LOWER(${fromFunction})
      FILTER fromNode.label == "METHOD"
      FILTER fromNode.projectPath == ${projectPath}
      FOR toNode IN cpg_nodes
      FILTER LOWER(toNode.name) == LOWER(${toFunction})
      FILTER toNode.label == "METHOD"
      FILTER toNode.projectPath == ${projectPath}
      FOR v, e, p IN 1..${maxDepth} OUTBOUND fromNode GRAPH 'cpg_graph'
      OPTIONS { uniqueVertices: "path" }
      FILTER v._id == toNode._id
      LIMIT 10
      RETURN {
        chain: p.vertices[*].name,
        files: p.vertices[*].filename
      }
    `);

    const paths = await cursor.all();
    const seen = new Set<string>();
    const dedupedPaths = paths.filter(p => {
      const key = p.chain.join("→");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const result = { from: fromFunction, to: toFunction, paths: dedupedPaths };
    this.cache.set(cacheKey, result);
    return result;
  }

  async getDataFlow(
    sourceName: string,
    functionName: string,
    projectPath: string,
    direction: string
  ): Promise<{
    source: string;
    function: string;
    forwardFlows: Array<{ from: string; to: string; type: string }>;
    backwardFlows: Array<{ from: string; to: string; type: string }>;
  }> {
    await this.ensureConnection();

    let forwardFlows: Array<{ from: string; to: string; type: string }> = [];
    let backwardFlows: Array<{ from: string; to: string; type: string }> = [];

    if (direction === "forward" || direction === "both") {
      const cursor = await this.db.query(aql`
        FOR node IN cpg_nodes
        FILTER LOWER(node.name) == LOWER(${functionName})
        FILTER node.label == "METHOD"
        FILTER node.projectPath == ${projectPath}
        FOR v, e, p IN 1..3 OUTBOUND node GRAPH 'cpg_graph'
        OPTIONS { uniqueVertices: "path" }
        FILTER v.label == "METHOD"
        RETURN DISTINCT { from: node.name, to: v.name, type: "DATA_FLOW" }
      `);
      forwardFlows = await cursor.all();
    }

    if (direction === "backward" || direction === "both") {
      const cursor = await this.db.query(aql`
        FOR node IN cpg_nodes
        FILTER LOWER(node.name) == LOWER(${functionName})
        FILTER node.label == "METHOD"
        FILTER node.projectPath == ${projectPath}
        FOR v, e, p IN 1..3 INBOUND node GRAPH 'cpg_graph'
        OPTIONS { uniqueVertices: "path" }
        FILTER v.label == "METHOD"
        RETURN DISTINCT { from: v.name, to: node.name, type: "DATA_FLOW" }
      `);
      backwardFlows = await cursor.all();
    }

    return { source: sourceName, function: functionName, forwardFlows, backwardFlows };
  }

  async getImpactAnalysis(
    symbolName: string,
    projectPath: string,
    symbolType: string,
    maxResults: number = 50
  ): Promise<ImpactResult> {
    await this.ensureConnection();
    const cacheKey = makeCacheKey("getImpactAnalysis", { symbolName, projectPath, symbolType });
    const cached = this.cache.get<ImpactResult>(cacheKey);
    if (cached) return cached;

    const typeFilter = symbolType === "AUTO" ? "" : `FILTER n.label == @symbolType`;

    const directCallersCursor = await this.db.query(aql`
      FOR n IN cpg_nodes
      FILTER LOWER(n.name) == LOWER(${symbolName})
      FILTER n.label == "METHOD"
      FILTER n.filename != "" AND n.filename != "<empty>"
      FILTER n.projectPath == ${projectPath}
      ${typeFilter ? (symbolType === "AUTO" ? aql`` : aql`FILTER n.label == ${symbolType}`) : aql``}
      FOR caller IN 1..1 INBOUND n cpg_edges
      FILTER caller.label == "METHOD"
      FILTER caller.name != n.name
      RETURN DISTINCT { name: caller.name, file: caller.filename, line: caller.lineNumber }
    `);

    const directCalleesCursor = await this.db.query(aql`
      FOR n IN cpg_nodes
      FILTER LOWER(n.name) == LOWER(${symbolName})
      FILTER n.label == "METHOD"
      FILTER n.filename != "" AND n.filename != "<empty>"
      FILTER n.projectPath == ${projectPath}
      ${typeFilter ? (symbolType === "AUTO" ? aql`` : aql`FILTER n.label == ${symbolType}`) : aql``}
      FOR callee IN 1..1 OUTBOUND n cpg_edges
      FILTER callee.label == "METHOD"
      RETURN DISTINCT { name: callee.name, file: callee.filename, line: callee.lineNumber }
    `);

    const transitiveCursor = await this.db.query(
      aql`
        FOR n IN cpg_nodes
        FILTER LOWER(n.name) == LOWER(${symbolName})
        FILTER n.label == "METHOD"
        FILTER n.filename != "" AND n.filename != "<empty>"
        FILTER n.projectPath == ${projectPath}
        FOR v IN 2..3 ANY n cpg_edges
        FILTER v.label == "METHOD"
        LIMIT ${maxResults}
        RETURN DISTINCT { name: v.name, file: v.filename, line: v.lineNumber }
      `
    );

    const result = {
      symbol: symbolName,
      directCallers: await directCallersCursor.all(),
      directCallees: await directCalleesCursor.all(),
      transitivelyAffected: await transitiveCursor.all(),
    };
    this.cache.set(cacheKey, result);
    return result;
  }

  async getReactComponents(
    projectPath: string,
    filePath?: string
  ): Promise<Array<{ componentName: string; fileName: string; lineNumber: number; callees: string[] }>> {
    await this.ensureConnection();
    
    // Strategy: Search for JSX component names (PascalCase) in method code
    // A React component name starts with uppercase letter and is used as <ComponentName /> in JSX
    // Exclude HTTP method names (Next.js API route handlers) which are misidentified as React components
    const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
    const cursor = await this.db.query(aql`
      FOR n IN cpg_nodes
      FILTER n.label == "METHOD"
      FILTER n.projectPath == ${projectPath}
      FILTER n.filename != "" AND n.filename != "<empty>"
      ${filePath ? aql`FILTER CONTAINS(n.filename, ${filePath})` : aql``}
      FILTER REGEX_TEST(n.name, "^[A-Z][a-zA-Z0-9]*$")
      FILTER n.name NOT IN ${HTTP_METHODS}
      LET callees = (
        FOR callee IN 1..1 OUTBOUND n cpg_edges
        FILTER callee.label == "METHOD"
        FILTER callee.filename != "" AND callee.filename != "<empty>"
        RETURN callee.name
      )
      RETURN {
        componentName: n.name,
        fileName: n.filename,
        lineNumber: n.lineNumber,
        callees: callees
      }
    `);
    
    return await cursor.all();
  }

  async getHookUsage(
    projectPath: string,
    hookName?: string
  ): Promise<Array<{ hookName: string; usedIn: string; fileName: string; lineNumber: number }>> {
    await this.ensureConnection();
    
    // Strategy: Find methods whose names start with "use" (React hooks)
    // Then find callers of those hooks
    // Note: Since Joern CPG creates both real method nodes (with source) and stub nodes (line 0, <empty>),
    // and edges point to stub nodes, we find callers of ANY version of the hook
    const cursor = await this.db.query(aql`
      FOR hook IN cpg_nodes
      FILTER hook.label == "METHOD"
      FILTER hook.projectPath == ${projectPath}
      ${hookName ? aql`FILTER hook.name == ${hookName}` : aql`FILTER LOWER(hook.name) LIKE "use%"`}
      FOR caller IN 1..1 INBOUND hook cpg_edges
      FILTER caller.label == "METHOD"
      RETURN DISTINCT {
        hookName: hook.name,
        usedIn: caller.name,
        fileName: caller.filename,
        lineNumber: caller.lineNumber
      }
    `);
    
    return await cursor.all();
  }

  /** Public: upsert nodes with onDuplicate: "update". Returns counts. */
  async upsertNodes(nodes: CpgNode[]): Promise<{ added: number; updated: number }> {
    if (nodes.length === 0) return { added: 0, updated: 0 };
    await this.ensureConnection();
    const batchSize = 5000;
    let added = 0;
    let updated = 0;
    for (let i = 0; i < nodes.length; i += batchSize) {
      const batch = nodes.slice(i, i + batchSize);
      try {
        console.error(`[arango-client] upsertNodes: importing ${batch.length} nodes, first _key="${batch[0]._key}"`);
        const result: any = await this.nodesColl.import(batch, { onDuplicate: "update" });
        console.error(`[arango-client] upsertNodes result: ${JSON.stringify(result)}`);
        if (result.created) added += result.created;
        if (result.updated) updated += result.updated;
      } catch (error) {
        console.error("[arango-client] upsertNodes error:", error);
      }
    }
    return { added, updated };
  }

  /** Public: upsert edges with onDuplicate: "update". Returns counts. */
  async upsertEdges(edges: CpgEdge[]): Promise<{ added: number; updated: number }> {
    if (edges.length === 0) return { added: 0, updated: 0 };
    await this.ensureConnection();
    const batchSize = 5000;
    let added = 0;
    let updated = 0;
    for (let i = 0; i < edges.length; i += batchSize) {
      const batch = edges.slice(i, i + batchSize);
      try {
        const result: any = await this.edgesColl.import(batch, { onDuplicate: "update" });
        if (result.created) added += result.created;
        if (result.updated) updated += result.updated;
      } catch (error) {
        console.error("[arango-client] upsertEdges error:", error);
      }
    }
    return { added, updated };
  }

  /** Delete ALL edges for a project in one query. Used for full edge recomputation. */
  async deleteProjectEdges(projectAlias: string): Promise<number> {
    await this.ensureConnection();
    try {
      const cursor = await this.db.query(aql`
        FOR edge IN cpg_edges
        FILTER edge.projectAlias == ${projectAlias}
        REMOVE edge IN cpg_edges
        COLLECT WITH COUNT INTO cnt
        RETURN cnt
      `);
      const result = await cursor.all();
      const deleted = result[0] || 0;
      console.error(`[arango-client] deleteProjectEdges: deleted ${deleted} edges for ${projectAlias}`);
      this.cache.invalidateProject(projectAlias);
      return deleted;
    } catch (error) {
      console.error(`[arango-client] deleteProjectEdges error:`, error);
      return 0;
    }
  }

  /** Delete edges for methods in specific files. Used for incremental (file-scoped) edge recomputation. */
  async deleteEdgesForFiles(projectAlias: string, filenames: string[]): Promise<number> {
    if (filenames.length === 0) return 0;
    await this.ensureConnection();
    try {
      const cursor = await this.db.query(aql`
        FOR edge IN cpg_edges
        FILTER edge.projectAlias == ${projectAlias}
        FILTER edge._from IN (FOR node IN cpg_nodes FILTER node.projectAlias == ${projectAlias} AND node.filename IN ${filenames} RETURN node._id)
           OR edge._to IN (FOR node IN cpg_nodes FILTER node.projectAlias == ${projectAlias} AND node.filename IN ${filenames} RETURN node._id)
        REMOVE edge IN cpg_edges
        COLLECT WITH COUNT INTO cnt
        RETURN cnt
      `);
      const result = await cursor.all();
      const deleted = result[0] || 0;
      console.error(`[arango-client] deleteEdgesForFiles: deleted ${deleted} edges for ${filenames.length} files in ${projectAlias}`);
      this.cache.invalidateProject(projectAlias);
      return deleted;
    } catch (error) {
      console.error(`[arango-client] deleteEdgesForFiles error:`, error);
      return 0;
    }
  }

  /** @deprecated Use deleteProjectEdges or deleteEdgesForFiles instead. Deletes edges for a single method name. */
  async deleteEdgesForMethod(projectAlias: string, methodName: string): Promise<void> {
    await this.ensureConnection();
    try {
      await this.db.query(aql`
        FOR edge IN cpg_edges
        FILTER edge.projectAlias == ${projectAlias}
        FILTER edge._from IN (FOR node IN cpg_nodes FILTER node.projectAlias == ${projectAlias} AND node.name == ${methodName} RETURN node._id)
           OR edge._to IN (FOR node IN cpg_nodes FILTER node.projectAlias == ${projectAlias} AND node.name == ${methodName} RETURN node._id)
        REMOVE edge IN cpg_edges
      `);
    } catch (error) {
      console.error(`[arango-client] deleteEdgesForMethod(${methodName}) error:`, error);
    }
  }

  async truncateProjectData(projectAlias: string): Promise<void> {
    await this.ensureConnection();
    try {
      await this.db.query(aql`
        FOR node IN cpg_nodes
        FILTER node.projectAlias == ${projectAlias}
        REMOVE node IN cpg_nodes
      `);
    } catch (error) {
      console.error("Error truncating project nodes:", error);
    }
    try {
      await this.db.query(aql`
        FOR edge IN cpg_edges
        FILTER edge.projectAlias == ${projectAlias}
        REMOVE edge IN cpg_edges
      `);
    } catch (error) {
      console.error("Error truncating project edges:", error);
    }
    this.cache.invalidateProject(projectAlias);
  }

  async deleteProjectFiles(projectAlias: string, deletedFiles: string[]): Promise<number> {
    if (deletedFiles.length === 0) return 0;
    await this.ensureConnection();
    let totalDeleted = 0;
    for (const file of deletedFiles) {
      try {
        const cursor = await this.db.query(aql`
          FOR node IN cpg_nodes
          FILTER node.projectAlias == ${projectAlias}
          FILTER CONTAINS(node.filename, ${file})
          REMOVE node IN cpg_nodes
          RETURN OLD._key
        `);
        const removed = await cursor.all();
        totalDeleted += removed.length;
        for (const key of removed) {
          try {
            await this.db.query(aql`
              FOR edge IN cpg_edges
              FILTER edge._from == CONCAT("cpg_nodes/", ${key}) || edge._to == CONCAT("cpg_nodes/", ${key})
              REMOVE edge IN cpg_edges
            `);
          } catch {}
        }
      } catch (error) {
        console.error(`Error deleting nodes for file ${file}:`, error);
      }
    }
    this.cache.invalidateProject(projectAlias);
    return totalDeleted;
  }

  async dropProject(projectAlias: string): Promise<{ nodesDeleted: number; edgesDeleted: number }> {
    await this.ensureConnection();

    // Delete edges first (referential integrity)
    const edgesCount = await this.db.query(aql`
      FOR edge IN cpg_edges
      FILTER edge.projectAlias == ${projectAlias}
      COLLECT WITH COUNT INTO cnt
      RETURN cnt
    `).then(c => c.all().then(r => r[0] || 0));

    await this.db.query(aql`
      FOR edge IN cpg_edges
      FILTER edge.projectAlias == ${projectAlias}
      REMOVE edge IN cpg_edges
    `);

    // Then delete nodes
    const nodesCount = await this.db.query(aql`
      FOR node IN cpg_nodes
      FILTER node.projectAlias == ${projectAlias}
      COLLECT WITH COUNT INTO cnt
      RETURN cnt
    `).then(c => c.all().then(r => r[0] || 0));

    await this.db.query(aql`
      FOR node IN cpg_nodes
      FILTER node.projectAlias == ${projectAlias}
      REMOVE node IN cpg_nodes
    `);

    this.cache.invalidateProject(projectAlias);
    return { nodesDeleted: nodesCount, edgesDeleted: edgesCount };
  }

  async importCpg(
    cpgBinPath: string,
    projectAlias: string,
    projectPath: string,
    joernClient?: JoernClient
  ): Promise<ImportResult> {
    await this.ensureConnection();
    await this.createGraph();

    const joern = joernClient || new JoernClient(
      process.env.JOERN_CLI_PATH || "/opt/joern/joern-cli"
    );

    let methods: CpgMethod[] = [];
    let callEdges: CpgCallEdge[] = [];

    try {
      methods = await joern.getMethods(cpgBinPath);
    } catch (error) {
      console.error("Failed to extract methods from CPG:", error);
    }

    try {
      callEdges = await joern.getCallEdges(cpgBinPath);
    } catch (error) {
      console.error("Warning: Could not extract call edges:", error);
    }

    const userMethods = methods.filter(m =>
      !m.name.startsWith("<") &&
      !m.name.startsWith("__ecma.") &&
      m.name !== ":program"
    );

    const nodesToInsert: CpgNode[] = userMethods.map(m => ({
      _key: this.sanitizeKey(`${projectAlias}::${m.name}::${m.lineNumber}`),
      name: m.name,
      label: "METHOD" as const,
      filename: m.filename,
      TYPE_FULL_NAME: "",
      lineNumber: m.lineNumber,
      code: m.code ? m.code.substring(0, 500) : "",
      projectAlias,
      projectPath,
    }));

    const methodKeyMap = new Map<string, string>();
    for (const m of userMethods) {
      const key = this.sanitizeKey(`${projectAlias}::${m.name}::${m.lineNumber}`);
      methodKeyMap.set(m.name, `cpg_nodes/${key}`);
    }

    const edgesToInsert: CpgEdge[] = callEdges
      .filter(e => !e.callerName.startsWith("<") && !e.calleeName.startsWith("<"))
      .filter(e => e.callerName !== ":program" && e.calleeName !== ":program")
      .filter(e => {
        const fromKey = methodKeyMap.get(e.callerName);
        const toKey = methodKeyMap.get(e.calleeName);
        return fromKey !== undefined || toKey !== undefined;
      })
      .map(e => {
        const fromKey = methodKeyMap.get(e.callerName) ||
          `cpg_nodes/${this.sanitizeKey(`${projectAlias}::${e.callerName}::0`)}`;
        const toKey = methodKeyMap.get(e.calleeName) ||
          `cpg_nodes/${this.sanitizeKey(`${projectAlias}::${e.calleeName}::0`)}`;
        return {
          _from: fromKey,
          _to: toKey,
          label: "CALL",
          projectAlias,
        };
      });

    const batchSize = 5000;
    for (let i = 0; i < nodesToInsert.length; i += batchSize) {
      const batch = nodesToInsert.slice(i, i + batchSize);
      try {
        const result: any = await this.nodesColl.import(batch, { onDuplicate: "update" });
        if (result.error || result.errors > 0) {
          console.error(`Node import: ${result.errors} error(s), ${result.created} created, ${result.updated} updated`);
        }
      } catch (error) {
        console.error("Node import error:", error);
      }
    }

    for (let i = 0; i < edgesToInsert.length; i += batchSize) {
      const batch = edgesToInsert.slice(i, i + batchSize);
      try {
        const result: any = await this.edgesColl.import(batch, { onDuplicate: "update" });
        if (result.error || result.errors > 0) {
          console.error(`Edge import: ${result.errors} error(s), ${result.created} created, ${result.updated} updated`);
        }
      } catch (error) {
        console.error("Edge import error:", error);
      }
    }

    this.cache.invalidateProject(projectAlias);
    return {
      nodeCount: nodesToInsert.length,
      edgeCount: edgesToInsert.length,
      collections: ["cpg_nodes", "cpg_edges"],
    };
  }

  private sanitizeKey(key: string): string {
    return key
      .replace(/[^a-zA-Z0-9_\-:]/g, "_")
      .replace(/_+/g, "_")
      .substring(0, 254);
  }

  async listFiles(
    projectPath: string,
    filePath?: string,
    limit: number = 50
  ): Promise<Array<{ file: string; methodCount: number; methods: string[] }>> {
    await this.ensureConnection();

    const cursor = await this.db.query(aql`
      FOR n IN cpg_nodes
      FILTER n.projectPath == ${projectPath}
      FILTER n.label == "METHOD"
      FILTER n.filename != "" AND n.filename != "<empty>"
      ${filePath ? aql`FILTER CONTAINS(n.filename, ${filePath})` : aql``}
      COLLECT file = n.filename INTO methodsPerFile
      LET methodNames = UNIQUE(methodsPerFile[*].n.name)
      SORT LENGTH(methodNames) DESC
      LIMIT ${limit}
      RETURN {
        file: file,
        methodCount: LENGTH(methodNames),
        methods: SLICE(methodNames, 0, 10)
      }
    `);

    return await cursor.all();
  }

  async getProjectStatus(
    projectPath: string
  ): Promise<{
    projectPath: string;
    totalNodes: number;
    totalEdges: number;
    totalFiles: number;
    totalMethods: number;
    indexedAt: string | null;
    language: string | null;
  }> {
    await this.ensureConnection();

    const [nodeCount, edgeCount, fileCount, methodCount] = await Promise.all([
      this.db
        .query(
          aql`FOR n IN cpg_nodes FILTER n.projectPath == ${projectPath} COLLECT WITH COUNT INTO c RETURN c`
        )
        .then(c => c.all()),
      this.db
        .query(
          aql`FOR e IN cpg_edges FILTER e.projectAlias != null COLLECT WITH COUNT INTO c RETURN c`
        )
        .then(c => c.all()),
      this.db
        .query(
          aql`FOR n IN cpg_nodes FILTER n.projectPath == ${projectPath} FILTER n.filename != "" AND n.filename != "<empty>" RETURN DISTINCT n.filename`
        )
        .then(async c => {
          const r = await c.all();
          return r.length;
        }),
      this.db
        .query(
          aql`FOR n IN cpg_nodes FILTER n.projectPath == ${projectPath} FILTER n.label == "METHOD" FILTER n.name != ":program" FILTER n.name != "<init>" COLLECT WITH COUNT INTO c RETURN c`
        )
        .then(c => c.all()),
    ]);

    const manifestPath = join(projectPath, ".code-intel", "manifest.json");
    let indexedAt: string | null = null;
    let language: string | null = null;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      indexedAt = manifest.indexedAt || null;
      language = manifest.language || null;
    } catch {}

    return {
      projectPath,
      totalNodes: nodeCount[0] || 0,
      totalEdges: edgeCount[0] || 0,
      totalFiles: fileCount,
      totalMethods: methodCount[0] || 0,
      indexedAt,
      language,
    };
  }

  getCacheStats(): { hits: number; misses: number; evictions: number; size: number; hitRate: string } {
    const stats = this.cache.getStats();
    const total = stats.hits + stats.misses;
    return {
      hits: stats.hits,
      misses: stats.misses,
      evictions: stats.evictions,
      size: stats.size,
      hitRate: total > 0 ? `${((stats.hits / total) * 100).toFixed(1)}%` : "0%",
    };
  }

  async listProjects(): Promise<Array<{ projectPath: string; projectAlias: string; totalNodes: number; totalEdges: number; totalFiles: number }>> {
    await this.ensureConnection();

    // Get per-project stats in two queries then combine
    const [nodesResult, edgesResult, filesResult] = await Promise.all([
      this.db.query(aql`
        FOR n IN cpg_nodes
        FILTER n.label == "METHOD"
        FILTER n.name != "<init>"
        FILTER n.name != ":program"
        FILTER n.projectPath != ""
        FILTER n.projectPath != null
        COLLECT projectPath = n.projectPath, projectAlias = n.projectAlias WITH COUNT INTO totalNodes
        RETURN { projectPath, projectAlias, totalNodes }
      `),
      this.db.query(aql`
        FOR e IN cpg_edges
        FILTER e.projectAlias != null
        COLLECT projectAlias = e.projectAlias WITH COUNT INTO totalEdges
        RETURN { projectAlias, totalEdges }
      `),
      this.db.query(aql`
        FOR n IN cpg_nodes
        FILTER n.projectPath != ""
        FILTER n.projectPath != null
        FILTER n.filename != ""
        FILTER n.filename != "<empty>"
        COLLECT projectPath = n.projectPath INTO files = n.filename
        RETURN { projectPath, totalFiles: LENGTH(UNIQUE(files)) }
      `),
    ]);

    const nodesMap = new Map((await nodesResult.all()).map(n => [n.projectPath, n]));
    const edgesMap = new Map((await edgesResult.all()).map(e => [e.projectAlias, e]));
    const filesMap = new Map((await filesResult.all()).map(f => [f.projectPath, f]));

    const projects: Array<{ projectPath: string; projectAlias: string; totalNodes: number; totalEdges: number; totalFiles: number }> = [];
    for (const [projectPath, nodeData] of nodesMap) {
      const projectAlias = nodeData.projectAlias;
      projects.push({
        projectPath,
        projectAlias,
        totalNodes: nodeData.totalNodes,
        totalEdges: edgesMap.get(projectAlias)?.totalEdges || 0,
        totalFiles: filesMap.get(projectPath)?.totalFiles || 0,
      });
    }

    return projects;
  }
}