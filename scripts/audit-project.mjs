import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const warnings = [];

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'artifacts', 'cache'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(absolute));
    else output.push(absolute);
  }
  return output;
}

async function text(relative) {
  return readFile(path.join(root, relative), 'utf8');
}

const files = await walk(root);
const solidity = files.filter((file) => file.endsWith('.sol'));
if (solidity.length !== 1 || path.basename(solidity[0] ?? '') !== 'VoteEvent.sol') {
  failures.push(`Expected exactly one Solidity source named VoteEvent.sol; found ${solidity.length}.`);
}

for (const file of files.filter((value) => value.endsWith('.json'))) {
  try {
    JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    failures.push(`Invalid JSON: ${path.relative(root, file)} (${error.message})`);
  }
}

const runtimeFiles = files.filter((file) => /apps[\\/](api|indexer)[\\/]src[\\/]/u.test(file));
const bannedNames = ['DeploymentRegistry', 'AccessList', 'CompanyToken', 'ProxyVoting'];
for (const file of runtimeFiles) {
  const source = await readFile(file, 'utf8');
  for (const name of bannedNames) {
    if (source.includes(name)) failures.push(`Legacy ${name} reference in ${path.relative(root, file)}.`);
  }
}

const apiFiles = files.filter((file) => /apps[\\/]api[\\/]/u.test(file));
for (const file of apiFiles) {
  const source = await readFile(file, 'utf8');
  if (/hardhat\s+(compile|run)/u.test(source) || /node:child_process/u.test(source)) {
    failures.push(`Runtime compile/process execution found in API: ${path.relative(root, file)}.`);
  }
}

const contract = await text('packages/contracts/contracts/VoteEvent.sol');
for (const required of [
  'contract VoteEvent',
  'mapping(address voter => bool voted) public hasVoted',
  'mapping(uint256 proposalOptionKey => uint256 votingPower) private _tallies',
  'MerkleProof.verifyCalldata',
  'event VoteCast',
]) {
  if (!contract.includes(required)) failures.push(`VoteEvent.sol is missing required construct: ${required}`);
}
for (const unnecessary of ['pause(', 'recall', 'updateVote', 'relayer;', 'owner;', 'delegate']) {
  if (contract.toLowerCase().includes(unnecessary.toLowerCase())) {
    failures.push(`VoteEvent.sol contains an intentionally excluded feature: ${unnecessary}`);
  }
}

const migration = await text('db/migrations/002_relayer_transaction_outbox.sql');
if (!migration.includes('raw_transaction') || !migration.includes('UNIQUE(chain_id, relayer_address, nonce)')) {
  failures.push('Relayer transaction outbox migration is incomplete.');
}

for (const requiredFile of [
  'packages/contracts/scripts/verify-runtime.cjs',
  'apps/indexer/src/relayer-transaction.js',
  'apps/indexer/src/snapshot.js',
  'apps/snap/src/index.tsx',
  'render.yaml',
  'vercel.json',
]) {
  try {
    const info = await stat(path.join(root, requiredFile));
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    failures.push(`Missing required file: ${requiredFile}`);
  }
}

const snapPackage = JSON.parse(await text('apps/snap/package.json'));
if (snapPackage.name.includes('replace-with-your')) {
  warnings.push('Snap npm scope is still a placeholder; run npm run snap:configure before publishing.');
}

if (failures.length) {
  console.error('Project audit failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`Project audit passed: ${files.length} files, ${solidity.length} Solidity contract source.`);
warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
