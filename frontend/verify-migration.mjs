// Post-rename verification. No dependencies — plain Node.
//
// The migration renamed 44 files .js -> .jsx. The failure mode that
// matters is a relative import that no longer resolves, which Vite would
// only report one file at a time, mid-build. This checks all of them at
// once, the way Vite's resolver does: try the literal path, then append
// each of resolve.extensions in order.
//
// Run:  node verify-migration.mjs
// Delete once the migration is confirmed.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const SRC = resolve('src');
// Vite's default resolve.extensions, in priority order.
const EXTS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// Static imports, side-effect imports, re-exports, and dynamic import().
const PATTERNS = [
  /\bimport\s+[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function resolves(spec, fromFile) {
  const base = resolve(dirname(fromFile), spec);
  if (existsSync(base) && statSync(base).isFile()) return true;
  for (const ext of EXTS) if (existsSync(base + ext)) return true;
  // Directory import -> index.*
  for (const ext of EXTS) if (existsSync(join(base, 'index' + ext))) return true;
  return false;
}

const files = walk(SRC);
const code = files.filter((f) => /\.(jsx?|mjs)$/.test(f));

let broken = 0;
let checked = 0;
const leftoverJs = files.filter((f) => f.endsWith('.js'));

for (const file of code) {
  const text = readFileSync(file, 'utf8');
  const seen = new Set();
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // bare = node_modules, not our problem
      if (seen.has(spec)) continue;
      seen.add(spec);
      checked++;
      if (!resolves(spec, file)) {
        broken++;
        console.log(`BROKEN  ${relative(SRC, file)}  ->  ${spec}`);
      }
    }
  }
}

console.log(`\nfiles scanned:      ${code.length}`);
console.log(`relative imports:   ${checked}`);
console.log(`unresolved:         ${broken}`);
console.log(`leftover .js:       ${leftoverJs.length}`);

// The entry point index.html points at must exist, or the build fails
// with a confusing "failed to resolve entry" rather than a parse error.
console.log(`src/index.jsx:      ${existsSync(join(SRC, 'index.jsx')) ? 'OK' : 'MISSING'}`);

if (broken || leftoverJs.length) {
  if (leftoverJs.length) console.log('\nleftover .js files:', leftoverJs.map((f) => relative(SRC, f)).join(', '));
  process.exit(1);
}
console.log('\nAll relative imports resolve.');
