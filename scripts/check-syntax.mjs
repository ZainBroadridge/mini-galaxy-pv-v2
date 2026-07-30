import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const roots = ['apps', 'packages', 'scripts'];
const files = [];
const ignored = new Set(['node_modules', 'dist', 'artifacts', 'cache', 'coverage', 'generated']);

async function walk(directory) {
  for (const entry of await readdir(directory)) {
    if (ignored.has(entry)) continue;
    const file = path.join(directory, entry);
    const info = await stat(file);
    if (info.isDirectory()) await walk(file);
    else if (/\.(?:[cm]?js|jsx|tsx?|cjs)$/.test(file)) files.push(file);
  }
}

for (const root of roots) await walk(root);

let ts;
try {
  ts = require('typescript');
} catch {
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  ts = require(path.join(globalRoot, 'typescript'));
}

const scriptKind = (file) => {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
};

let checkedByNode = 0;
let checkedByTypescript = 0;
for (const file of files.sort()) {
  if (/\.(?:[cm]?js|cjs)$/.test(file)) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
    checkedByNode += 1;
    continue;
  }

  const source = await readFile(file, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      isolatedModules: true,
    },
    transformers: undefined,
    scriptKind: scriptKind(file),
  });
  const diagnostics = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (diagnostics.length) {
    for (const diagnostic of diagnostics) {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      const location = diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : null;
      console.error(
        location
          ? `${file}:${location.line + 1}:${location.character + 1} ${message}`
          : `${file}: ${message}`,
      );
    }
    process.exit(1);
  }
  checkedByTypescript += 1;
}

console.log(
  `Syntax checked ${files.length} source files (${checkedByNode} with Node, ${checkedByTypescript} JSX/TypeScript).`,
);
