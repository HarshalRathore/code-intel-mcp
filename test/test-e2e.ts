import { ArangoClient } from "./dist/src/arango-client.js";
import { JoernClient } from "./dist/src/joern-client.js";

async function main() {
  console.log("=== Testing MCP Server ===");

  const joern = new JoernClient("/home/harshal/harshal/joern/joern-cli");
  const arango = new ArangoClient(
    "http://localhost:8529",
    "root",
    "code_intel_dev",
    "code_intel"
  );

  console.log("1. Testing JoernClient...");
  const parseResult = await joern.parseProject(
    "/home/harshal/harshal/repeato/code-intel-mcp",
    "typescript"
  );
  console.log("Parse result:", { cpgBinPath: parseResult.cpgBinPath, nodeCount: parseResult.nodeCount, edgeCount: parseResult.edgeCount });

  console.log("2. Testing ArangoClient importCpg...");
  const importResult = await arango.importCpg(parseResult.cpgBinPath, "code-intel-mcp", "/home/harshal/harshal/repeato/code-intel-mcp");
  console.log("Import result:", importResult);

  console.log("3. Testing ArangoClient searchSymbols...");
  const searchResult = await arango.searchSymbols("main", "ALL", "/home/harshal/harshal/repeato/code-intel-mcp");
  console.log("Search results count:", searchResult.length);
  if (searchResult.length > 0) {
    console.log("First result:", searchResult[0]);
  }

  console.log("4. Testing ArangoClient getCallers...");
  try {
    const callers = await arango.getCallers("main", "/home/harshal/harshal/repeato/code-intel-mcp", 1);
    console.log("Callers count:", callers.length);
  } catch (e) {
    console.log("getCallers error (expected if no edges yet):", e.message);
  }

  console.log("=== Test Complete ===");
}

main().catch(console.error);
