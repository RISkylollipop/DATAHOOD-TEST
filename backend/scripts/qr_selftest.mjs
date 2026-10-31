// Throwaway harness for utils/qrcode.js. Not part of the app.
// Run: node scripts/qr_selftest.mjs
//
// The hard problem here is that this environment has no npm registry access,
// so there is no reference encoder to diff against. Asserting my encoder
// against my own expectations would be circular and would pass just as
// happily if the whole thing were wrong. So verification leans on three
// things my implementation cannot quietly agree with:
//
//   1. PUBLISHED BYTE-MODE CAPACITIES (v1-v10 x L/M/Q/H). These are external
//      numbers the code never sees. They are a function of both
//      hand-transcribed ECC tables AND the rawDataModules formula, so a typo
//      in any of those three places breaks them.
//   2. REED-SOLOMON SYNDROMES. A valid RS codeword evaluates to zero at
//      alpha^0..alpha^(n-1). That is different arithmetic from the
//      polynomial long division rsEncode performs — it checks the result,
//      not the method.
//   3. A ROUND-TRIP DECODER that reverses the pipeline from the rendered
//      matrix: read format bits, unmask, unzigzag, de-interleave, parse.
//      Bit-order, mask and interleave errors cannot survive it.
import assert from 'assert';
import {
  encodeQr, qrToSvg, qrToDataUri, MAX_VERSION,
} from '../utils/qrcode.js';
import { otpauthUrl, generateSecret } from '../utils/totp.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
};

/* ================================================================== *
 * 1. Published byte-mode capacities — the external reference.        *
 * ================================================================== *
 * Widely published ISO/IEC 18004 figures. Independent of this codebase.
 * Overhead is 4 mode bits + an 8-bit count (v1-9) or 16-bit count (v10),
 * so capacity_bytes = floor((dataCodewords*8 - overhead) / 8).
 */
const PUBLISHED_BYTE_CAPACITY = {
  1: { L: 17, M: 14, Q: 11, H: 7 },
  2: { L: 32, M: 26, Q: 20, H: 14 },
  3: { L: 53, M: 42, Q: 32, H: 24 },
  4: { L: 78, M: 62, Q: 46, H: 34 },
  5: { L: 106, M: 84, Q: 60, H: 44 },
  6: { L: 134, M: 106, Q: 74, H: 58 },
  7: { L: 154, M: 122, Q: 86, H: 64 },
  8: { L: 192, M: 152, Q: 108, H: 84 },
  9: { L: 230, M: 180, Q: 130, H: 98 },
  10: { L: 271, M: 213, Q: 151, H: 119 },
};

// Probe capacity from the outside: the largest payload that still encodes at
// this version is exactly its byte capacity. Uses only the public API.
function probeCapacity(version, ecLevel) {
  let lo = 1;
  let hi = 300;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let got;
    try { got = encodeQr('A'.repeat(mid), { ecLevel, minVersion: version }).version; }
    catch { got = Infinity; }
    if (got === version) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best;
}

for (let v = 1; v <= MAX_VERSION; v += 1) {
  for (const ecl of ['L', 'M', 'Q', 'H']) {
    check(`capacity v${v}-${ecl} === ${PUBLISHED_BYTE_CAPACITY[v][ecl]} bytes (published)`, () => {
      assert.strictEqual(probeCapacity(v, ecl), PUBLISHED_BYTE_CAPACITY[v][ecl]);
    });
  }
}

/* ================================================================== *
 * GF(256) — reimplemented here on purpose.                            *
 * ================================================================== *
 * Deliberately NOT imported from utils/qrcode.js. If the module's field
 * tables were built wrong, importing them would make the syndrome check
 * agree with the bug.
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/* ================================================================== *
 * 2 + 3. Decoder: matrix -> text, with syndrome verification.         *
 * ================================================================== */

const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const NUM_EC_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const FORMAT_BITS_TO_ECL = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

function rawCodewordsOf(version) {
  let r = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const n = Math.floor(version / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (version >= 7) r -= 36;
  }
  return Math.floor(r / 8);
}

function alignPos(version) {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let p = version * 4 + 10; out.length < n; p -= step) out.splice(1, 0, p);
  return out;
}

