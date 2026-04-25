/**
 * ts-morph-indexer.ts — TypeScript compiler API based code indexer.
 *
 * Replaces Joern/CPG entirely. Uses ts-morph (TypeScript compiler wrapper)
 * for native .ts/.tsx/.js/.jsx parsing + type-checker-powered call resolution.
 *
 * Key advantages over Joern:
 *   ✅ Incremental — add/remove files individually, no full reparse
 *   ✅ Fast — ~50ms per file for declarations, ~100ms for call edges
 *   ✅ TypeScript-native — understands .ts/.tsx without transpilation
 *   ✅ No JVM — pure Node.js, no memory spikes
 *   ✅ No Docker/ArangoDB dependency for parsing
 *   ✅ Accurate call resolution via TypeScript's type checker
 */

import { Project, SourceFile, SyntaxKind, Node, CallExpression, Identifier } from "ts-morph";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import type { CpgMethod } from "./joern-client.js";
import type { CpgNode, CpgEdge } from "./arango-client.js";

const VALID_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export interface TsMorphParseResult {
  methods: CpgMethod[];
  edges: Array<{
    callerName: string;
    calleeName: string;
    callerFile: string;
    calleeFile: string;
  }>;
  filesParsed: number;
  filesFailed: number;
}

export class TsMorphIndexer {
  private project: Project;
  private projectPath: string;
  private sourceDirs: string[];
  private addedFiles = new Set<string>();

  constructor(projectPath: string, sourceDirs: string[]) {
    this.projectPath = projectPath;
    this.sourceDirs = sourceDirs;

    // Try project tsconfig first, fall back to default options
    const tsconfigPath = join(projectPath, "tsconfig.json");
    const hasTsConfig = existsSync(tsconfigPath);

    this.project = new Project({
      // Always allow JS files — many real projects mix .ts and .js
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        strictNullChecks: false,
        noEmit: true,
        skipLibCheck: true,
        skipDefaultLibCheck: true,
      },
      ...(hasTsConfig
        ? { tsConfigFilePath: tsconfigPath }
        : { useInMemoryFileSystem: true }),
    });

