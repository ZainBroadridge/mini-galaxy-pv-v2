import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const roots = ['apps', 'packages', 'scripts'];
const ignored = new Set(['node_modules', 'dist', 'artifacts', 'cache', 'coverage', 'generated']);
const extensions = ['', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json'];
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory)) {
    if (ignored.has(entry)) continue;
    const candidate = path.join(directory, entry);
    const info = await stat(candidate);
    if (info.isDirectory()) await walk(candidate);
    else if (/\.(?:[cm]?js|jsx|tsx?)$/.test(candidate)) files.push(candidate);
  }
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function resolves(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const extension of extensions) {
    if (await exists(`${base}${extension}`)) return true;
  }
  for (const extension of extensions.slice(1)) {
    if (await exists(path.join(base, `index${extension}`))) return true;
  }
  return false;
}

for (const root of roots) await walk(root);
const missing = [];
const importPattern = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g;
for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    if (!(await resolves(file, specifier))) missing.push(`${file}: ${specifier}`);
  }
}

if (missing.length) {
  console.error('Unresolved relative imports:');
  for (const item of missing) console.error(`- ${item}`);
  process.exit(1);
}
console.log(`Resolved relative imports in ${files.length} source files.`);
