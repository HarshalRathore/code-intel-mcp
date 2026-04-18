import { ArangoClient } from "./arango-client.js";
import { Database, aql } from "arangojs";

export interface CodeContextResult {
  task: string;
  entryPoints: Array<{
    name: string;
    file: string;
    line: number;
    code: string;
    score: number;
    relevance: string;
  }>;
  relatedFiles: Array<{
    file: string;
    methods: string[];
    reason: string;
  }>;
  summary: {
    totalEntryPoints: number;
    totalRelatedFiles: number;
  };
}

interface ScoredSymbol {
  name: string;
  file: string;
  line: number;
  code: string;
  score: number;
  callerCount: number;
  calleeCount: number;
}

const STOP_WORDS = new Set([
  "that", "this", "with", "from", "into", "need", "should", "would", "could",
  "the", "and", "for", "not", "bug", "fix", "feature", "implement", "add",
  "update", "change", "modify", "create", "remove", "delete", "make", "when",
  "where", "which", "than", "then", "been", "have", "will", "also", "just",
  "more", "some", "what", "about", "after", "before", "between", "does",
  "each", "every", "other", "being", "because", "doesnt", "isnt", "wasnt",
  "cant", "dont", "wont", "very", "much", "many", "such", "most",
]);

function extractKeywords(task: string): string[] {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function generateSearchCandidates(keywords: string[]): string[] {
  const candidates: string[] = [];

  for (const kw of keywords.slice(0, 8)) {
    candidates.push(kw);
  }

  for (let i = 0; i < keywords.length - 1; i++) {
    candidates.push(keywords[i] + keywords[i + 1]);
    candidates.push(keywords[i + 1] + keywords[i]);
  }

  if (keywords.length >= 3) {
    candidates.push(keywords.slice(0, 3).join(""));
  }

  return [...new Set(candidates)];
}

function scoreSymbol(
  sym: { name: string; filename: string; code: string },
  keywords: string[],
  callerCount: number,
  calleeCount: number
): number {
  let score = 0;
  const nameLower = sym.name.toLowerCase();
  const fileLower = sym.filename.toLowerCase();

  for (const kw of keywords) {
    if (nameLower === kw) {
      score += 20;
    } else if (nameLower.startsWith(kw)) {
      score += 12;
    } else if (nameLower.endsWith(kw)) {
      score += 10;
    } else if (nameLower.includes(kw)) {
      score += 8;
    }

    const kwParts = kw.split(/(?=[A-Z])/);
    for (const part of kwParts) {
      if (part.length > 2 && nameLower.includes(part.toLowerCase())) {
        score += 3;
      }
    }

    if (fileLower.includes(kw)) {
      score += 5;
    }
  }

  const compoundWords = keywords.length >= 2
    ? [keywords.join(""), keywords.slice().reverse().join("")]
    : [];
  for (const cw of compoundWords) {
    if (nameLower === cw) score += 15;
    else if (nameLower.includes(cw)) score += 8;
  }

  if (callerCount > 0) {
    score += Math.min(callerCount, 10) * 2;
  }
  if (calleeCount > 0) {
    score += Math.min(calleeCount, 10);
  }

  if (sym.code && sym.code.length > 10) {
    const codeLower = sym.code.toLowerCase();
    let codeMatches = 0;
    for (const kw of keywords) {
      if (codeLower.includes(kw)) codeMatches++;
    }
    score += codeMatches * 3;
  }

  return score;
}

function computeRelevance(sym: ScoredSymbol): string {
  const parts: string[] = [];
  if (sym.callerCount > 0) parts.push(`called by ${sym.callerCount}`);
  if (sym.calleeCount > 0) parts.push(`calls ${sym.calleeCount}`);
  if (parts.length === 0) parts.push("leaf function");
  return parts.join(", ");
}

export async function getCodeContext(
  task: string,
  projectPath: string,
  arango: ArangoClient,
  maxEntryPoints: number = 10,
  maxRelatedFiles: number = 5
): Promise<CodeContextResult> {
  const keywords = extractKeywords(task);
  const candidates = generateSearchCandidates(keywords);

  const symbolMap = new Map<string, ScoredSymbol>();

  for (const candidate of candidates.slice(0, 12)) {
    try {
      const symbols = await arango.searchSymbols(candidate, "ALL", projectPath);
      for (const sym of symbols) {
        if (!sym.filename || sym.filename === "<empty>" || sym.filename === "") continue;
        const key = `${sym.name}::${sym.filename}::${sym.lineNumber}`;
        if (!symbolMap.has(key)) {
          let callerCount = 0;
          let calleeCount = 0;
          try {
            const callers = await arango.getCallers(sym.name, projectPath, 1);
            callerCount = callers.length;
          } catch {}
          try {
            const callees = await arango.getCallees(sym.name, projectPath, 1);
            calleeCount = callees.length;
          } catch {}

          const score = scoreSymbol(sym, keywords, callerCount, calleeCount);
          symbolMap.set(key, {
            name: sym.name,
            file: sym.filename,
            line: sym.lineNumber,
            code: sym.code || "",
            score,
            callerCount,
            calleeCount,
          });
        }
      }
    } catch {}
  }

  const allSymbols = Array.from(symbolMap.values());
  allSymbols.sort((a, b) => b.score - a.score);

  const topEntryPoints = allSymbols.slice(0, maxEntryPoints);

  const entryPoints: CodeContextResult["entryPoints"] = topEntryPoints.map(sym => ({
    name: sym.name,
    file: sym.file,
    line: sym.line,
    code: sym.code,
    score: sym.score,
    relevance: computeRelevance(sym),
  }));

  const fileMap = new Map<string, Set<string>>();
  for (const sym of topEntryPoints) {
    if (!fileMap.has(sym.file)) fileMap.set(sym.file, new Set());
    fileMap.get(sym.file)!.add(sym.name);

    try {
      const callers = await arango.getCallers(sym.name, projectPath, 1);
      for (const c of callers.slice(0, 3)) {
        if (c.callerFile && c.callerFile !== "<empty>" && c.callerFile !== "") {
          if (!fileMap.has(c.callerFile)) fileMap.set(c.callerFile, new Set());
          fileMap.get(c.callerFile)!.add(c.caller);
        }
      }
    } catch {}
    try {
      const callees = await arango.getCallees(sym.name, projectPath, 1);
      for (const c of callees.slice(0, 3)) {
        if (c.calleeFile && c.calleeFile !== "<empty>" && c.calleeFile !== "") {
          if (!fileMap.has(c.calleeFile)) fileMap.set(c.calleeFile, new Set());
          fileMap.get(c.calleeFile)!.add(c.callee);
        }
      }
    } catch {}
  }

  const sortedFiles = Array.from(fileMap.entries())
    .sort((a, b) => b[1].size - a[1].size);

  const relatedFiles: CodeContextResult["relatedFiles"] = sortedFiles
    .slice(0, maxRelatedFiles)
    .map(([file, methods]) => ({
      file,
      methods: Array.from(methods).slice(0, 10),
      reason: `contains ${methods.size} relevant symbols`,
    }));

  return {
    task,
    entryPoints,
    relatedFiles,
    summary: {
      totalEntryPoints: entryPoints.length,
      totalRelatedFiles: relatedFiles.length,
    },
  };
}