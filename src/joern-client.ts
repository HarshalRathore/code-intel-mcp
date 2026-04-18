import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { transpileProject } from "./babel-transpiler.js";

const execFileAsync = promisify(execFile);

const JOERN_TIMEOUT = 300000;

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

export interface CpgMethod {
  name: string;
  filename: string;
  lineNumber: number;
  code: string;
}

export interface CpgCallEdge {
  callerName: string;
  calleeName: string;
  callCode: string;
}

export class JoernClient {
  private cliPath: string;

  constructor(cliPath: string) {
    this.cliPath = cliPath;
  }

  async parseProject(
    projectPath: string,
    language: string,
    sourceDirs: string[] = ["src"]
  ): Promise<{ cpgBinPath: string; nodeCount: number; edgeCount: number }> {
    const outputDir = join(projectPath, ".code-intel");
    const cpgBinPath = join(outputDir, "cpg.bin");

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    let parseDir: string;
    let transpileDir: string | null = null;
    let tempSymlinkDir: string | null = null;

    if (language === "jssrc" || language === "javascript") {
      const transpileResult = transpileProject(projectPath, sourceDirs);
      parseDir = transpileResult.transpiledDir;
      transpileDir = transpileResult.transpiledDir;
      console.error(`[code-intel] Transpiled ${transpileResult.transpiledFiles} files, skipped ${transpileResult.skippedFiles}`);
    } else {
      const tmpDir = mkdtempSync(join(tmpdir(), "joern-src-"));
      for (const dir of sourceDirs) {
        const srcDir = join(projectPath, dir);
        if (existsSync(srcDir)) {
          symlinkSync(srcDir, join(tmpDir, dir));
        }
      }
      parseDir = tmpDir;
      tempSymlinkDir = tmpDir;
    }

    try {
      const args = [parseDir, "-o", cpgBinPath, "--language", language];
      const { stdout, stderr } = await execFileAsync(
        join(this.cliPath, "bin", "joern-parse"),
        args,
        { timeout: JOERN_TIMEOUT, maxBuffer: 50 * 1024 * 1024 }
      );

      if (!existsSync(cpgBinPath)) {
        throw new Error(`CPG binary not created at ${cpgBinPath}. stderr: ${stderr}\nstdout: ${stdout}`);
      }

      const methods = await this.getMethods(cpgBinPath);
      const callEdges = await this.getCallEdges(cpgBinPath);
      return {
        cpgBinPath,
        nodeCount: methods.length,
        edgeCount: callEdges.length,
      };
    } finally {
      if (transpileDir) {
        try {
          rmSync(transpileDir, { recursive: true, force: true });
        } catch {}
      }
      if (tempSymlinkDir) {
        try {
          rmSync(tempSymlinkDir, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  async query(cpgBinPath: string, cpgqlQuery: string): Promise<string> {
    const scriptContent = `importCpg("${cpgBinPath}")\nval result = ${cpgqlQuery}\nprintln("RESULT_START")\nresult.foreach(println)\nprintln("RESULT_END")\n`;
    const tmpDir = mkdtempSync(join(tmpdir(), "joern-"));
    const scriptPath = join(tmpDir, "query.sc");

    try {
      writeFileSync(scriptPath, scriptContent);

      const { stdout, stderr } = await execFileAsync(
        join(this.cliPath, "joern"),
        ["--script", scriptPath],
        { timeout: JOERN_TIMEOUT, maxBuffer: 50 * 1024 * 1024 }
      );

      const cleaned = stripAnsi(stdout);
      const startIdx = cleaned.indexOf("RESULT_START");
      const endIdx = cleaned.indexOf("RESULT_END");

      if (startIdx === -1 || endIdx === -1) {
        return cleaned;
      }

      return cleaned.substring(startIdx + "RESULT_START".length, endIdx).trim();
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  async getMethods(cpgBinPath: string): Promise<CpgMethod[]> {
    const q = `cpg.method.map(m => m.name + "||" + m.filename + "||" + m.lineNumber.getOrElse(0) + "||" + m.code.replaceAll("\\n", " ").replaceAll("\\r", " ").take(200)).l`;
    const output = await this.query(cpgBinPath, q);

    const results: CpgMethod[] = [];
    const lines = output.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const firstPipe = trimmed.indexOf("||");
      const secondPipe = trimmed.indexOf("||", firstPipe + 2);
      const thirdPipe = trimmed.indexOf("||", secondPipe + 2);
      if (firstPipe !== -1 && secondPipe !== -1 && thirdPipe !== -1) {
        const name = trimmed.substring(0, firstPipe).trim();
        const filename = trimmed.substring(firstPipe + 2, secondPipe).trim();
        const lineNumber = parseInt(trimmed.substring(secondPipe + 2, thirdPipe).trim(), 10) || 0;
        const code = trimmed.substring(thirdPipe + 2).trim();
        results.push({ name, filename, lineNumber, code });
      } else if (firstPipe !== -1 && secondPipe !== -1) {
        const name = trimmed.substring(0, firstPipe).trim();
        const filename = trimmed.substring(firstPipe + 2, secondPipe).trim();
        const lineNumber = parseInt(trimmed.substring(secondPipe + 2).trim(), 10) || 0;
        results.push({ name, filename, lineNumber, code: "" });
      }
    }
    return results;
  }

  async getCallEdges(cpgBinPath: string): Promise<CpgCallEdge[]> {
    const q = `cpg.method.filterNot(m => m.name.startsWith("<") || m.name == ":program").flatMap(m => m.callee.filterNot(c => c.name.startsWith("<") || c.name == ":program").map(c => m.name + "||" + c.name)).dedup.l`;
    const output = await this.query(cpgBinPath, q);

    const results: CpgCallEdge[] = [];
    const lines = output.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("||");
      if (parts.length >= 2) {
        const callerName = parts[0].trim();
        const calleeName = parts[1].trim();
        results.push({ callerName, calleeName, callCode: "" });
      }
    }
    return results;
  }

  async getMethodNames(cpgBinPath: string): Promise<string[]> {
    const methods = await this.getMethods(cpgBinPath);
    return methods.map(m => m.name);
  }

  async getMethodCallers(cpgBinPath: string, methodName: string): Promise<Array<{ caller: string; file: string; line: number }>> {
    const q = `cpg.method.name("${methodName}").caller.map(m => m.name + "||" + m.filename + "||" + m.lineNumber.getOrElse(0)).l`;
    const output = await this.query(cpgBinPath, q);

    const results: Array<{ caller: string; file: string; line: number }> = [];
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("||");
      if (parts.length >= 3) {
        results.push({
          caller: parts[0].trim(),
          file: parts[1].trim(),
          line: parseInt(parts[2].trim(), 10) || 0,
        });
      }
    }
    return results;
  }

  async getMethodCallees(cpgBinPath: string, methodName: string): Promise<Array<{ callee: string; file: string; line: number }>> {
    const q = `cpg.method.name("${methodName}").callee.map(m => m.name + "||" + m.filename + "||" + m.lineNumber.getOrElse(0)).l`;
    const output = await this.query(cpgBinPath, q);

    const results: Array<{ callee: string; file: string; line: number }> = [];
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("||");
      if (parts.length >= 3) {
        results.push({
          callee: parts[0].trim(),
          file: parts[1].trim(),
          line: parseInt(parts[2].trim(), 10) || 0,
        });
      }
    }
    return results;
  }

  async getJsxComponents(cpgBinPath: string): Promise<{ jsxComponents: string[]; hookUsages: Array<{ hookName: string; filePath: string; lineNumber: number }> }> {
    // Query for PascalCase methods (React components like AddonDialog, ProductAddonsPage, etc.)
    const jsxQuery = `cpg.method.name("[A-Z].*").name.l`;
    const jsxOutput = await this.query(cpgBinPath, jsxQuery);
    
    // Query for hook definitions (useAuth, useState, etc.)
    const hookQuery = `cpg.method.name("use.*").map(m => m.name + "||" + m.filename + "||" + m.lineNumber.getOrElse(0)).l`;
    const hookOutput = await this.query(cpgBinPath, hookQuery);
    
    // Parse JSX components (PascalCase method names)
    const jsxComponents: string[] = [];
    for (const line of jsxOutput.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // PascalCase method names are React components
      jsxComponents.push(trimmed);
    }
    
    // Parse hook definitions with file/line info
    const hookUsages: Array<{ hookName: string; filePath: string; lineNumber: number }> = [];
    for (const line of hookOutput.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("||");
      if (parts.length >= 3) {
        hookUsages.push({
          hookName: parts[0].trim(),
          filePath: parts[1].trim(),
          lineNumber: parseInt(parts[2].trim(), 10) || 0,
        });
      }
    }
    
    return { jsxComponents, hookUsages };
  }

  async computeCpgBinHash(cpgBinPath: string): Promise<string> {
    try {
      const content = readFileSync(cpgBinPath);
      return createHash("sha256").update(content).digest("hex").substring(0, 16);
    } catch {
      return "";
    }
  }
}

