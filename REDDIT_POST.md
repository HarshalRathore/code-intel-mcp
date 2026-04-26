Title:
I replaced Joern (JVM CPG parser) with ts-morph in my MCP server and got 363x faster indexing

Body:

Built an MCP server for code intelligence — symbol search, call graphs, impact analysis, React component trees. Originally used Joern (JVM-based code property graph parser) because it promised "deep analysis." What it actually delivered:

- 83 seconds to reindex after every file change (full project reparse, JVM warmup, Scala compilation, the whole circus)
- Silently dropped .ts files without JSX (just skipped them, no error)
- Required a transpilation step (.tsx → .js via Babel) before Joern could even look at the files
- 1GB RAM spikes
- Daemon process + Unix sockets + session state files on disk that accumulated into 239 orphaned session dirs

Swapped it all out for ts-morph (TypeScript Compiler API wrapper). Same ArangoDB storage backend, same MCP tools, completely different pipe:

- ~230ms to index 4 new files (down from 83s)
- ~8s for a full edge rebuild of 374 files
- Reads .ts/.tsx directly — no transpilation
- Nested arrow functions inside React components get their own method nodes with correct call edges
- Type checker resolves cross-file calls accurately instead of Joern's stub nodes pointing to "<empty>"

The data flow tool is still shallow, and I lost nothing else. 11 source files changed, 2300 lines added. If you're building something that parses TS/JS for code understanding and someone tells you to use Joern — question that advice.

Code: github.com/HarshalRathore/code-intel-mcp
