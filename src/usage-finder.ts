import { Project, SyntaxKind } from "ts-morph";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

export interface UsageLocation {
  filePath: string;
  lineNumber: number;
  lineText: string;
  kind: string;
}

export interface FindUsagesResult {
  symbol: string;
  definition: UsageLocation | null;
  references: UsageLocation[];
  totalReferences: number;
}

export function findUsages(
  projectPath: string,
  symbol: string,
  sourceDirs: string[] = ["src"]
): FindUsagesResult {
  const tsConfigPath = join(projectPath, "tsconfig.json");
  const hasTsConfig = existsSync(tsConfigPath);

  let project: Project;
  if (hasTsConfig) {
    project = new Project({
      tsConfigFilePath: tsConfigPath,
      skipAddingFilesFromTsConfig: false,
      skipFileDependencyResolution: false,
    });
  } else {
    project = new Project({
      compilerOptions: {
        allowJs: true,
        strict: false,
        noEmit: true,
        esModuleInterop: true,
      },
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
    });
    for (const dir of sourceDirs) {
      const srcDir = join(projectPath, dir);
      if (existsSync(srcDir)) {
        project.addSourceFilesAtPaths(join(srcDir, "**/*.{js,jsx,ts,tsx,mjs,cjs}"));
      }
    }
  }

  const references: UsageLocation[] = [];
  let definition: UsageLocation | null = null;

  const sourceFiles = project.getSourceFiles();

  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();

    const isInSourceDir = sourceDirs.some(dir => filePath.includes(join(projectPath, dir)));
    if (!isInSourceDir) continue;

    const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);

    for (const identifier of identifiers) {
      if (identifier.getText() !== symbol) continue;

      const location: UsageLocation = {
        filePath: relative(projectPath, filePath),
        lineNumber: identifier.getStartLineNumber(),
        lineText: identifier.getText(),
        kind: getUsageKind(identifier),
      };

      const symbolDecl = identifier.getSymbol()?.getDeclarations()[0];
      if (symbolDecl) {
        const declFile = symbolDecl.getSourceFile().getFilePath();
        const declLine = symbolDecl.getStartLineNumber();
        if (declFile === filePath && declLine === identifier.getStartLineNumber()) {
          definition = location;
        }
      }

      references.push(location);
    }
  }

  return {
    symbol,
    definition,
    references,
    totalReferences: references.length,
  };
}

function getUsageKind(identifier: any): string {
  const parent = identifier.getParent();
  if (!parent) return "reference";

  switch (parent.getKind()) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
      return "definition";
    case SyntaxKind.CallExpression:
      return "call";
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ImportClause:
      return "import";
    default:
      return "reference";
  }
}
