/**
 * Noblesmegadata — dependency-free QR encoder (ISO/IEC 18004), byte mode.
 *
 * Exists for exactly one job: rendering the otpauth:// URI from utils/totp.js
 * as something an admin can point Google Authenticator at. It is NOT a
 * general-purpose imaging library, and the deliberate limits below reflect
 * that.
 *
 * WHY HAND-ROLLED. Adding `qrcode` to package.json would pull a dependency
 * tree into a process that holds JWT signing keys and a live payment
 * credential, to draw ~150 bytes of black squares. The whole algorithm is
 * ~350 lines of pure arithmetic with no I/O, no network and no native
 * binding — cheaper to own than to audit.
 *
 * NO NATIVE BINDINGS, BY DESIGN. Like utils/totp.js this module imports
 * nothing at all, not even node:crypto. It is pure math over Uint8Arrays, so
 * it cannot become unloadable the way a platform-specific binding can.
 *
 * VERSIONS 1-10 ONLY. That is 271 bytes at EC level L and 213 at level M.
 * An otpauth URI for this platform runs ~150 bytes, so there is comfortable
 * headroom; encodeQr throws a descriptive error rather than silently
 * truncating if a caller ever exceeds it. Versions 11-40 would need two more
 * hand-transcribed tables whose only purpose would be capacity nobody uses,
 * and every hand-transcribed constant is a chance to be subtly wrong.
 *
 * Output is SVG, not PNG: a QR code is pure geometry, so a raster encoder
 * would be a second pile of hand-rolled code (CRC32, zlib, scanline filters)
 * to produce a blurrier result. SVG also scales to any screen density, which
 * matters because this gets scanned off a monitor by a phone camera.
 */

/* ------------------------------------------------------------------ *
 * Error-correction tables (the only hand-transcribed constants here). *
 * ------------------------------------------------------------------ *
 * Everything else — codeword capacity, block sizes, alignment pattern
 * positions — is COMPUTED from the version below rather than tabulated,
 * because a derived value cannot drift out of sync with the spec through a
 * typo. scripts/qr_selftest.mjs asserts the invariant that ties these two
 * tables together: for every version and level,
 *     numBlocks * eccPerBlock + dataCodewords === rawCodewords
 * A transcription error in either row breaks that identity loudly.
 */
const ECC_PER_BLOCK = {
  //     v1  v2  v3  v4  v5  v6  v7  v8  v9 v10
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};

const NUM_EC_BLOCKS = {
  //     v1 v2 v3 v4 v5 v6 v7 v8 v9 v10
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};

/* Format-info bit pattern per EC level. Note these are NOT in strength
   order — M is 0 and L is 1. Getting this backwards produces a QR that
   scanners reject outright, since the format bits are what tells the
   decoder how to correct the rest. */
const ECL_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

export const MIN_VERSION = 1;
export const MAX_VERSION = 10;

/* ------------------------------------------------------------------ *
 * GF(256) arithmetic for Reed-Solomon.                                *
 * ------------------------------------------------------------------ */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    // Multiply by the generator (2), reducing mod the QR primitive
    // polynomial x^8 + x^4 + x^3 + x^2 + 1 = 0x11D.
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  // Duplicated tail lets gfMul add two logs (max 508) without a modulo.
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Generator polynomial for `degree` EC codewords, highest power first. */
function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon remainder — the EC codewords for one block. */
function rsEncode(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const buf = new Uint8Array(data.length + ecCount);
  buf.set(data, 0);
  for (let i = 0; i < data.length; i += 1) {
    const coef = buf[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j += 1) buf[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return buf.slice(data.length);
}

/* ------------------------------------------------------------------ *
 * Capacity, derived from the version rather than tabulated.           *
 * ------------------------------------------------------------------ */

/** Modules available to data+EC, i.e. total minus every function pattern. */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36; // the two version-information blocks
  }
  return result;
}

function rawCodewords(version) {
  return Math.floor(rawDataModules(version) / 8);
}

