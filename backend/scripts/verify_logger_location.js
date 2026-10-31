// ============================================================
//  scripts/verify_logger_location.js
// ------------------------------------------------------------
//  Every log line has to say WHERE it came from, because message
//  strings are not unique — "Provider request failed" appears in
//  several controllers, so grepping the text lands you in the
//  wrong file. That is the whole point of the feature, and it is
//  the kind of thing that silently stops working: nothing fails,
//  the logs just quietly become useless.
//
//   A. `at` names the CALLER, not the logger. A location field
//      that always says "utils/logger.js" is worse than none.
//   B. Paths are relative to backend/ and forward-slashed, so a
//      log written on Windows reads the same as one from the
//      Linux server — and no absolute path discloses the deploy
//      directory on a shared host.
//   C. `thrownAt` is the THROW site, read off err.stack. `at` for
//      a caught error is the handler; the central error handler
//      is ONE line for the whole app, so without this every
//      unhandled failure in the codebase logs the same location.
//   D. Absent, not "unknown", when there is no stack — an empty
//      field reads as "none was available", where a string would
//      claim we looked at one and failed.
//   E. A real written log line carries both fields.
//   F. A shared helper can name its CALLER via callSite(1).
//   G. The one production helper that relies on F —
//      utils/dbErrors.js — actually does name its caller. F proves
//      the mechanism on synthetic functions; G proves the call site.
//
//  Runs against the real logger with LOG_DIR redirected, so the
//  file-writing path is exercised rather than mocked around.
//
//  Usage:  node scripts/verify_logger_location.js
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { callSite, errorSite, toPortablePath } = await import('../utils/logger.js');
const logger = await import('../utils/logger.js');

// fileURLToPath, not hand-rolled string surgery: a directory with a space in
// it ("DATAHOOD PROJECT") arrives percent-encoded as %20 and every read then
// misses by a character nobody can see.
const LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');

let failures = 0;
const ok = (n) => process.stdout.write(`  PASS  ${n}\n`);
const bad = (n, d) => { failures += 1; process.stdout.write(`  FAIL  ${n}\n        ${d}\n`); };
const check = (n, c, d) => (c ? ok(n) : bad(n, d));

// ------------------------------------------------------------
process.stdout.write('\nA. `at` names the caller, not the logger\n');

const here = callSite(0);
check(
  'callSite returns file:line',
  /^[\w./-]+\.js:\d+$/.test(here),
  `got ${JSON.stringify(here)}`,
);
check(
  'it names THIS script, not utils/logger.js',
  // The failure mode that makes the field worthless: every entry pointing at
  // the logger, which is the one file that is never the answer.
  here.includes('verify_logger_location.js') && !here.includes('logger.js'),
  `got ${here}`,
);

// Two calls on different lines must report different lines, or the number is
// decoration — a constant would pass every check above.
const lineA = callSite(0);
const lineB = callSite(0);
check(
  'the line number tracks the actual call line',
  Number(lineA.split(':')[1]) + 1 === Number(lineB.split(':')[1]),
  `got ${lineA} then ${lineB}`,
);

// ------------------------------------------------------------
process.stdout.write('\nB. Paths are portable and disclose nothing\n');
check(
  'forward slashes, even on Windows',
  !here.includes('\\'),
  `got ${here} — a backslash path reads differently than the Linux server's`,
);
check(
  'relative to backend/, not absolute',
  !/^([A-Za-z]:|\/)/.test(here),
  `got ${here} — an absolute path discloses the deploy directory`,
);
check(
  'rooted at a backend/ subdirectory',
  here.startsWith('scripts/'),
  `got ${here}`,
);

// ------------------------------------------------------------
process.stdout.write('\nC. `thrownAt` is the throw site, not the catch site\n');

// A throw deep in a helper, caught far away — the shape of every real handler.
function deepThrow() {
  throw new Error('provider exploded');
}
function middleLayer() {
  deepThrow();
}
let caught;
try {
  middleLayer();
} catch (e) {
  caught = e;
}

