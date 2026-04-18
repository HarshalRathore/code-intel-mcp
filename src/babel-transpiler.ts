import { transformSync } from "@babel/core";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative, dirname } from "node:path";
import { tmpdir } from "node:os";

const TSX_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js", ".mjs", ".cjs"]);

export interface TranspileResult {
  transpiledDir: string;
  transpiledFiles: number;
  skippedFiles: number;
}

export function transpileProject(
  projectPath: string,
  sourceDirs: string[]
): TranspileResult {
  const transpiledDir = mkdtempSync(join(tmpdir(), "code-intel-transpile-"));
  let transpiledFiles = 0;
  let skippedFiles = 0;

  for (const dir of sourceDirs) {
    const srcDir = join(projectPath, dir);
    if (!existsSync(srcDir)) continue;

    const files = collectFiles(srcDir);
    for (const file of files) {
      const ext = extname(file);
      const relPath = relative(projectPath, file);
      const outPath = join(transpiledDir, relPath);

      mkdirSync(dirname(outPath), { recursive: true });

      if (TSX_EXTENSIONS.has(ext)) {
        try {
          const code = readFileSync(file, "utf-8");
          const result = transformSync(code, {
            presets: [
              ["@babel/preset-react", { runtime: "classic" }],
              "@babel/preset-typescript"
            ],
            filename: file,
            configFile: false,
            babelrc: false,
            sourceMaps: false,
            compact: false,
          });
          writeFileSync(outPath.replace(/\.(tsx?|jsx?)$/, ".js"), result!.code!, "utf-8");
          transpiledFiles++;
        } catch {
          cpSync(file, outPath);
          skippedFiles++;
        }
      } else {
        cpSync(file, outPath);
        skippedFiles++;
      }
    }
  }

  return { transpiledDir, transpiledFiles, skippedFiles };
}

function collectFiles(dir: string, files: string[] = []): string[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectFiles(fullPath, files);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  } catch {}
  return files;
}