/** Rebuild the function-module map independently, from the version alone. */
function functionMap(version) {
  const size = version * 4 + 17;
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => { if (x >= 0 && x < size && y >= 0 && y < size) fn[y][x] = true; };
  for (let i = 0; i < size; i += 1) { mark(6, i); mark(i, 6); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) mark(cx + dx, cy + dy);
  }
  const al = alignPos(version);
  for (let i = 0; i < al.length; i += 1) {
    for (let j = 0; j < al.length; j += 1) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === al.length - 1)
        || (i === al.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) mark(al[i] + dx, al[j] + dy);
    }
  }
  // Format areas.
  for (let i = 0; i <= 8; i += 1) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i += 1) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
  mark(8, size - 8);
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      mark(size - 11 + (i % 3), Math.floor(i / 3));
      mark(Math.floor(i / 3), size - 11 + (i % 3));
    }
  }
  return fn;
}

function maskFn(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: throw new Error(`bad mask ${mask}`);
  }
}

/** Read the 15 format bits from copy 1 and BCH-decode by nearest neighbour. */
function readFormat(modules, size) {
  let raw = 0;
  const get = (x, y) => (modules[y][x] ? 1 : 0);
  for (let i = 0; i <= 5; i += 1) raw |= get(8, i) << i;
  raw |= get(8, 7) << 6;
  raw |= get(8, 8) << 7;
  raw |= get(7, 8) << 8;
  for (let i = 9; i < 15; i += 1) raw |= get(14 - i, 8) << i;

  // Brute-force nearest valid codeword — independent of the encoder's BCH.
  let best = -1;
  let bestDist = 99;
  for (let d = 0; d < 32; d += 1) {
    let rem = d;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const valid = (((d << 10) | rem) ^ 0x5412) & 0x7fff;
    let dist = 0;
    let x = valid ^ raw;
    while (x) { dist += x & 1; x >>>= 1; }
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  assert.ok(bestDist === 0, `format bits are not a valid codeword (hamming distance ${bestDist})`);
  return { ecLevel: FORMAT_BITS_TO_ECL[best >> 3], mask: best & 7 };
}

/** Full reverse pipeline. Throws with a specific message on any mismatch. */
function decodeQr(sym) {
  const { modules, size } = sym;
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version), `size ${size} is not a valid QR dimension`);

  const { ecLevel, mask } = readFormat(modules, size);
  const fn = functionMap(version);

  // Unmask.
  const grid = modules.map((row) => row.slice());
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!fn[r][c] && maskFn(mask, r, c)) grid[r][c] = !grid[r][c];
    }
  }

  // Un-zigzag.
  const total = rawCodewordsOf(version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && bits.length < total * 8) bits.push(grid[y][x] ? 1 : 0);
      }
    }
  }
  assert.strictEqual(bits.length, total * 8, 'wrong number of data modules read');
  const cw = new Uint8Array(total);
  for (let i = 0; i < bits.length; i += 1) cw[i >>> 3] |= bits[i] << (7 - (i & 7));

  // De-interleave.
  const numBlocks = NUM_EC_BLOCKS[ecLevel][version];
  const eccLen = ECC_PER_BLOCK[ecLevel][version];
  const numShort = numBlocks - (total % numBlocks);
  const shortLen = Math.floor(total / numBlocks) - eccLen;
  const blocks = Array.from({ length: numBlocks }, (_, b) => ({
    dat: [], ecc: [], len: shortLen + (b < numShort ? 0 : 1),
  }));
  let k = 0;
  for (let i = 0; i <= shortLen; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) if (i < blocks[b].len) blocks[b].dat.push(cw[k++]);
  }
  for (let i = 0; i < eccLen; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) blocks[b].ecc.push(cw[k++]);
  }
  assert.strictEqual(k, total, 'de-interleave consumed the wrong number of codewords');

  // *** Syndrome check — the independent RS verification. ***
  blocks.forEach((blk, bi) => {
    const full = [...blk.dat, ...blk.ecc];
    for (let s = 0; s < eccLen; s += 1) {
      let acc = 0;
      for (const coef of full) acc = mul(acc, EXP[s]) ^ coef;
      assert.strictEqual(acc, 0, `block ${bi} syndrome ${s} is ${acc}, expected 0`);
    }
  });

  // Parse the data stream.
  const data = blocks.flatMap((b) => b.dat);
  const dbits = [];
  for (const byte of data) for (let i = 7; i >= 0; i -= 1) dbits.push((byte >> i) & 1);
  const take = (n) => { let v = 0; for (let i = 0; i < n; i += 1) v = (v << 1) | dbits.shift(); return v; };
  assert.strictEqual(take(4), 0b0100, 'mode indicator is not byte mode');
  const len = take(version <= 9 ? 8 : 16);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) out[i] = take(8);
  return {
    text: new TextDecoder().decode(out), version, ecLevel, mask, data,
  };
}