function dataCodewords(version, ecLevel) {
  return rawCodewords(version)
    - ECC_PER_BLOCK[ecLevel][version] * NUM_EC_BLOCKS[ecLevel][version];
}

/** Centre coordinates of the alignment patterns. Computed, not tabulated. */
function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Bit buffer.                                                         *
 * ------------------------------------------------------------------ */

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

/* ------------------------------------------------------------------ *
 * Encoder.                                                            *
 * ------------------------------------------------------------------ */

/**
 * Encode `text` as a QR symbol.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {'L'|'M'|'Q'|'H'} [opts.ecLevel='M']  M is the sensible default for
 *   a code scanned off a screen: it tolerates ~15% damage, which covers
 *   glare and a smudged monitor without inflating the symbol.
 * @param {number} [opts.minVersion=1]
 * @returns {{version:number, size:number, ecLevel:string, mask:number,
 *            modules:boolean[][]}}  modules[row][col], true = dark.
 */
export function encodeQr(text, { ecLevel = 'M', minVersion = MIN_VERSION } = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('encodeQr: text must be a non-empty string');
  }
  if (!ECC_PER_BLOCK[ecLevel]) {
    throw new Error(`encodeQr: unknown ecLevel ${JSON.stringify(ecLevel)} (expected L, M, Q or H)`);
  }

  // Byte mode throughout: an otpauth URI contains lowercase letters, ':',
  // '@', '?' and '&', none of which exist in QR's alphanumeric charset. A
  // fallback to alphanumeric would never fire here and would add a branch
  // that is never exercised, so there isn't one.
  const bytes = new TextEncoder().encode(text);

  let version = minVersion;
  while (version <= MAX_VERSION) {
    // Char-count indicator is 8 bits for v1-9 and 16 bits from v10 up, so
    // capacity is computed per candidate version rather than once.
    const capacityBits = dataCodewords(version, ecLevel) * 8;
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= capacityBits) break;
    version += 1;
  }
  if (version > MAX_VERSION) {
    throw new Error(
      `encodeQr: ${bytes.length} bytes exceeds version ${MAX_VERSION} at EC level ${ecLevel} `
      + `(max ${dataCodewords(MAX_VERSION, ecLevel)} data codewords). `
      + 'Shorten the payload or lower ecLevel.',
    );
  }

  const numDataCodewords = dataCodewords(version, ecLevel);
  const bits = [];
  appendBits(bits, 0b0100, 4);                              // byte mode
  appendBits(bits, bytes.length, version <= 9 ? 8 : 16);    // char count
  for (const b of bytes) appendBits(bits, b, 8);

  // Terminator (up to 4 zero bits), then pad to a byte boundary.
  const capacity = numDataCodewords * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  // Spec-mandated alternating filler. Not arbitrary: decoders rely on these
  // exact values to distinguish padding from data.
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) {
    appendBits(bits, pad, 8);
  }

  const dataBytes = new Uint8Array(numDataCodewords);
  for (let i = 0; i < bits.length; i += 1) {
    dataBytes[i >>> 3] |= bits[i] << (7 - (i & 7));
  }

  const codewords = interleaveBlocks(dataBytes, version, ecLevel);
  return buildMatrix(codewords, version, ecLevel);
}

/**
 * Split into EC blocks, compute parity, then interleave.
 *
 * Interleaving is what makes the error correction worth having: a scratch or
 * glare spot damages a contiguous run of modules, and spreading each block's
 * codewords across the whole symbol turns one unrecoverable burst into a few
 * recoverable errors per block.
 */
