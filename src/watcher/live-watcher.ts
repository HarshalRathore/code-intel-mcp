/**
 * live-watcher.ts — In-process file watcher with manifest diff safety net.
 *
 * Architecture (Option A+B Hybrid):
 * - B: chokidar watches source dirs in the MCP server process
 * - A: Before each query, manifest diff catches files the watcher may have missed
 * - No daemon, no IPC, no Unix sockets, no session state files
 * - Crash recovery is automatic — next query triggers manifest diff
 *
 * This replaces the entire daemon+IPC+watcher-service architecture.
 */

import chokidar, { type FSWatcher } from "chokidar";
import { join, extname, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { IncrementalReindexer } from "./incremental-reindexer.js";
import {
  computeManifestHashes,
  diffManifests,
  loadManifest,
  saveManifest,
  type FileManifest,
} from "../manifest.js";

const JS_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const DEBOUNCE_MS = 2000;

function isSourceFile(filePath: string): boolean {
  return JS_EXTENSIONS.has(extname(filePath));
}

export interface WatchedProject {
  projectPath: string;
  alias: string;
  sourceDirs: string[];
  language: string;
  manifestPath: string;
}

interface DirtyBatch {
  changed: Set<string>;
  added: Set<string>;
  deleted: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  reindexing: boolean;
}

export class LiveWatcher {
  private joernCliPath: string;
  private reindexer: IncrementalReindexer;
  private watchers: Map<string, FSWatcher> = new Map();
  private projects: Map<string, WatchedProject> = new Map();
  private dirty: Map<string, DirtyBatch> = new Map();
  private shuttingDown: boolean = false;
  private reindexingAliases: Set<string> = new Set();

  constructor(joernCliPath: string) {
    this.joernCliPath = joernCliPath;
    this.reindexer = new IncrementalReindexer(joernCliPath);
  }

  watchProject(
    projectPath: string,
    alias: string,
    sourceDirs: string[],
    language: string
  ): void {
    const manifestDir = join(projectPath, ".code-intel");
    const manifestPath = join(manifestDir, "manifest.json");

    const project: WatchedProject = {
      projectPath,
      alias,
      sourceDirs,
      language,
      manifestPath,
    };

    this.projects.set(alias, project);
    this.dirty.set(alias, {
      changed: new Set(),
      added: new Set(),
      deleted: new Set(),
      timer: null,
      reindexing: false,
    });

    this.startWatcher(alias, project);
    console.error(`[live-watcher] Watching project: ${alias} (${projectPath})`);
  }

  unwatchProject(alias: string): void {
    const watcher = this.watchers.get(alias);
    if (watcher) {
      watcher.close().catch(() => {});
      this.watchers.delete(alias);
    }
    const batch = this.dirty.get(alias);
    if (batch?.timer) clearTimeout(batch.timer);
    this.dirty.delete(alias);
    this.projects.delete(alias);
    console.error(`[live-watcher] Stopped watching: ${alias}`);
  }

  getStatus(): {
    watchedProjects: string[];
    watcherRunning: boolean;
  } {
    return {
      watchedProjects: Array.from(this.projects.keys()),
      watcherRunning: this.watchers.size > 0,
    };
  }

  getProjectList(): WatchedProject[] {
    return Array.from(this.projects.values());
  }

  /**
   * Ensure freshness before a query — manifest diff safety net.
   * Called by index.ts before serving query results.
   * If the watcher missed changes (crash, slow fs events), this catches them.
   */
  async ensureFresh(alias: string): Promise<void> {
    const project = this.projects.get(alias);
    if (!project) return;

    if (this.reindexingAliases.has(alias)) {
      console.error(`[live-watcher] Reindex already in progress for ${alias} — serving cached data`);
      return;
    }

    const manifest = loadManifest(project.manifestPath);
    if (!manifest) return;

    const currentHashes = computeManifestHashes(project.projectPath, project.sourceDirs);
    const diff = diffManifests(manifest.fileHashes, currentHashes);

    if (diff.added.length === 0 && diff.modified.length === 0 && diff.deleted.length === 0) {
      return;
    }

    console.error(
      `[live-watcher] Manifest drift detected for ${alias}: ` +
        `${diff.added.length} added, ${diff.modified.length} modified, ${diff.deleted.length} deleted`
    );

    await this.runReindex(alias, diff.modified, diff.added, diff.deleted);
  }

  /**
   * Force reindex — manual trigger or debounce flush.
   */
  async triggerReindex(
    projectPath: string,
    alias: string,
    sourceDirs: string[],
    language: string,
    full: boolean = false
  ): Promise<import("./watcher-types.js").ReindexResult> {
    const manifestDir = join(projectPath, ".code-intel");
    const manifestPath = join(manifestDir, "manifest.json");

    if (full) {
      // Full reindex: rebuild ALL call graph edges using ts-morph.
      // Methods are already in ArangoDB from incremental updates.
      console.error(`[live-watcher] Full edge recompute triggered for ${alias}`);
      return await this.reindexer.fullReindexAllEdges(alias, projectPath, sourceDirs);
    }

    const batch = this.dirty.get(alias);
    if (!batch) {
      return {
        success: true,
        alias,
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

    const changed = [...batch.changed];
    const added = [...batch.added];
    const deleted = [...batch.deleted];
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = null;
    batch.changed.clear();
    batch.added.clear();
    batch.deleted.clear();

    if (changed.length === 0 && added.length === 0 && deleted.length === 0) {
      return {
        success: true,
        alias,
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

    return this.runReindex(alias, changed, added, deleted);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    for (const [alias, batch] of this.dirty) {
      if (batch.timer) clearTimeout(batch.timer);
      if (batch.changed.size + batch.added.size + batch.deleted.size > 0) {
        const project = this.projects.get(alias);
        if (project) {
          await this.runReindex(
            alias,
            [...batch.changed],
            [...batch.added],
            [...batch.deleted]
          );
        }
      }
    }

    for (const [alias, watcher] of this.watchers) {
      await watcher.close();
    }
    this.watchers.clear();
    console.error("[live-watcher] Shutdown complete");
  }

  private startWatcher(alias: string, project: WatchedProject): void {
    const watchPaths = project.sourceDirs
      .map(d => join(project.projectPath, d))
      .filter(p => existsSync(p));

    if (watchPaths.length === 0) {
      console.error(`[live-watcher][${alias}] No source dirs to watch`);
      return;
    }

    const watcher = chokidar.watch(watchPaths, {
      persistent: true,
      followSymlinks: false,
      depth: 99,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
      ignored: [
        /node_modules/,
        /dist/,
        /\.git/,
        /\.next/,
        /\.code-intel/,
        /coverage/,
        /\.d\.ts$/,
      ],
      usePolling: false,
      interval: 1000,
      binaryInterval: 3000,
    });

    watcher
      .on("add", (absPath: string) => this.handleEvent(alias, "add", absPath))
      .on("change", (absPath: string) => this.handleEvent(alias, "change", absPath))
      .on("unlink", (absPath: string) => this.handleEvent(alias, "unlink", absPath))
      .on("error", (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[live-watcher][${alias}] Watcher error: ${msg}`);
      });

    this.watchers.set(alias, watcher);
  }

  private handleEvent(
    alias: string,
    eventType: "add" | "change" | "unlink",
    absolutePath: string
  ): void {
    if (this.shuttingDown) return;

    const project = this.projects.get(alias);
    if (!project) return;

    if (!isSourceFile(absolutePath)) return;

    const relPath = absolutePath.replace(project.projectPath + "/", "");
    const batch = this.dirty.get(alias);
    if (!batch) return;

    switch (eventType) {
      case "add":
        batch.added.add(relPath);
        batch.changed.delete(relPath);
        break;
      case "change":
        if (!batch.added.has(relPath)) {
          batch.changed.add(relPath);
        }
        break;
      case "unlink":
        batch.added.delete(relPath);
        batch.changed.delete(relPath);
        batch.deleted.add(relPath);
        break;
    }

    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      this.flushBatch(alias);
    }, DEBOUNCE_MS);
  }

  private async flushBatch(alias: string): Promise<void> {
    const batch = this.dirty.get(alias);
    if (!batch || batch.reindexing) return;

    const changed = [...batch.changed];
    const added = [...batch.added];
    const deleted = [...batch.deleted];

    batch.changed.clear();
    batch.added.clear();
    batch.deleted.clear();
    batch.timer = null;

    if (changed.length === 0 && added.length === 0 && deleted.length === 0) return;

    await this.runReindex(alias, changed, added, deleted);
  }

  private async runReindex(
    alias: string,
    changed: string[],
    added: string[],
    deleted: string[]
  ): Promise<import("./watcher-types.js").ReindexResult> {
    const project = this.projects.get(alias);
    if (!project) {
      return {
        success: false,
        alias,
        reindexType: "incremental",
        filesProcessed: 0,
        nodesAdded: 0,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesAdded: 0,
        importDurationMs: 0,
        totalDurationMs: 0,
        error: "Project not found",
      };
    }

    const batch = this.dirty.get(alias);
    if (batch) batch.reindexing = true;
    this.reindexingAliases.add(alias);

    try {
      console.error(
        `[live-watcher] Reindexing ${alias}: ${changed.length} changed, ${added.length} added, ${deleted.length} deleted`
      );

      const result = await this.reindexer.reindex(
        project.projectPath,
        project.alias,
        project.manifestPath,
        project.language,
        project.sourceDirs,
        changed,
        added,
        deleted
      );

      if (result.success) {
        console.error(
          `[live-watcher] Reindex complete for ${alias}: ${result.nodesAdded} added, ${result.nodesUpdated} updated, ${result.nodesDeleted} deleted, ${result.edgesAdded} edges (${result.totalDurationMs}ms)`
        );
      } else {
        console.error(`[live-watcher] Reindex failed for ${alias}: ${result.error}`);
      }

      return result;
    } finally {
      if (batch) batch.reindexing = false;
      this.reindexingAliases.delete(alias);
    }
  }
}