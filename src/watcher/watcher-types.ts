/**
 * watcher-types.ts — Shared type definitions for the automatic re-indexer.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Change event types
// ─────────────────────────────────────────────────────────────────────────────

export type FileEventType = "add" | "change" | "unlink";

export interface FileChange {
  /** Relative path from project root, e.g. "src/auth/login.ts" */
  relativePath: string;
  eventType: FileEventType;
  /** Absolute path to the file */
  absolutePath: string;
  /** When the event was detected */
  detectedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Change detection results
// ─────────────────────────────────────────────────────────────────────────────

export interface ChangeDetectionResult {
  /** Files that existed but were modified */
  changed: string[];
  /** New files that didn't exist during last index */
  added: string[];
  /** Files that were deleted since last index */
  deleted: string[];
  /** True if git HEAD moved (new commit, checkout, etc.) */
  gitHeadMoved: boolean;
  /** Current git HEAD hash (empty string if not a git repo) */
  currentGitHead: string;
  /** True if the working tree has uncommitted changes */
  workingTreeDirty: boolean;
  /** Human-readable summary for debugging */
  summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-index request
// ─────────────────────────────────────────────────────────────────────────────

export interface ReindexRequest {
  alias: string;
  projectPath: string;
  sourceDirs: string[];
  language: string;
  manifestPath: string;
  batch: {
    changed: string[];
    added: string[];
    deleted: string[];
  };
  /** Unix timestamp when the batch was queued */
  queuedAt: string;
  /** Unix timestamp when re-indexing should start (after debounce) */
  triggerAt: number;
}

export interface ReindexResult {
  success: boolean;
  alias: string;
  /** What type of re-index was performed */
  reindexType: "full" | "incremental" | "unchanged";
  /** Number of files that changed in this run */
  filesProcessed: number;
  /** New nodes added to the graph */
  nodesAdded: number;
  /** Existing nodes updated */
  nodesUpdated: number;
  /** Nodes removed from the graph */
  nodesDeleted: number;
  /** New edges added */
  edgesAdded: number;
  /** ArangoDB import duration in ms */
  importDurationMs: number;
  /** Overall duration in ms */
  totalDurationMs: number;
  /** Error message if success is false */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Watcher status (for MCP tool response)
// ─────────────────────────────────────────────────────────────────────────────

export interface WatcherStatus {
  /** Whether the background watcher loop is running */
  watcherRunning: boolean;
  /** Number of projects being watched */
  watchedProjectCount: number;
  /** Total pending re-index batches across all projects */
  pendingBatchCount: number;
  /** Number of projects with interrupted re-index needing recovery */
  interruptedCount: number;
  /** Current watcher settings */
  settings: {
    autoIndexEnabled: boolean;
    debounceMs: number;
    pollIntervalMs: number;
    ignorePatterns: string[];
  };
  /** Per-project status summary */
  projects: ProjectWatcherStatus[];
}

export interface ProjectWatcherStatus {
  alias: string;
  projectPath: string;
  isGitRepo: boolean;
  lastIndexedAt: string | null;
  lastGitHead: string;
  reindexInProgress: boolean;
  pendingFiles: string[];
  /** Approximate number of source files in the project */
  approximateFileCount: number;
  /** "idle" | "pending" | "indexing" | "recovering" | "error" */
  state: "idle" | "pending" | "indexing" | "recovering" | "error";
  lastError?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debounce queue
// ─────────────────────────────────────────────────────────────────────────────

export interface DebounceQueueItem {
  relativePath: string;
  eventType: FileEventType;
  addedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recovery batch (for crash-interrupted re-indexes)
// ─────────────────────────────────────────────────────────────────────────────

export interface RecoveryBatch {
  changed: string[];
  added: string[];
  deleted: string[];
  startedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC message types — shared between MCP server parent and watcher child
// ─────────────────────────────────────────────────────────────────────────────

export interface IpcMessage {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface IpcResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export type IpcEvent =
  | { type: "initialized"; sessionId: string; watcherPid: number }
  | { type: "reindex_complete"; alias: string; result: ReindexResult }
  | { type: "watcher_error"; alias: string; error: string }
  | { type: "status_snapshot"; status: WatcherStatus }
  | { type: "heartbeat"; watcherPid: number; uptimeSeconds: number };

// Socket path per session
export const IPC_SOCKET_PATH = (sessionId: string) =>
  `/tmp/code-intel-${sessionId}.sock`;