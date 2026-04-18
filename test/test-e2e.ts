import { ArangoClient } from "../dist/arango-client.js";
import { JoernClient } from "../dist/joern-client.js";

const JOERN_CLI_PATH = process.env.JOERN_CLI_PATH || "/opt/joern/joern-cli";
const ARANGO_HOST = process.env.ARANGO_HOST || "http://localhost:8529";
const ARANGO_USER = process.env.ARANGO_USER || "root";
const ARANGO_PASS = process.env.ARANGO_PASS || "";
const ARANGO_DB = process.env.ARANGO_DB || "code_intel";
const TEST_PROJECT = process.env.TEST_PROJECT || process.cwd();

async function main() {
  console.log("=== Testing MCP Server ===");

  const joern = new JoernClient(JOERN_CLI_PATH);
  const arango = new ArangoClient(ARANGO_HOST, ARANGO_USER, ARANGO_PASS, ARANGO_DB);

  console.log("1. Testing JoernClient...");
  const parseResult = await joern.parseProject(TEST_PROJECT, "jssrc", ["src"]);
  console.log("Parse result:", { cpgBinPath: parseResult.cpgBinPath, nodeCount: parseResult.nodeCount, edgeCount: parseResult.edgeCount });

  console.log("2. Testing ArangoClient importCpg...");
  const projectAlias = TEST_PROJECT.split("/").pop() || "test-project";
  const importResult = await arango.importCpg(parseResult.cpgBinPath, projectAlias, TEST_PROJECT);
  console.log("Import result:", importResult);

  console.log("3. Testing ArangoClient searchSymbols...");
  const searchResult = await arango.searchSymbols("main", "ALL", TEST_PROJECT);
  console.log("Search results count:", searchResult.length);
  if (searchResult.length > 0) {
    console.log("First result:", searchResult[0]);
  }

  console.log("4. Testing ArangoClient getCallers...");
  try {
    const callers = await arango.getCallers("main", TEST_PROJECT, 1);
    console.log("Callers count:", callers.length);
  } catch (e: any) {
    console.log("getCallers error (expected if no edges yet):", e.message);
  }

  console.log("=== Test Complete ===");
}

main().catch(console.error);