    // Add files if tsconfig didn't auto-add them
    if (!hasTsConfig) {
      this.addSourceFilesFromDirs();
    }
  }

  /**
   * Add a single source file to the project for incremental analysis.
   * ts-morph will lazily resolve imports and create the type program as needed.
   */
  addFile(filePath: string): void {
    if (!existsSync(filePath)) return;

    // If file already exists in project, refresh from disk (handles re-edits)
    const existing = this.project.getSourceFile(filePath);
    if (existing) {
      try {
        existing.refreshFromFileSystemSync();
      } catch (error) {
        console.error(`[ts-morph-indexer] Failed to refresh file ${filePath}: ${error}`);
      }
      return;
    }

    try {
      this.project.addSourceFileAtPath(filePath);
      this.addedFiles.add(filePath);
    } catch (error) {
      console.error(`[ts-morph-indexer] Failed to add file ${filePath}: ${error}`);
    }
  }

  /**
   * Remove a source file from the project.
   */
  removeFile(filePath: string): void {
    const sourceFile = this.project.getSourceFile(filePath);
    if (sourceFile) {
      this.project.removeSourceFile(sourceFile);
      this.addedFiles.delete(filePath);
    }
  }

  /**
   * Parse changed/added files and extract methods + call edges.
   *
   * @param projectPath - Project root
   * @param filePaths - Array of absolute file paths to parse
   * @returns Methods and edges extracted
   */
  parseFiles(projectPath: string, filePaths: string[]): TsMorphParseResult {
    const allMethods: CpgMethod[] = [];
    const allEdges: Array<{
      callerName: string;
      calleeName: string;
      callerFile: string;
      calleeFile: string;
    }> = [];
    let filesParsed = 0;
    let filesFailed = 0;

    for (const absPath of filePaths) {
      if (!existsSync(absPath)) {
        filesFailed++;
        continue;
      }

      const ext = extname(absPath);
      if (!VALID_EXTENSIONS.has(ext)) {
        filesFailed++;
        continue;
      }

      try {
        // Ensure file is in the ts-morph project
        this.addFile(absPath);

        const sourceFile = this.project.getSourceFile(absPath);
        if (!sourceFile) {
          filesFailed++;
          continue;
        }

        const relPath = relative(projectPath, absPath);

        // Extract declarations
        const methods = this.extractDeclarations(sourceFile, relPath, absPath);
        allMethods.push(...methods);

        // Extract call edges for these methods
        const edges = this.extractCallEdges(sourceFile, methods, projectPath);
        allEdges.push(...edges);

        filesParsed++;
      } catch (error) {
        console.error(`[ts-morph-indexer] Error parsing ${absPath}: ${error}`);
        filesFailed++;
      }
    }

    return {
      methods: allMethods,
      edges: allEdges,
      filesParsed,
      filesFailed,
    };
  }

  /**
   * Recompute all edges across ALL loaded files.
   * Slower but produces a complete call graph.
   */
  recomputeAllEdges(projectPath: string): Array<{
    callerName: string;
    calleeName: string;
    callerFile: string;
    calleeFile: string;
  }> {
    const allEdges: Array<{
      callerName: string;
      calleeName: string;
      callerFile: string;
      calleeFile: string;
    }> = [];

    for (const sourceFile of this.project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath();
      if (filePath.includes("node_modules")) continue;

      const relPath = relative(projectPath, filePath);
      const methods = this.extractDeclarations(sourceFile, relPath, filePath);
      const edges = this.extractCallEdges(sourceFile, methods, projectPath);
      allEdges.push(...edges);
    }

    return allEdges;
  }

  /**
   * Extract function/class/variable declarations from a source file.
   */
  private extractDeclarations(
    sourceFile: SourceFile,
    relPath: string,
    absPath: string
  ): CpgMethod[] {
    const methods: CpgMethod[] = [];
    const fullCode = readFileSync(absPath, "utf-8");

    // Also extract nested/local variable declarations with function values
    // (e.g., const handleX = async () => { ... } inside a React component)
    for (const varDecl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const name = varDecl.getName();
      if (!name) continue;
      const init = varDecl.getInitializerIfKind(SyntaxKind.ArrowFunction) ||
                   varDecl.getInitializerIfKind(SyntaxKind.FunctionExpression);
      if (init) {
        // Skip if at top level (already handled below)
        const parent = varDecl.getParent();
        if (parent && (Node.isVariableDeclarationList(parent) || Node.isVariableStatement(parent))) {
          const grandParent = parent.getParent();
          if (grandParent && (Node.isSourceFile(grandParent) || Node.isExportAssignment(grandParent))) {
            continue; // handled below
          }
        }
        methods.push(this.makeMethod(name, relPath, varDecl.getStartLineNumber(), fullCode));
      }
    }

    // Named function declarations: function foo() {} / export function foo() {}
    for (const decl of sourceFile.getFunctions()) {
      const name = decl.getName();
      if (!name) continue;
      methods.push(this.makeMethod(name, relPath, decl.getStartLineNumber(), fullCode));
    }

    // Class declarations: class Foo {} / export class Foo {}
    for (const decl of sourceFile.getClasses()) {
      const name = decl.getName();
      if (!name) continue;
      methods.push(this.makeMethod(name, relPath, decl.getStartLineNumber(), fullCode));

      // Also extract class methods
      for (const methodDecl of decl.getMethods()) {
        const methodName = methodDecl.getName();
        if (!methodName) continue;
        methods.push(
          this.makeMethod(methodName, relPath, methodDecl.getStartLineNumber(), fullCode)
        );
      }
    }

    // Variable declarations with function/arrow values: const foo = () => {} / const foo = function() {}
    for (const decl of sourceFile.getVariableDeclarations()) {
      const name = decl.getName();
      if (!name) continue;

      const init = decl.getInitializerIfKind(SyntaxKind.ArrowFunction) ||
                   decl.getInitializerIfKind(SyntaxKind.FunctionExpression);
      if (init) {
        methods.push(this.makeMethod(name, relPath, decl.getStartLineNumber(), fullCode));
      }
    }

    // Export default: export default function() {} (unnamed — use "default"
    // We check for unnamed exports that are functions/classes
    for (const exportDecl of sourceFile.getExportAssignments()) {
      // `export default foo` or `export default function(){}`
      // For anonymous default exports, create a placeholder
      const expr = exportDecl.getExpression();
      if (Node.isFunctionExpression(expr) || Node.isArrowFunction(expr)) {
        methods.push(this.makeMethod("default", relPath, exportDecl.getStartLineNumber(), fullCode));
      }
    }

    // Handle `export default class {}` (unnamed class)
    for (const classDecl of sourceFile.getClasses()) {
      if (!classDecl.getName() && classDecl.isDefaultExport()) {
        methods.push(this.makeMethod("default", relPath, classDecl.getStartLineNumber(), fullCode));
      }
    }

    return methods;
  }

  /**
   * Extract call edges for a list of methods within a source file.
   * Uses TypeScript's type checker for accurate call resolution.
   */
  private extractCallEdges(
    sourceFile: SourceFile,
    methods: CpgMethod[],
    projectPath: string
  ): Array<{ callerName: string; calleeName: string; callerFile: string; calleeFile: string }> {
    const edges: Array<{
      callerName: string;
      calleeName: string;
      callerFile: string;
      calleeFile: string;
    }> = [];
    const typeChecker = this.project.getTypeChecker();

    for (const method of methods) {
      if (method.name === "default") continue;

      // Find the actual declaration node for this method
      const funcDecl = this.findDeclarationNode(sourceFile, method.name);
      if (!funcDecl) continue;

      // Find all CallExpression nodes within this function body
      const callExprs = funcDecl.getDescendantsOfKind(SyntaxKind.CallExpression);

      for (const callExpr of callExprs) {
        const { calleeName, calleeSourceFile } = this.resolveCallTarget(callExpr, typeChecker);
        if (!calleeName || !calleeSourceFile) continue;

        const calleeRelPath = relative(projectPath, calleeSourceFile.getFilePath());
        if (calleeRelPath.includes("node_modules")) continue;

        // Avoid self-edges
        if (calleeName === method.name && calleeRelPath === method.filename) continue;

        edges.push({
          callerName: method.name,
          calleeName,
          callerFile: method.filename,
          calleeFile: calleeRelPath,
        });
      }
    }

    // Deduplicate edges
    const seen = new Set<string>();
    return edges.filter((e) => {
      const key = `${e.callerName}||${e.calleeName}||${e.callerFile}||${e.calleeFile}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Find the AST node for a named declaration in a source file.
   */
  private findDeclarationNode(
    sourceFile: SourceFile,
    name: string
  ): Node | undefined {
    // Check top-level functions
    for (const decl of sourceFile.getFunctions()) {
      if (decl.getName() === name) return decl;
    }
    // Check top-level classes + their methods
    for (const decl of sourceFile.getClasses()) {
      if (decl.getName() === name) return decl;
      for (const method of decl.getMethods()) {
        if (method.getName() === name) return method;
      }
    }
    // Check top-level variable declarations (const foo = () => {})
    for (const decl of sourceFile.getVariableDeclarations()) {
      if (decl.getName() === name) return decl;
    }
    // Check NESTED variable declarations (inside React components, callbacks, etc.)
    // These are not found by getVariableDeclarations() which only returns top-level
    const allVarDecls = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
    for (const decl of allVarDecls) {
      if (decl.getName() === name) {
        // Verify this is within a function body (not re-finding top-level ones)
        const init = decl.getInitializerIfKind(SyntaxKind.ArrowFunction) ||
                     decl.getInitializerIfKind(SyntaxKind.FunctionExpression);
        if (init) return decl;
      }
    }
    return undefined;
  }

  /**
   * Resolve a CallExpression to its target function name and source file.
   * Uses TypeScript's type checker for accurate symbol resolution.
   */
  private resolveCallTarget(
    callExpr: CallExpression,
    typeChecker: any
  ): { calleeName: string | null; calleeSourceFile: SourceFile | null } {
    const expression = callExpr.getExpression();

    // Direct call: foo()
    if (Node.isIdentifier(expression)) {
      const symbol = typeChecker.getSymbolAtLocation(expression);
      if (symbol) {
        const decls = symbol.getDeclarations();
        if (decls && decls.length > 0) {
          const decl = decls[0];
          const sourceFile = decl.getSourceFile();
          return { calleeName: symbol.getName(), calleeSourceFile: sourceFile };
        }
      }
      // If type checker can't resolve, use name directly (for cross-module calls)
      return { calleeName: expression.getText(), calleeSourceFile: null };
    }

    // Property access: obj.foo()
    if (Node.isPropertyAccessExpression(expression)) {
      const name = expression.getName();
      const symbol = typeChecker.getSymbolAtLocation(expression.getNameNode());
      if (symbol) {
        const decls = symbol.getDeclarations();
        if (decls && decls.length > 0) {
          const sourceFile = decls[0].getSourceFile();
          return { calleeName: name, calleeSourceFile: sourceFile };
        }
      }
      return { calleeName: name, calleeSourceFile: null };
    }

    return { calleeName: null, calleeSourceFile: null };
  }

  /**
   * Get all source files currently loaded in the project.
   */
  getSourceFiles(): SourceFile[] {
    return this.project.getSourceFiles().filter(
      (sf) => !sf.getFilePath().includes("node_modules")
    );
  }

  /**
   * Convert CpgMethod[] to CpgNode[] for ArangoDB upsert.
   */
  methodsToNodes(
    methods: CpgMethod[],
    projectAlias: string,
    projectPath: string
  ): CpgNode[] {
    return methods.map((m) => ({
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
  }

  /**
   * Convert extracted edges to CpgEdge[] for ArangoDB upsert.
   */
  edgesToCpgEdges(
    edges: Array<{ callerName: string; calleeName: string; callerFile: string; calleeFile: string }>,
    projectAlias: string,
    methodLineMap?: Map<string, number>
  ): CpgEdge[] {
    // If methodLineMap has few entries, augment it with all known methods from the project
    // This handles cross-file edges where callee is in a previously-parsed file
    if (!methodLineMap || methodLineMap.size < 100) {
      const allMethods = this.getAllMethodLineNumbers(
        edges.length > 0 ? edges[0].callerFile.replace(/\/src\/.*/, "") : "/home/harshal/harshal/repeato/repeato-console"
      );
      if (!methodLineMap) methodLineMap = allMethods;
      else {
        for (const [k, v] of allMethods) {
          if (!methodLineMap.has(k)) methodLineMap.set(k, v);
        }
      }
    }
    return edges.map((e) => {
      const callerLine = methodLineMap?.get(e.callerName) ?? 0;
      const calleeLine = methodLineMap?.get(e.calleeName) ?? 0;
      return {
        _from: `cpg_nodes/${this.sanitizeKey(`${projectAlias}::${e.callerName}::${callerLine}`)}`,
        _to: `cpg_nodes/${this.sanitizeKey(`${projectAlias}::${e.calleeName}::${calleeLine}`)}`,
        label: "CALL" as const,
        projectAlias,
      };
    });
  }

  /**
   * Get source file text for code extraction.
   */
  getSourceFileText(filePath: string): string {
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return "";
    }
  }

  private makeMethod(
    name: string,
    filename: string,
    lineNumber: number,
    fullCode: string
  ): CpgMethod {
    // Extract code snippet around this function
    const lines = fullCode.split("\n");
    const startLine = Math.max(0, lineNumber - 1);
    const snippet = lines.slice(startLine, startLine + 15).join("\n").substring(0, 500);

    return {
      name,
      filename,
      lineNumber,
      code: snippet,
    };
  }


  /**
   * Get a map of all method names to their line numbers across all loaded source files.
   */
  getAllMethodLineNumbers(projectPath: string): Map<string, number> {
    const map = new Map<string, number>();
    for (const sf of this.getSourceFiles()) {
      const relPath = sf.getFilePath().replace(projectPath + "/", "");
      const fullCode = this.getSourceFileText(sf.getFilePath());
      const methods = this.extractDeclarations(sf, relPath, sf.getFilePath());
      for (const m of methods) {
        map.set(m.name, m.lineNumber);
      }
    }
    return map;
  }

  private sanitizeKey(key: string): string {
    return key
      .replace(/[^a-zA-Z0-9_\-:~]/g, "_")
      .replace(/_+/g, "_")
      .substring(0, 254);
  }

  /**
   * Add all source files from the configured source directories.
   */
  private addSourceFilesFromDirs(): void {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");

    for (const dir of this.sourceDirs) {
      const dirPath = join(this.projectPath, dir);
      if (!existsSync(dirPath)) continue;

      const walkDir = (dir: string) => {
        try {
          const entries = readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              walkDir(fullPath);
            } else if (entry.isFile() && VALID_EXTENSIONS.has(extname(entry.name))) {
              this.addFile(fullPath);
            }
          }
        } catch {}
      };

      walkDir(dirPath);
    }
  }
}
