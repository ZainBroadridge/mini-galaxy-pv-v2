import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

async function walk(directory, predicate) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'artifacts', 'cache', 'coverage'].includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(fullPath, predicate));
    else if (predicate(fullPath)) output.push(fullPath);
  }
  return output;
}

const solidityFiles = await walk(root, (file) => file.endsWith('.sol'));
const expectedContract = path.join(root, 'packages/contracts/contracts/VoteEvent.sol');
if (solidityFiles.length !== 1 || solidityFiles[0] !== expectedContract) {
  throw new Error(`V2 must contain exactly one Solidity source: ${expectedContract}. Found: ${solidityFiles.join(', ')}`);
}

const contract = await readFile(expectedContract, 'utf8');
for (const forbidden of [
  'DeploymentRegistry',
  'AccessList',
  'CompanyToken',
  'updateVote',
  'recallVote',
  'pauseVoting',
  'setRelayer',
]) {
  if (contract.includes(forbidden)) throw new Error(`Forbidden V1/extra contract feature found: ${forbidden}`);
}

const snapPackage = JSON.parse(await readFile(path.join(root, 'apps/snap/package.json'), 'utf8'));
const snapManifest = JSON.parse(await readFile(path.join(root, 'apps/snap/snap.manifest.json'), 'utf8'));
if (snapPackage.version !== snapManifest.version) {
  throw new Error('Snap package.json and manifest versions must match.');
}
if (snapPackage.name !== snapManifest.source.location.npm.packageName) {
  throw new Error('Snap package name and manifest npm package name must match.');
}

const render = await readFile(path.join(root, 'render.yaml'), 'utf8');
const [apiSection, workerSection = ''] = render.split('  - type: worker');
if (apiSection.includes('RELAYER_PRIVATE_KEY')) {
  throw new Error('RELAYER_PRIVATE_KEY must not be present in the Render API service section.');
}
if (!workerSection.includes('RELAYER_PRIVATE_KEY')) {
  throw new Error('RELAYER_PRIVATE_KEY must be configured only on the Render worker.');
}

console.log('Structure validated: one VoteEvent source, no V1 contracts, Snap metadata aligned, relayer key isolated to the worker.');