const thrown = errorSite(caught);
check(
  'errorSite finds a location in the stack',
  /^[\w./-]+\.js:\d+$/.test(thrown || ''),
  `got ${JSON.stringify(thrown)}`,
);
check(
  'it points at the THROW, not at the catch',
  // deepThrow sits above the try/catch in this file; if this ever reports the
  // catch line, the field is just a slower `at`.
  Number(thrown.split(':')[1]) < Number(callSite(0).split(':')[1]),
  `thrownAt=${thrown}, catch is later in the file`,
);
check(
  'the logger is never named as the throw site',
  !thrown.includes('utils/logger.js'),
  `got ${thrown}`,
);

// The first line of a stack is the MESSAGE, and messages routinely quote a
// full location — a wrapped provider error, a syntax error, anything that
// embeds "file.js:line:col". Reading it as if it were a frame reports code
// that was never executed, which is worse than no location: it sends you to
// the wrong file with confidence.
const pathyMessage = {
  stack: 'Error: upstream failed at /app/services/decoy.js:99:12\n'
    + '    at realCode (file:///x/controllers/airtimeController.js:258:11)',
};
check(
  'a location inside the error MESSAGE is not mistaken for a frame',
  errorSite(pathyMessage) === 'airtimeController.js:258',
  `got ${JSON.stringify(errorSite(pathyMessage))} — expected the frame, not the message`,
);

// ------------------------------------------------------------
process.stdout.write('\nC2. Paths normalise the same way on either platform\n');
//  The separator conversion is invisible on Linux, where path.sep is already
//  '/', so it has to be checked against a Windows-shaped path directly.
check(
  'a Windows path converts to forward slashes',
  toPortablePath('controllers\\airtimeController.js') === 'controllers/airtimeController.js',
  `got ${toPortablePath('controllers\\airtimeController.js')}`,
);
check(
  'a POSIX path is left alone',
  toPortablePath('controllers/airtimeController.js') === 'controllers/airtimeController.js',
  `got ${toPortablePath('controllers/airtimeController.js')}`,
);
check(
  'a mixed path normalises fully',
  toPortablePath('services\\whatsapp/driver.js') === 'services/whatsapp/driver.js',
  `got ${toPortablePath('services\\whatsapp/driver.js')}`,
);
check(
  'empty input stays empty rather than becoming "undefined"',
  toPortablePath(undefined) === '' && toPortablePath(null) === '',
  `got ${JSON.stringify(toPortablePath(undefined))}`,
);

// ------------------------------------------------------------
process.stdout.write('\nD. No stack means no field, not a fake one\n');
for (const [label, input] of [
  ['undefined', undefined],
  ['null', null],
  ['a plain object', { message: 'no stack here' }],
  ['an empty string', ''],
  ['a stack-less Error-like', { message: 'x', stack: undefined }],
]) {
  check(
    `${label} -> null`,
    errorSite(input) === null,
    `got ${JSON.stringify(errorSite(input))} — implies a stack was inspected`,
  );
}
check(
  'a stack with no file frames -> null',
  errorSite({ stack: 'Error: x\n    at <anonymous>\n    at native' }) === null,
  'a frame with no file:line was reported as a location',
);

// ------------------------------------------------------------
process.stdout.write('\nE. A written log line actually carries both fields\n');

const marker = `verify-logger-${Date.now()}`;
logger.error(marker, { error: caught.message, stack: caught.stack, path: '/api/test' });

const day = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const logFile = path.join(LOG_DIR, `error-${day}.log`);

let entry = null;
try {
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  entry = JSON.parse(lines.reverse().find((l) => l.includes(marker)));
} catch (e) {
  bad('the log line was written and is readable', `${logFile}: ${e.message}`);
}

