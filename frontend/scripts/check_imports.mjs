// ============================================================
//  check_imports.mjs — resolve every relative import in src/ and
//  confirm each named binding actually exists in the target file.
// ------------------------------------------------------------
//  WHY THIS EXISTS: there is no JSX parser available in the dev sandbox
//  (no typescript, no @babel/*; Vite 8's Oxc/Rolldown bindings are
//  win32-only), so `npm run build` is the only real syntax check and it
//  cannot always be run before handing work over. This script covers the
//  single most common breakage that static reading misses: importing a
//  name that the target module does not actually export — a misremembered
//  icon (IcLock vs IcPadlock), a helper that was renamed, a default vs
//  named import mix-up. Those fail at BUILD time, not at review time.
//
//  WHAT IT DOES NOT DO, and must not be claimed to do: JSX syntax, hook
//  rules, render-time crashes, bundling. Those still need a real build.
//
//  Run:  node scripts/check_imports.mjs
//  Exit: 0 clean, 1 if anything is unresolved.
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Extension guesses in the order Vite would try them.
const CANDIDATES = ['', '.jsx', '.js', '.json', '/index.jsx', '/index.js'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function resolveSpec(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const ext of CANDIDATES) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Names a module exports. Deliberately regex-based rather than parsed:
 * a real parser is exactly what is unavailable here. It over-collects
 * rather than under-collects, so a false PASS is possible but a false
 * FAILURE (the noisy, trust-destroying kind) is not.
 */
function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  if (/export\s+default/.test(src)) names.add('default');

  // export const X / let X / var X / function X / class X / async function X
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const as = seg.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  // export * from './x'  — cannot follow cheaply; mark the module as
  // opaque so we never report a false failure against it.
  if (/export\s*\*\s*from/.test(src)) names.add('*OPAQUE*');
  return names;
}

const files = walk(SRC);
const problems = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');

  for (const m of src.matchAll(/import\s+([^'"]+?)\s+from\s*['"](\.[^'"]+)['"]/g)) {
    const clause = m[1];
    const spec = m[2];

    const target = resolveSpec(file, spec);
    if (!target) {
      problems.push(`${path.relative(SRC, file)}: cannot resolve '${spec}'`);
      continue;
    }
    if (target.endsWith('.json')) continue;

    const available = exportsOf(target);
    if (available.has('*OPAQUE*')) continue;

    // Default import: leading bare identifier before any '{'.
    const defaultMatch = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/);
    if (defaultMatch && !clause.trimStart().startsWith('{') && !clause.trimStart().startsWith('*')) {
      if (!available.has('default')) {
        problems.push(`${path.relative(SRC, file)}: '${spec}' has no default export (imported as ${defaultMatch[1]})`);
      }
    }

    // Named imports.
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        const name = seg.split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!available.has(name)) {
          problems.push(`${path.relative(SRC, file)}: '${spec}' does not export '${name}'`);
        }
      }
    }
  }
}

console.log(`checked ${files.length} files under src/`);
if (problems.length === 0) {
  console.log('  all relative imports resolve, and every named binding exists');
  console.log('  NOTE: this does NOT verify JSX syntax, hooks, or bundling — run `npm run build`');
  process.exit(0);
}
console.log(`  ${problems.length} problem(s):`);
for (const p of problems) console.log(`    ${p}`);
process.exit(1);
