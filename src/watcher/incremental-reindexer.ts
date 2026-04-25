/**
 * incremental-reindexer.ts — Hybrid incremental code indexer.
 *
 * Architecture:
 *   - TsMorphIndexer (primary) — TypeScript compiler API for declaration + call edge extraction.
 *     No JVM, no transpilation, no 83s full reparse. Incremental per file.
 *   - FastParser (fallback) — For edge cases ts-morph can't handle.
 *
 * Detection is incremental (chokidar + debounce), parsing is incremental (ts-morph addFile),
 * storage is smart upsert (onDuplicate: "update" for ArangoDB).
 *
 * For small changes (≤5 files), both methods and call edges are extracted in ~100ms.
 * For large changes, the same incremental path is used — no full reparse needed.
 */

import {
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { TsMorphIndexer } from "../ts-morph-indexer.js";
import type { CpgNode, CpgEdge } from "../arango-client.js";
import type { ReindexResult } from "./watcher-types.js";
import {
  loadManifest,
  saveManifest,
  computeFileHash,
  type FileManifest,
} from "../manifest.js";

export class IncrementalReindexer {
  private indexers = new Map<string, TsMorphIndexer>();
  private projectPaths = new Map<string, string>();

  constructor(private joernCliPath: string) {
    // joernCliPath kept for backward compat — no longer used for parsing
  }

  async reindex(
    projectPath: string,
    projectAlias: string,
    manifestPath: string,
    language: string,
    sourceDirs: string[],
    changed: string[],
    added: string[],
    deleted: string[]
  ): Promise<ReindexResult> {
    const startTime = Date.now();
    const allAffected = [...changed, ...added];

    if (allAffected.length === 0 && deleted.length === 0) {
      return {
        success: true,
        alias: projectAlias,
        reindexType: "unchanged",
        filesProcessed: 0,
        nodesAdded: 0,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesAdded: 0,
        importDurationMs: 0,
        totalDurationMs: 0,
      };
    }

    // Lazy-init TsMorphIndexer for this project
    let indexer = this.indexers.get(projectAlias);
    if (!indexer) {
      indexer = new TsMorphIndexer(projectPath, sourceDirs);
      this.indexers.set(projectAlias, indexer);
      this.projectPaths.set(projectAlias, projectPath);
    }

    const manifest = loadManifest(manifestPath);
    let nodesAdded = 0;
    let nodesUpdated = 0;
    let nodesDeleted = 0;
    let edgesAdded = 0;

    try {
      const { ArangoClient } = await import("../arango-client.js");
      const arango = new ArangoClient(
        process.env.ARANGO_HOST || "http://localhost:8529",
        process.env.ARANGO_USER || "root",
        process.env.ARANGO_PASS || "",
        process.env.ARANGO_DB || "code_intel"
      );

      // Step 1: Handle deleted files — remove files from ts-morph + ArangoDB
      if (deleted.length > 0) {
        for (const relPath of deleted) {
          const absPath = join(projectPath, relPath);
          indexer.removeFile(absPath);
        }
        nodesDeleted = await arango.deleteProjectFiles(projectAlias, deleted);
        console.error(`[incremental-reindexer] Deleted ${nodesDeleted} nodes for ${deleted.length} files`);
      }

      // Step 2: Parse changed/added files with TsMorphIndexer
      if (allAffected.length > 0) {
        const absPaths = allAffected.map((rel) => join(projectPath, rel));

        console.error(
          `[incremental-reindexer] Parsing ${allAffected.length} files with ts-morph: ` +
          `${changed.length} changed, ${added.length} added`
        );

        const parseResult = indexer.parseFiles(projectPath, absPaths);

        console.error(
          `[incremental-reindexer] ts-morph parse: ${parseResult.methods.length} methods, ` +
          `${parseResult.edges.length} edges from ${parseResult.filesParsed} files ` +
          `(${parseResult.filesFailed} failed)`
        );

        // Step 2a: Delete old nodes for changed files (clean slate before re-insert)
        // This handles renames, line shifts, deleted functions
        const oldNodesDeleted = await arango.deleteProjectFiles(projectAlias, allAffected);
        if (oldNodesDeleted > 0) {
          console.error(`[incremental-reindexer] Deleted ${oldNodesDeleted} old nodes for ${allAffected.length} files`);
        }
        nodesDeleted += oldNodesDeleted;

        // Step 2b: Upsert method nodes
        if (parseResult.methods.length > 0) {
          const nodes = indexer.methodsToNodes(parseResult.methods, projectAlias, projectPath);
          const nodeResult = await arango.upsertNodes(nodes);
          nodesAdded = nodeResult.added;
          nodesUpdated = nodeResult.updated;
          console.error(
            `[incremental-reindexer] Node upsert: added=${nodesAdded}, updated=${nodesUpdated}`
          );
        }

        // Step 2c: Delete old edges for affected files, then insert new edges
        if (parseResult.edges.length > 0) {
          // Delete old edges involving these files
          const deletedEdgeCount = await arango.deleteEdgesForFiles(projectAlias, allAffected);
          console.error(`[incremental-reindexer] Deleted ${deletedEdgeCount} old edges for ${allAffected.length} files`);

          // Insert new edges
                    // Build method→line map for edge key resolution
          const methodLineMap = new Map<string, number>();
          for (const m of parseResult.methods) {
            methodLineMap.set(m.name, m.lineNumber);
          }
          const edges = indexer.edgesToCpgEdges(parseResult.edges, projectAlias, methodLineMap);
          if (edges.length > 0) {
            const edgeResult = await arango.upsertEdges(edges);
            edgesAdded = edgeResult.added;
            console.error(`[incremental-reindexer] Edge upsert: added=${edgesAdded}`);
          }
        } else {
          // Still delete old edges to keep graph clean
          const deletedEdgeCount = await arango.deleteEdgesForFiles(projectAlias, allAffected);
          if (deletedEdgeCount > 0) {
            console.error(`[incremental-reindexer] Cleaned up ${deletedEdgeCount} stale edges`);
          }
        }
      }

      // Step 3: Update manifest
      if (manifest) {
        const updatedManifest = this.updateManifestHashes(
          manifest, projectPath, allAffected, deleted
        );
        saveManifest(manifestPath, updatedManifest);
      }

      const elapsed = Date.now() - startTime;
      console.error(
        `[incremental-reindexer] Reindex complete for ${projectAlias}: ` +
        `${nodesAdded} added, ${nodesUpdated} updated, ${nodesDeleted} deleted, ` +
        `${edgesAdded} edges (${elapsed}ms)`
      );

      return {
        success: true,
        alias: projectAlias,
        reindexType: allAffected.length > 0 && deleted.length > 0 ? "full" : "incremental",
        filesProcessed: allAffected.length + deleted.length,
        nodesAdded,
        nodesUpdated,
        nodesDeleted,
        edgesAdded,
        importDurationMs: elapsed,
        totalDurationMs: elapsed,
      };
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error(`[incremental-reindexer] reindex failed: ${error}`);
      return {
        success: false,
        alias: projectAlias,
        reindexType: "incremental",
        filesProcessed: allAffected.length + deleted.length,
        nodesAdded: 0,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesAdded: 0,
        importDurationMs: elapsed,
        totalDurationMs: elapsed,
        error: String(error),
      };
    }
  }

  /**
   * Full reindex: recompute ALL edges across all indexed files.
   * Use this for a complete call graph refresh. Methods are already in ArangoDB
   * from incremental updates — we only need to rebuild edges.
   */
  async fullReindexAllEdges(
    projectAlias: string,
    projectPath: string,
    sourceDirs: string[]
  ): Promise<ReindexResult> {
    const startTime = Date.now();

    let indexer = this.indexers.get(projectAlias);
    if (!indexer) {
      indexer = new TsMorphIndexer(projectPath, sourceDirs);
      this.indexers.set(projectAlias, indexer);
      this.projectPaths.set(projectAlias, projectPath);
    }

    try {
      const { ArangoClient } = await import("../arango-client.js");
      const arango = new ArangoClient(
        process.env.ARANGO_HOST || "http://localhost:8529",
        process.env.ARANGO_USER || "root",
        process.env.ARANGO_PASS || "",
        process.env.ARANGO_DB || "code_intel"
      );

      console.error(`[incremental-reindexer] Full edge recompute for ${projectAlias}...`);

      // Delete all existing edges for this project
      await arango.deleteProjectEdges(projectAlias);

      // Recompute all edges from ts-morph
      const allEdges = indexer.recomputeAllEdges(projectPath);
      console.error(`[incremental-reindexer] Full edge recompute: ${allEdges.length} edges found`);

      let edgesAdded = 0;
      if (allEdges.length > 0) {
                const methodLineMap = indexer.getAllMethodLineNumbers(projectPath);
        const edges = indexer.edgesToCpgEdges(allEdges, projectAlias, methodLineMap);
        if (edges.length > 0) {
          const edgeResult = await arango.upsertEdges(edges);
          edgesAdded = edgeResult.added;
        }
      }

      const elapsed = Date.now() - startTime;
      console.error(
        `[incremental-reindexer] Full edge recompute complete for ${projectAlias}: ` +
        `${edgesAdded} edges (${elapsed}ms)`
      );

      return {
        success: true,
        alias: projectAlias,
        reindexType: "full",
        filesProcessed: 0,
        nodesAdded: 0,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesAdded,
        importDurationMs: elapsed,
        totalDurationMs: elapsed,
      };
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error(`[incremental-reindexer] Full edge recompute failed: ${error}`);
      return {
        success: false,
        alias: projectAlias,
        reindexType: "full",
        filesProcessed: 0,
        nodesAdded: 0,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesAdded: 0,
        importDurationMs: elapsed,
        totalDurationMs: elapsed,
        error: String(error),
      };
    }
  }

  private updateManifestHashes(
    manifest: FileManifest,
    projectPath: string,
    changedAndAdded: string[],
    deleted: string[]
  ): FileManifest {
    const updated = { ...manifest };
    updated.fileHashes = { ...manifest.fileHashes };

    for (const relPath of changedAndAdded) {
      const absPath = join(projectPath, relPath);
      try {
        updated.fileHashes[relPath] = computeFileHash(readFileSync(absPath, "utf-8"));
      } catch {
        updated.fileHashes[relPath] = "DELETED";
      }
    }

    for (const relPath of deleted) {
      delete updated.fileHashes[relPath];
    }

    updated.indexedAt = new Date().toISOString();
    return updated;
  }
}