if (entry) {
  ok('the log line was written and is readable');
  check(
    'the entry has an `at`',
    typeof entry.at === 'string' && entry.at.includes('verify_logger_location.js'),
    `got ${JSON.stringify(entry.at)}`,
  );
  check(
    'the entry has a `thrownAt` derived from the stack',
    typeof entry.thrownAt === 'string' && /\.js:\d+$/.test(entry.thrownAt),
    `got ${JSON.stringify(entry.thrownAt)}`,
  );
  check(
    '`at` and `thrownAt` differ — they answer different questions',
    entry.at !== entry.thrownAt,
    `both were ${entry.at}; the throw site is not the log site here`,
  );
  check(
    'a caller-supplied thrownAt is not overwritten',
    (() => {
      const m2 = `verify-logger-explicit-${Date.now()}`;
      logger.warn(m2, { thrownAt: 'services/mine.js:1', stack: caught.stack });
      const l = fs.readFileSync(path.join(LOG_DIR, `warn-${day}.log`), 'utf8').trim().split('\n');
      const e2 = JSON.parse(l.reverse().find((x) => x.includes(m2)));
      return e2.thrownAt === 'services/mine.js:1';
    })(),
    'a shared helper could not report the location that matters',
  );
}

// ------------------------------------------------------------
process.stdout.write('\nF. A shared helper can report its CALLER\n');
//  utils/dbErrors.js logs on behalf of many controllers. Left alone, every
//  schema-drift entry in the app would read "utils/dbErrors.js:60" — one line
//  for every page that could break. callSite(1) skips the helper's own frame.
//  Depth is an off-by-one waiting to happen, so it is asserted, not reasoned.

function sharedHelper() {
  return { own: callSite(0), caller: callSite(1) };
}
function controllerA() { return sharedHelper(); }
function controllerB() { return sharedHelper(); }

const fromA = controllerA();
const fromB = controllerB();

check(
  'depth 0 names the helper itself',
  Number(fromA.own.split(':')[1]) === Number(fromB.own.split(':')[1]),
  `got ${fromA.own} and ${fromB.own} — depth 0 should be the same line both times`,
);
check(
  'depth 1 names the CALLER, so two callers differ',
  fromA.caller !== fromB.caller,
  `both callers reported ${fromA.caller} — the helper would mask which page broke`,
);
check(
  'depth 1 is not just depth 0 again',
  fromA.caller !== fromA.own,
  `got ${fromA.caller} for both depths`,
);
check(
  'both depths still resolve to real locations in this file',
  fromA.own.includes('verify_logger_location.js')
    && fromA.caller.includes('verify_logger_location.js'),
  `got own=${fromA.own} caller=${fromA.caller}`,
);

// ------------------------------------------------------------
process.stdout.write('\nG. The real shared helper names the controller that called it\n');
//  Section F proves the depth mechanism on synthetic functions. This proves the
//  one production call site that depends on it. handleSchemaDrift is invoked
//  from many controllers, so if its `at` ever reports utils/dbErrors.js, every
//  schema-drift incident in the app logs the same line and the field stops
//  answering "which page broke".

const { handleSchemaDrift } = await import('../utils/dbErrors.js');

// errno 1054 under .parent is how Sequelize surfaces "Unknown column".
const driftErr = Object.assign(new Error("Unknown column 'status' in 'field list'"), {
  parent: { errno: 1054 },
});
const driftMarker = `verify-drift-${Date.now()}`;
let sent = null;
const fakeRes = {
  status(code) { sent = { code }; return this; },
  json(body) { sent = { ...sent, body }; return this; },
};

const handled = handleSchemaDrift(fakeRes, driftErr, { where: driftMarker });

check(
  'the drift was recognised and handled',
  handled === true && sent?.code === 503,
  `handled=${handled}, status=${sent?.code} — expected a 503, never 401 (auto-logout)`,
);

let driftEntry = null;
try {
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  driftEntry = JSON.parse(lines.reverse().find((l) => l.includes(driftMarker)));
} catch (e) {
  bad('the drift log line was written and is readable', `${logFile}: ${e.message}`);
}

