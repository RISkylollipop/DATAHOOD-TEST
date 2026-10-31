// ============================================================
//  scripts/verify_route_mounts.js
// ------------------------------------------------------------
//  Guards ONE mistake, because it cost the whole newsletter feature and
//  nothing else could see it:
//
//      router.use(requireUser);        // no path
//
//  That does not mean "every route in this file". It means every request
//  that reaches this router. server.js mounts all fifteen routers on the
//  same bare '/api' prefix, so an unpathed use() answers requests that
//  belong to the routers mounted after it. routes/profile.js did exactly
//  this and the entire newsletter router — mounted one line later — was
//  unreachable: the admin composer got 403 "User access required." and
//  public signup on the landing page got 401 for every visitor.
//
//  Nothing catches this. It is valid JavaScript, so `node --check` is
//  happy. Every route is declared correctly, so reading routes/newsletter.js
//  shows nothing wrong. A test that mounts one router in isolation passes,
//  because the bug only exists in the combination.
//
//  Run:  node scripts/verify_route_mounts.js
//  No DB, no network, no server start.
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'routes');

/**
 * Find every `router.use(...)` whose first argument is not a string literal.
 * Returns [{ line, text }]. Comments are stripped first so that prose
 * describing the bug does not register as the bug.
 */
export function findUnpathedUse(source) {
  const hits = [];
  source.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    const m = line.match(/\brouter\.use\s*\(\s*([^)]*)/);
    if (!m) return;
    const firstArg = m[1].trim();
    if (!/^['"`]/.test(firstArg)) hits.push({ line: i + 1, text: raw.trim() });
  });
  return hits;
}

function main() {
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js')).sort();
  let bad = 0;

  for (const f of files) {
    const hits = findUnpathedUse(fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8'));
    for (const h of hits) {
      console.error(`  FAIL  routes/${f}:${h.line}  unpathed router.use — ${h.text}`);
      bad += 1;
    }
  }
  console.log(bad ? '' : `  PASS  ${files.length} router file(s): every router.use is path-scoped`);

  // ---- control: a checker that cannot fail is not a checker ----
  const mutant = 'const router = express.Router();\nrouter.use(requireUser);\n';
  const caught = findUnpathedUse(mutant).length === 1;
  const notFooled = findUnpathedUse("// router.use(requireUser) is wrong\nrouter.use('/profile', requireUser);\n").length === 0;
  console.log(`  ${caught ? 'PASS' : 'FAIL'}  control: detects an unpathed use() in known-bad input`);
  console.log(`  ${notFooled ? 'PASS' : 'FAIL'}  control: not fooled by a comment or a pathed use()`);
  if (!caught || !notFooled) bad += 1;

  if (bad) {
    console.error('\nAn unpathed router.use() runs for every /api request that reaches it,\n' +
                  'not just this file\'s routes. Give it a path: router.use(\'/prefix\', mw).');
    process.exit(1);
  }
  console.log('\nAll route mounts are correctly scoped.');
}

main();