function interleaveBlocks(data, version, ecLevel) {
  const numBlocks = NUM_EC_BLOCKS[ecLevel][version];
  const eccLen = ECC_PER_BLOCK[ecLevel][version];
  const total = rawCodewords(version);
  // The spec's "group 1 / group 2" split, derived: the short blocks come
  // first and the remainder get one extra data codeword each.
  const numShort = numBlocks - (total % numBlocks);
  const shortLen = Math.floor(total / numBlocks) - eccLen;

  const blocks = [];
  for (let i = 0, offset = 0; i < numBlocks; i += 1) {
    const len = shortLen + (i < numShort ? 0 : 1);
    const dat = data.slice(offset, offset + len);
    offset += len;
    blocks.push({ dat, ecc: rsEncode(dat, eccLen) });
  }

  const result = new Uint8Array(total);
  let k = 0;
  for (let i = 0; i <= shortLen; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) {
      // Short blocks have no codeword at index shortLen — skip, don't pad.
      if (i < blocks[b].dat.length) result[k++] = blocks[b].dat[i];
    }
  }
  for (let i = 0; i < eccLen; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) result[k++] = blocks[b].ecc[i];
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Matrix construction.                                                *
 * ------------------------------------------------------------------ */

function buildMatrix(codewords, version, ecLevel) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  // Function modules must never be masked or overwritten by data, so where
  // they are is tracked separately from what they contain.
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFn = (col, row, dark) => {
    modules[row][col] = dark;
    isFunction[row][col] = true;
  };

  // Timing patterns first: the alternating run that lets a scanner measure
  // module pitch. Drawn before the finders so the finder loop can overwrite
  // the overlapping cells with the correct values.
  for (let i = 0; i < size; i += 1) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // Finder patterns + separators. dist is the Chebyshev ring index, so
  // rings 0,1 dark / 2 light / 3 dark / 4 light draws the 7x7 eye plus its
  // one-module white separator in a single expression.
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // Alignment patterns everywhere except the three finder corners.
  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i += 1) {
    for (let j = 0; j < align.length; j += 1) {
      const corner = (i === 0 && j === 0)
        || (i === 0 && j === align.length - 1)
        || (i === align.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFn(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Version information (v7+), BCH(18,6).
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vBits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const bit = ((vBits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, bit);
      setFn(b, a, bit);
    }
  }

  // Reserve the format area before laying data, so the zigzag skips it.
  drawFormatBits(setFn, size, ecLevel, 0);

  drawCodewords(modules, isFunction, size, codewords);

  // Try all 8 masks and keep the least-penalised. This is not cosmetic:
  // masking is what stops large blank runs or accidental finder-lookalikes
  // from appearing in the data region and confusing a scanner.
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(modules, isFunction, size, mask);
    drawFormatBits(setFn, size, ecLevel, mask);
    const penalty = penaltyScore(modules, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    applyMask(modules, isFunction, size, mask); // XOR is its own inverse
  }
  applyMask(modules, isFunction, size, bestMask);
  drawFormatBits(setFn, size, ecLevel, bestMask);

  return { version, size, ecLevel, mask: bestMask, modules };
}

/** Format info: 5 data bits -> BCH(15,5), XOR 0x5412, written twice. */
function drawFormatBits(setFn, size, ecLevel, mask) {
  const data = (ECL_FORMAT_BITS[ecLevel] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  // The XOR mask stops an all-zero format (level M, mask 0) from producing a
  // blank strip that a scanner cannot lock onto.
  const bits = (((data << 10) | rem) ^ 0x5412) & 0x7fff;
  const bit = (i) => ((bits >>> i) & 1) === 1;

  // Copy 1, wrapped around the top-left finder.
  for (let i = 0; i <= 5; i += 1) setFn(8, i, bit(i));
  setFn(8, 7, bit(6));
  setFn(8, 8, bit(7));
  setFn(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) setFn(14 - i, 8, bit(i));

  // Copy 2, split between the other two finders. Redundant on purpose: a
  // symbol with one corner damaged is still decodable.
  for (let i = 0; i < 8; i += 1) setFn(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) setFn(8, size - 15 + i, bit(i));
  setFn(8, size - 8, true); // the always-dark module
}

/** Zigzag placement: two columns at a time, bottom-right upward first. */
function drawCodewords(modules, isFunction, size, codewords) {
  let i = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern; the pairing skips over it.
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < totalBits) {
          modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i += 1;
        }
        // Any leftover modules stay light — the spec's remainder bits.
      }
    }
  }
}