/* ================================================================== *
 * Round-trip tests.                                                   *
 * ================================================================== */

const SAMPLES = [
  'A',
  'HELLO WORLD',
  'https://kwarapolydata.com.ng/',
  otpauthUrl({ secret: generateSecret(), account: 'admin@kwarapolydata.com.ng' }),
  'x'.repeat(100),
  'Ilorin — naïve café €£¥',   // multi-byte UTF-8
  JSON.stringify({ a: 1, b: 'two', c: [3, 4, 5] }),
];

for (const ecl of ['L', 'M', 'Q', 'H']) {
  for (const text of SAMPLES) {
    const label = text.length > 28 ? `${text.slice(0, 28)}...` : text;
    check(`round-trip [${ecl}] ${JSON.stringify(label)}`, () => {
      const byteLen = new TextEncoder().encode(text).length;
      // Some payloads genuinely do not fit at the stronger EC levels — H
      // spends over half the symbol on parity. That is not a bug, so assert
      // the throw is CORRECT against the published capacity rather than
      // either failing the suite or silently skipping (which would hide a
      // real overflow bug behind a legitimate-looking one).
      if (byteLen > PUBLISHED_BYTE_CAPACITY[MAX_VERSION][ecl]) {
        assert.throws(() => encodeQr(text, { ecLevel: ecl }), /exceeds version 10/);
        return;
      }
      const sym = encodeQr(text, { ecLevel: ecl });
      const dec = decodeQr(sym);
      assert.strictEqual(dec.text, text);
      assert.strictEqual(dec.ecLevel, ecl, 'decoded EC level disagrees');
      assert.strictEqual(dec.mask, sym.mask, 'decoded mask disagrees');
      assert.strictEqual(dec.version, sym.version, 'decoded version disagrees');
    });
  }
}

// Every version, so the v7+ version-info block and multi-block interleaving
// are both exercised rather than assumed.
for (let v = 1; v <= MAX_VERSION; v += 1) {
  check(`round-trip at exactly version ${v}`, () => {
    const payload = 'D'.repeat(PUBLISHED_BYTE_CAPACITY[v].M);
    const sym = encodeQr(payload, { ecLevel: 'M', minVersion: v });
    assert.strictEqual(sym.version, v, `expected v${v}, got v${sym.version}`);
    assert.strictEqual(decodeQr(sym).text, payload);
  });
}

/* ================================================================== *
 * Structural invariants a scanner depends on.                         *
 * ================================================================== */

const sym = encodeQr('https://kwarapolydata.com.ng/', { ecLevel: 'M' });

check('three finder patterns, correct 1:1:3:1:1 geometry', () => {
  const { modules, size } = sym;
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -3; dy <= 3; dy += 1) {
      for (let dx = -3; dx <= 3; dx += 1) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        assert.strictEqual(modules[cy + dy][cx + dx], d !== 2, `finder @${cx},${cy} +${dx},${dy}`);
      }
    }
  }
});

check('bottom-right corner has NO finder (orientation marker)', () => {
  const { modules, size } = sym;
  let dark = 0;
  for (let y = size - 7; y < size; y += 1) for (let x = size - 7; x < size; x += 1) if (modules[y][x]) dark += 1;
  assert.notStrictEqual(dark, 33, 'a fourth finder would destroy orientation detection');
});

