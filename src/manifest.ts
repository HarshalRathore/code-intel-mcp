import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";

export interface FileManifest {
  projectPath: string;
  projectAlias: string;
  indexedAt: string;
  fileHashes: Record<string, string>;
  sourceDirs: string[];
  language: string;
  totalNodes: number;
  totalEdges: number;
  cpgBinHash: string;
}

const JS_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

export function computeFileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

export function collectSourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile() && JS_EXTENSIONS.has(extname(entry.name))) files.push(fullPath);
      }
    } catch {}
  }
  walk(rootDir);
  return files;
}

export function computeManifestHashes(projectPath: string, sourceDirs: string[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const dir of sourceDirs) {
    const srcDir = join(projectPath, dir);
    if (!existsSync(srcDir)) continue;
    const files = collectSourceFiles(srcDir);
    for (const file of files) {
      const relPath = file.replace(projectPath + "/", "");
      try { hashes[relPath] = computeFileHash(readFileSync(file, "utf-8")); }
      catch { hashes[relPath] = "DELETED"; }
    }
  }
  return hashes;
}

export function diffManifests(
  oldHashes: Record<string, string>,
  newHashes: Record<string, string>
): { added: string[]; modified: string[]; deleted: string[]; unchanged: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const unchanged: string[] = [];
  for (const [file, hash] of Object.entries(newHashes)) {
    if (hash === "DELETED") continue;
    if (!(file in oldHashes)) added.push(file);
    else if (oldHashes[file] !== hash) modified.push(file);
    else unchanged.push(file);
  }
  for (const file of Object.keys(oldHashes)) {
    if (!(file in newHashes) || newHashes[file] === "DELETED") deleted.push(file);
  }
  return { added, modified, deleted, unchanged };
}

export function loadManifest(manifestPath: string): FileManifest | null {
  if (!existsSync(manifestPath)) return null;
  try { return JSON.parse(readFileSync(manifestPath, "utf-8")); }
  catch { return null; }
}

export function saveManifest(manifestPath: string, manifest: FileManifest): void {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}
