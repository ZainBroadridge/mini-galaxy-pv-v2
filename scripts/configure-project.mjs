import { readFile, writeFile } from 'node:fs/promises';

function parseArguments(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(
        'Usage: node scripts/configure-project.mjs --repository <https://github.com/owner/repo.git> --snap-package <@scope/name> --origin <https://dapp.example>',
      );
    }
    output[key.slice(2)] = value;
  }
  return output;
}

const options = parseArguments(process.argv.slice(2));
const repository = String(options.repository ?? '').replace(/\/$/u, '');
const snapPackage = String(options['snap-package'] ?? '');
const origin = String(options.origin ?? '').replace(/\/$/u, '');

if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/u.test(repository)) {
  throw new Error('--repository must be a complete HTTPS GitHub repository URL.');
}
if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(snapPackage)) {
  throw new Error('--snap-package must be a valid lowercase scoped npm package name.');
}
let normalizedOrigin;
try {
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error();
  normalizedOrigin = parsed.origin;
} catch {
  throw new Error('--origin must be an origin such as https://your-dapp.vercel.app.');
}

const packagePath = new URL('../apps/snap/package.json', import.meta.url);
const manifestPath = new URL('../apps/snap/snap.manifest.json', import.meta.url);
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

packageJson.name = snapPackage;
packageJson.repository = { type: 'git', url: repository };
manifest.repository = { type: 'git', url: repository };
manifest.source.location.npm.packageName = snapPackage;
manifest.initialPermissions['endowment:rpc'].allowedOrigins = [normalizedOrigin];
manifest.initialConnections = { [normalizedOrigin]: {} };

await Promise.all([
  writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`),
  writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
]);

console.log(`Repository: ${repository}`);
console.log(`Snap package: ${snapPackage}`);
console.log(`Authorized dApp origin: ${normalizedOrigin}`);