// Alignment patterns: dark 5x5 border, light ring, dark centre.
//
// The round-trip decoder is structurally BLIND to this — it only needs to
// know where alignment patterns sit in order to skip them, never what they
// contain, so a fully inverted pattern still decodes here. A phone camera
// uses them to correct perspective distortion, so getting this wrong yields
// a symbol that this harness reads and a real scanner struggles with. Added
// after mutation testing showed an inverted pattern surviving the entire
// suite. Only versions >= 2 have them.
for (let v = 2; v <= MAX_VERSION; v += 1) {
  check(`alignment patterns have correct geometry at v${v}`, () => {
    const s = encodeQr('D'.repeat(PUBLISHED_BYTE_CAPACITY[v].M), { ecLevel: 'M', minVersion: v });
    assert.strictEqual(s.version, v);
    const al = alignPos(v);
    let checked = 0;
    for (let i = 0; i < al.length; i += 1) {
      for (let j = 0; j < al.length; j += 1) {
        const corner = (i === 0 && j === 0) || (i === 0 && j === al.length - 1)
          || (i === al.length - 1 && j === 0);
        if (corner) continue;
        const cx = al[i];
        const cy = al[j];
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const ring = Math.max(Math.abs(dx), Math.abs(dy));
            // ring 0 = dark centre, ring 1 = light, ring 2 = dark border.
            assert.strictEqual(s.modules[cy + dy][cx + dx], ring !== 1,
              `alignment @${cx},${cy} offset ${dx},${dy} (ring ${ring})`);
          }
        }
        checked += 1;
      }
    }
    assert.ok(checked > 0, `v${v} should have at least one non-corner alignment pattern`);
  });
}

check('timing patterns alternate, starting dark', () => {
  const { modules, size } = sym;
  for (let i = 8; i < size - 8; i += 1) {
    assert.strictEqual(modules[6][i], i % 2 === 0, `h timing @${i}`);
    assert.strictEqual(modules[i][6], i % 2 === 0, `v timing @${i}`);
  }
});

check('the always-dark module is dark', () => {
  assert.strictEqual(sym.modules[sym.size - 8][8], true);
});

check('separators around finders are light', () => {
  const { modules, size } = sym;
  for (let i = 0; i < 8; i += 1) {
    assert.strictEqual(modules[7][i], false, `top-left h sep @${i}`);
    assert.strictEqual(modules[i][7], false, `top-left v sep @${i}`);
    assert.strictEqual(modules[7][size - 1 - i], false, `top-right sep @${i}`);
    assert.strictEqual(modules[size - 1 - i][7], false, `bottom-left sep @${i}`);
  }
});

check('both format-info copies carry the same value', () => {
  const { modules, size } = sym;
  const g = (x, y) => (modules[y][x] ? 1 : 0);
  let c1 = 0;
  for (let i = 0; i <= 5; i += 1) c1 |= g(8, i) << i;
  c1 |= g(8, 7) << 6; c1 |= g(8, 8) << 7; c1 |= g(7, 8) << 8;
  for (let i = 9; i < 15; i += 1) c1 |= g(14 - i, 8) << i;
  let c2 = 0;
  for (let i = 0; i < 8; i += 1) c2 |= g(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i += 1) c2 |= g(8, size - 15 + i) << i;
  assert.strictEqual(c1, c2, 'the redundant format copies disagree');
});

check('mask is one of the 8 defined patterns', () => {
  assert.ok(Number.isInteger(sym.mask) && sym.mask >= 0 && sym.mask < 8, String(sym.mask));
});

// Padding is invisible to a decoder — it stops reading at the character
// count — so nothing above can see these bytes, and a mutant that made them
// constant survived the whole suite. The spec mandates alternating 0xEC/0x11
// specifically; decoders use the pattern to distinguish padding from
// corrupted data, and some strict scanners reject a symbol without it.
check('pad codewords alternate 0xEC / 0x11 as the spec mandates', () => {
  const short = 'hi'; // tiny payload => almost the whole symbol is padding
  const dec = decodeQr(encodeQr(short, { ecLevel: 'L' }));
  // 4 mode bits + 8 count bits + 2 data bytes + 4 terminator bits, padded to
  // a byte boundary => padding starts at byte 4.
  const padding = dec.data.slice(4);
  assert.ok(padding.length >= 4, 'expected a meaningful run of padding');
  padding.forEach((b, i) => {
    const expected = i % 2 === 0 ? 0xec : 0x11;
    assert.strictEqual(b, expected,
      `pad byte ${i} is 0x${b.toString(16)}, expected 0x${expected.toString(16)}`);
  });
});

check('mask selection actually varies with content', () => {
  const masks = new Set(['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'ggggggg', 'hhhhhhhh',
    'test1', 'test22', 'test333', 'zzzz zzzz', 'https://x.ng/1', 'https://x.ng/22']
    .map((t) => encodeQr(t).mask));
  assert.ok(masks.size > 1, 'every payload picked the same mask - selection is likely a no-op');
});