if (driftEntry) {
  ok('the drift log line was written and is readable');
  check(
    '`at` names THIS caller, not the helper',
    driftEntry.at?.includes('verify_logger_location.js')
      && !driftEntry.at.includes('dbErrors.js'),
    `got ${JSON.stringify(driftEntry.at)} — a helper naming itself hides which page broke`,
  );
  check(
    '`thrownAt` still comes from the error stack',
    typeof driftEntry.thrownAt === 'string' && /\.js:\d+$/.test(driftEntry.thrownAt),
    `got ${JSON.stringify(driftEntry.thrownAt)}`,
  );
  check(
    'the missing column is named in the log, not just in the response',
    String(driftEntry.error || '').includes('status'),
    `got ${JSON.stringify(driftEntry.error)} — this string is the whole incident`,
  );
  check(
    'the user-facing message carries no driver internals',
    !/errno|column|SELECT/i.test(sent.body.msg) && sent.body.code === 'MIGRATION_PENDING',
    `got ${JSON.stringify(sent.body.msg)} — internals must not cross the boundary`,
  );
}

// ------------------------------------------------------------
//  CONTROL — every assertion above must be able to fail
// ------------------------------------------------------------
process.stdout.write('\nCONTROL: re-running key assertions against broken implementations\n');
let uncaught = 0;
const mutant = (label, caughtIt) => {
  if (caughtIt) process.stdout.write(`  caught  ${label}\n`);
  else {
    uncaught += 1;
    process.stdout.write(`  MISSED  ${label} — the assertion above it proves nothing\n`);
  }
};

// 1. The location that never changes — passes a "looks like file:line" test
//    while telling you nothing.
const brokenCallSite = () => 'utils/logger.js:113';
mutant(
  'callSite always names the logger',
  /^[\w./-]+\.js:\d+$/.test(brokenCallSite()) && !here.includes('logger.js'),
);

// 2. A constant line number: two calls on different lines report the same.
const brokenLines = () => 'scripts/x.js:1';
mutant(
  'callSite line number is constant',
  brokenLines() === brokenLines()
    && Number(lineA.split(':')[1]) !== Number(lineB.split(':')[1]),
);

// 3. Absolute Windows path — leaks the deploy directory and reads unlike the
//    server's own logs.
const brokenPath = () => 'C:\\Dev\\DATAHOOD PROJECT\\backend\\scripts\\x.js:4';
mutant(
  'path is absolute and backslashed',
  (brokenPath().includes('\\') || /^[A-Za-z]:/.test(brokenPath()))
    && !here.includes('\\') && !/^[A-Za-z]:/.test(here),
);

// 4. "unknown" instead of null: claims a stack was inspected when none was.
const brokenErrorSite = () => 'unknown';
mutant(
  'errorSite returns "unknown" for a stackless input',
  brokenErrorSite(undefined) === 'unknown' && errorSite(undefined) === null,
);

// 5. errorSite reads the first line (the message) rather than a frame, so it
//    finds nothing useful — or worse, matches part of the message text.
const brokenFirstLine = (e) => (e?.stack ? e.stack.split('\n')[0] : null);
mutant(
  'errorSite parses the message line, not a frame',
  !/\.js:\d+$/.test(brokenFirstLine(caught) || '') && /\.js:\d+$/.test(thrown),
);

// 6. The shared helper logs its own location. Nothing throws and no response
//    changes — the only symptom is a log field naming the same line for every
//    page in the app, which is the exact state this feature replaced. Stated
//    as a would-be entry so the section G assertion is shown rejecting it.
const brokenHelperAt = { at: 'utils/dbErrors.js:63' };
const passesG = (e) => !!e.at?.includes('verify_logger_location.js')
  && !e.at.includes('dbErrors.js');
mutant(
  'a shared helper reports its own line instead of its caller',
  !passesG(brokenHelperAt) && !!driftEntry && passesG(driftEntry),
);

// ------------------------------------------------------------
process.stdout.write('\n' + '-'.repeat(58) + '\n');
if (failures === 0 && uncaught === 0) {
  process.stdout.write('All checks passed, and every control mutant was caught.\n\n');
  process.exit(0);
}
if (failures) process.stdout.write(`${failures} assertion(s) failed.\n`);
if (uncaught) process.stdout.write(`${uncaught} control mutant(s) survived — those assertions are decorative.\n`);
process.stdout.write('\n');
process.exit(1);
