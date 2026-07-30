import { readFile, writeFile } from 'node:fs/promises';

const origin = String(process.argv[2] ?? '').replace(/\/$/, '');
if (!/^https?:\/\//.test(origin)) {
  throw new Error('Usage: node scripts/configure-snap-origin.mjs https://your-dapp.example');
}

const manifestPath = new URL('../apps/snap/snap.manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.initialPermissions['endowment:rpc'].allowedOrigins = [origin];
manifest.initialConnections = { [origin]: {} };
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Snap origin configured for ${origin}`);