/* ================================================================== *
 * Rendering.                                                          *
 * ================================================================== */

check('SVG has a >=4-module quiet zone and correct dimensions', () => {
  const svg = qrToSvg('test', { scale: 6, border: 4 });
  const s = encodeQr('test').size;
  const dim = (s + 8) * 6;
  assert.ok(svg.includes(`width="${dim}"`), `expected width ${dim}`);
  assert.ok(svg.includes(`viewBox="0 0 ${dim} ${dim}"`));
  // No dark module may fall inside the quiet zone.
  const minCoord = 4 * 6;
  for (const m of svg.matchAll(/M(\d+) (\d+)h/g)) {
    assert.ok(Number(m[1]) >= minCoord && Number(m[2]) >= minCoord, `module at ${m[1]},${m[2]} is inside the quiet zone`);
  }
});

// The DEFAULT quiet zone, with no border argument. Passing border:4
// explicitly above tests the caller, not the default — a default silently
// shrunk to 2 survived the whole suite until this was added. It matters
// because almost every caller will omit the argument, and a too-small quiet
// zone is the most common cause of a QR that renders perfectly and will not
// scan against a busy background.
check('DEFAULT quiet zone is the spec-required 4 modules', () => {
  const svg = qrToSvg('test', { scale: 6 });
  const s = encodeQr('test').size;
  assert.ok(svg.includes(`width="${(s + 8) * 6}"`),
    'default border is not 4 modules — scanners will fail against busy backgrounds');
  for (const m of svg.matchAll(/M(\d+) (\d+)h/g)) {
    assert.ok(Number(m[1]) >= 24 && Number(m[2]) >= 24, `module at ${m[1]},${m[2]} intrudes on the default quiet zone`);
  }
});

check('SVG is well-formed and single-path', () => {
  const svg = qrToSvg('test');
  assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>'));
  assert.strictEqual((svg.match(/<path/g) || []).length, 1);
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
});

check('data URI is base64 and decodes back to the same SVG', () => {
  const uri = qrToDataUri('test');
  assert.ok(uri.startsWith('data:image/svg+xml;base64,'));
  const svg = Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
  assert.strictEqual(svg, qrToSvg('test'));
  // '#' unescaped in a utf8 data URI would truncate at the colour literal.
  assert.ok(!uri.includes('#'));
});

/* ================================================================== *
 * Failure modes.                                                      *
 * ================================================================== */

check('rejects empty and non-string input', () => {
  for (const bad of ['', null, undefined, 42, {}]) assert.throws(() => encodeQr(bad), /non-empty string/);
});
check('rejects an unknown EC level', () => {
  assert.throws(() => encodeQr('x', { ecLevel: 'Z' }), /unknown ecLevel/);
});
check('overflow throws a descriptive error rather than truncating', () => {
  assert.throws(() => encodeQr('x'.repeat(5000)), /exceeds version 10/);
  // The silent-truncation failure mode: a code that scans but yields the
  // wrong secret would be far worse than a thrown error.
  assert.throws(() => encodeQr('x'.repeat(272), { ecLevel: 'L' }), /exceeds version 10/);
});
// The actual production payload, at the level the enrolment screen will use.
// Kept as its own check because a regression here breaks admin enrolment
// specifically, and the generic round-trip tests would not point at it.
check('the real enrolment payload fits with headroom at EC level M', () => {
  const url = otpauthUrl({ secret: generateSecret(), account: 'administrator@kwarapolydata.com.ng' });
  const s = encodeQr(url, { ecLevel: 'M' });
  assert.ok(s.version <= 9, `otpauth URI needed v${s.version}, leaving no margin below the v10 cap`);
  assert.strictEqual(decodeQr(s).text, url);
});
check('even an unusually long admin address still enrols', () => {
  const url = otpauthUrl({ secret: generateSecret(), account: 'a.very.long.administrator.address@kwarapolydata.com.ng' });
  const s = encodeQr(url, { ecLevel: 'M' });
  assert.strictEqual(decodeQr(s).text, url, 'a long email must not break the QR');
});

console.log(`\n  ${pass} assertions passed${process.exitCode ? ' (with failures above)' : ''}`);