function applyMask(modules, isFunction, size, mask) {
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (isFunction[row][col]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (row + col) % 2 === 0; break;
        case 1: invert = row % 2 === 0; break;
        case 2: invert = col % 3 === 0; break;
        case 3: invert = (row + col) % 3 === 0; break;
        case 4: invert = (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0; break;
        case 5: invert = ((row * col) % 2) + ((row * col) % 3) === 0; break;
        case 6: invert = (((row * col) % 2) + ((row * col) % 3)) % 2 === 0; break;
        case 7: invert = (((row + col) % 2) + ((row * col) % 3)) % 2 === 0; break;
        default: throw new Error(`applyMask: bad mask ${mask}`);
      }
      if (invert) modules[row][col] = !modules[row][col];
    }
  }
}

/** The four spec penalty rules; lower is better. */
function penaltyScore(modules, size) {
  let score = 0;

  // Rule 1 — runs of 5+ identical modules in a row or column.
  for (let i = 0; i < size; i += 1) {
    for (const isRow of [true, false]) {
      let runColor = null;
      let runLength = 0;
      for (let j = 0; j < size; j += 1) {
        const c = isRow ? modules[i][j] : modules[j][i];
        if (c === runColor) {
          runLength += 1;
          if (runLength === 5) score += 3;
          else if (runLength > 5) score += 1;
        } else {
          runColor = c;
          runLength = 1;
        }
      }
    }
  }

  // Rule 2 — every 2x2 block of one colour.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  // Rule 3 — finder-lookalike 1:1:3:1:1 with four light modules on a side.
  // These are what a scanner uses to locate the symbol, so an accidental one
  // in the data region can make the whole code unreadable.
  const P1 = [true, false, true, true, true, false, true, false, false, false, false];
  const P2 = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get, start) => {
    let a = true;
    let b = true;
    for (let k = 0; k < 11; k += 1) {
      const v = get(start + k);
      if (v !== P1[k]) a = false;
      if (v !== P2[k]) b = false;
      if (!a && !b) return 0;
    }
    return (a ? 40 : 0) + (b ? 40 : 0);
  };
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j <= size - 11; j += 1) {
      score += matches((k) => modules[i][k], j);
      score += matches((k) => modules[k][i], j);
    }
  }

  // Rule 4 — deviation from a 50/50 light/dark balance.
  let dark = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) if (modules[r][c]) dark += 1;
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/* ------------------------------------------------------------------ *
 * Rendering.                                                          *
 * ------------------------------------------------------------------ */

/**
 * Render as an SVG string.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.scale=6]   pixels per module
 * @param {number} [opts.border=4]  quiet-zone width IN MODULES. The spec
 *   requires 4 and scanners genuinely fail without it — a QR flush against
 *   surrounding page content is the single most common "why won't this
 *   scan" cause. Do not set this below 4 to save layout space.
 * @param {string} [opts.dark='#000000']
 * @param {string} [opts.light='#ffffff']
 */
export function qrToSvg(text, {
  ecLevel = 'M', scale = 6, border = 4, dark = '#000000', light = '#ffffff',
} = {}) {
  const { modules, size } = encodeQr(text, { ecLevel });
  const dim = (size + border * 2) * scale;

  // One <path> of subpaths rather than one <rect> per module: a v10 symbol
  // is 57x57, and ~1600 rect elements is a needlessly heavy DOM for the
  // browser to lay out.
  const parts = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) {
        parts.push(`M${(c + border) * scale} ${(r + border) * scale}h${scale}v${scale}h-${scale}z`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" `
    + `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" `
    + `aria-label="QR code">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path d="${parts.join('')}" fill="${dark}"/>`
    + '</svg>';
}

/**
 * Render as a data: URI, ready for an <img src>.
 *
 * Base64 rather than a raw utf8 data URI because the SVG contains '#' in its
 * colour literals, which terminates a URI as a fragment and yields a broken
 * image that is painful to diagnose.
 */
export function qrToDataUri(text, opts = {}) {
  const svg = qrToSvg(text, opts);
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
