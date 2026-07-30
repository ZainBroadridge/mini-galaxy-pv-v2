import { readFile, writeFile } from 'node:fs/promises';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

const origin = String(argument('origin') ?? '').replace(/\/$/, '');
const packageName = String(argument('package') ?? '');
const repositoryUrl = String(argument('repository') ?? '');

if (!/^https?:\/\//.test(origin)) {
  throw new Error('Provide --origin https://your-v2-dapp.example');
}
if (!/^@[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(packageName)) {
  throw new Error('Provide a scoped npm package using --package @scope/pv-communications-snap');
}
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/i.test(repositoryUrl)) {
  throw new Error('Provide --repository https://github.com/OWNER/REPOSITORY.git');
}

const manifestPath = new URL('../apps/snap/snap.manifest.json', import.meta.url);
const packagePath = new URL('../apps/snap/package.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));

manifest.repository = { type: 'git', url: repositoryUrl };
manifest.source.location.npm.packageName = packageName;
manifest.initialPermissions['endowment:rpc'].allowedOrigins = [origin];
manifest.initialConnections = { [origin]: {} };
packageJson.name = packageName;
packageJson.repository = { type: 'git', url: repositoryUrl };

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`Configured ${packageName} for ${origin}`);
console.log(`Set VITE_SNAP_ID=npm:${packageName} in Vercel after publishing.`);
