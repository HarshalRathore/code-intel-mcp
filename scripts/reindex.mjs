import { ArangoClient } from '../dist/arango-client.js';
import { JoernClient } from '../dist/joern-client.js';
import { computeManifestHashes, diffManifests, saveManifest, loadManifest } from '../dist/manifest.js';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const projectPath = process.argv[2] || '/home/harshal/harshal/repeato/repeato-console';
const projectAlias = process.argv[3] || projectPath.split('/').pop();
const language = process.argv[4] || 'jssrc';
const sourceDirs = ['src'];

const JOERN_CLI_PATH = process.env.JOERN_CLI_PATH || '/home/harshal/harshal/joern/joern-cli';
const ARANGO_HOST = process.env.ARANGO_HOST || 'http://localhost:8529';
const ARANGO_USER = process.env.ARANGO_USER || 'root';
const ARANGO_PASS = process.env.ARANGO_PASS || 'code_intel_dev';
const ARANGO_DB = process.env.ARANGO_DB || 'code_intel';

async function reindex() {
  console.log(`Reindexing ${projectAlias} at ${projectPath}...`);
  
  const joern = new JoernClient(JOERN_CLI_PATH);
  const arango = new ArangoClient(ARANGO_HOST, ARANGO_USER, ARANGO_PASS, ARANGO_DB);
  
  const manifestDir = join(projectPath, '.code-intel');
  const manifestPath = join(manifestDir, 'manifest.json');
  
  console.log('Step 1: Parsing project with Joern (this takes 2-3 minutes)...');
  const parseResult = await joern.parseProject(projectPath, language, sourceDirs);
  console.log(`  CPG binary: ${parseResult.cpgBinPath}`);
  console.log(`  Nodes in CPG: ${parseResult.nodeCount}`);
  
  console.log('Step 2: Importing to ArangoDB...');
  const importResult = await arango.importCpg(parseResult.cpgBinPath, projectAlias, projectPath, joern);
  console.log(`  Nodes: ${importResult.nodeCount}`);
  console.log(`  Edges: ${importResult.edgeCount}`);
  console.log(`  Collections: ${importResult.collections.join(', ')}`);
  
  console.log('Step 3: Saving manifest...');
  const cpgBinHash = await joern.computeCpgBinHash(parseResult.cpgBinPath);
  const currentHashes = computeManifestHashes(projectPath, sourceDirs);
  if (!existsSync(manifestDir)) mkdirSync(manifestDir, { recursive: true });
  
  const manifest = {
    projectPath,
    projectAlias,
    indexedAt: new Date().toISOString(),
    fileHashes: currentHashes,
    sourceDirs,
    language,
    totalNodes: importResult.nodeCount,
    totalEdges: importResult.edgeCount,
    cpgBinHash
  };
  saveManifest(manifestPath, manifest);
  console.log(`  Manifest saved to ${manifestPath}`);
  
  console.log('Done!');
  process.exit(0);
}

reindex().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});