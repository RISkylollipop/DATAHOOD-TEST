// ============================================================
//  Transaction Receipt — PNG (client-side)
// ------------------------------------------------------------
//  A shareable receipt in the style customers already know from
//  their bank and Opay: brand mark top-left, "Transaction Receipt"
//  top-right, a CIRCULAR status badge, the amount as the headline,
//  then a clean label/value list.
//
//  Drawn entirely with the Canvas 2D API — no dependency to install
//  and nothing to keep in sync with a template file.
//
//  WHAT IT DELIBERATELY OMITS: wallet balance before/after. Those
//  live in the admin transaction view, where equal old/new balances
//  are the audit signal that a failure was reversed. A customer
//  receipt is proof of one transaction, not a statement, and leaking
//  a running balance into a screenshot the customer forwards to a
//  vendor is a privacy problem.
//
//  LOGO: loaded from `/logo.png` (drop the DATAHOOD PNG in
//  frontend/public/). If it is missing or fails to load the receipt
//  still renders — drawLogoFallback paints the DH monogram and
//  wordmark, so a missing asset can never break a download.
//
//  Usage: await downloadReceiptImage({ txn, siteName?, filename? })
//    txn: { transref, servicename, servicedesc, amount, statusLabel, date }
// ============================================================

import { brandText, formatNaira } from '../config';

// DATAHOOD brand: blue→cyan monogram over a deep navy wordmark.
const COLORS = {
  navy: '#10306b',
  blue: '#1668e0',
  cyan: '#1fc8d8',
  ink: '#0f172a',
  muted: '#6b7280',
  faint: '#9ca3af',
  line: '#f1f2f4',
  border: '#e5e7eb',
  bg: '#ffffff',
};

// Served from frontend/public. The base path keeps it correct if the app is
// ever hosted under a sub-path, and is read in a bundler-agnostic way: CRA
// inlines process.env.PUBLIC_URL, Vite has no `process` in the browser at
// all, so an unguarded read would throw ReferenceError there. The typeof
// guard means this file survives a CRA→Vite move untouched.
//
// It must stay SAME-ORIGIN: a logo pulled from a CDN would taint the canvas
// and make toBlob/toDataURL throw, breaking the download for every user.
const PUBLIC_BASE = (typeof process !== 'undefined' && process.env && process.env.PUBLIC_URL) || '';
const LOGO_SRC = `${PUBLIC_BASE}/logo.png`;

// Status → display label, colour, and the glyph drawn inside the circle.
// The glyph matters: a tick reads as done at a glance, which is what
// someone forwarding a receipt is trying to prove.
function statusStyle(label) {
  const k = String(label || '').toLowerCase();
  if (k === 'successful') return { text: 'SUCCESSFUL', color: '#0f9d58', glyph: 'check' };
  if (k === 'failed') return { text: 'FAILED', color: '#dc2626', glyph: 'cross' };
  if (k === 'refunded') return { text: 'REFUNDED', color: '#0891b2', glyph: 'back' };
  if (k === 'processing') return { text: 'PROCESSING', color: '#d97706', glyph: 'clock' };
  return { text: String(label || 'UNKNOWN').toUpperCase(), color: COLORS.muted, glyph: 'clock' };
}

// "7 Aug 2026, 19:35" — 24-hour, matching how Nigerian bank receipts
// print the time. config's formatDate gives a 12-hour string, so the
// receipt keeps its own formatter rather than changing that global.
function receiptDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  const day = dt.getDate();
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getMonth()];
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `${day} ${mon} ${dt.getFullYear()}, ${hh}:${mm}`;
}

// Rounded-rectangle path (ctx.roundRect isn't available everywhere).
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Word-wrap to a max pixel width using the current font.
function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Resolve the brand logo, or null if it isn't available.
 * Never rejects — a missing logo must not fail a receipt download.
 */
function loadLogo(src = LOGO_SRC) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth ? img : null);
      img.onerror = () => resolve(null);
      img.src = src;
    } catch {
      resolve(null);
    }
  });
}

/**
 * Draw the DH monogram + wordmark when /logo.png is absent.
 * Approximates the brand mark closely enough that a receipt never
 * looks unbranded, using the same blue→cyan gradient.
 */
function drawLogoFallback(ctx, x, y, h) {
  const box = h;
  const grad = ctx.createLinearGradient(x, y, x + box, y + box);
  grad.addColorStop(0, COLORS.blue);
  grad.addColorStop(1, COLORS.cyan);

  roundRect(ctx, x, y, box, box, box * 0.24);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(box * 0.5)}px Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('DH', x + box / 2, y + box / 2 + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  return box;
}

/** Glyph inside the circular status badge, drawn in white. */
function drawStatusGlyph(ctx, kind, cx, cy, r) {
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(2.5, r * 0.14);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  if (kind === 'check') {
    ctx.moveTo(cx - r * 0.42, cy + r * 0.02);
    ctx.lineTo(cx - r * 0.12, cy + r * 0.34);
    ctx.lineTo(cx + r * 0.45, cy - r * 0.34);
  } else if (kind === 'cross') {
    ctx.moveTo(cx - r * 0.32, cy - r * 0.32);
    ctx.lineTo(cx + r * 0.32, cy + r * 0.32);
    ctx.moveTo(cx + r * 0.32, cy - r * 0.32);
    ctx.lineTo(cx - r * 0.32, cy + r * 0.32);
  } else if (kind === 'back') {
    // Reversal arrow — an arc with a head, reading as "money returned".
    ctx.arc(cx, cy, r * 0.36, Math.PI * 0.75, Math.PI * 2.1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.42, cy - r * 0.06);
    ctx.lineTo(cx - r * 0.26, cy + r * 0.16);
    ctx.lineTo(cx - r * 0.04, cy - r * 0.02);
  } else {
    // Clock — pending/unknown.
    ctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.22);
    ctx.lineTo(cx, cy + r * 0.04);
    ctx.lineTo(cx + r * 0.2, cy + r * 0.16);
  }

  ctx.stroke();
}

/**
 * Draw the whole receipt at CSS-pixel coordinates. Returns the final y so
 * the caller can size the canvas — it runs once to measure, once for real.
 */
function drawReceipt(ctx, W, txn, siteName, logo) {
  const left = 30;
  const right = W - 30;
  const cw = right - left;
  let y = 34;

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // ---------- Header: logo left, title right ----------
  const logoH = 34;
  if (logo) {
    const ratio = logo.naturalWidth / logo.naturalHeight || 1;
    // Cap the width so a wide lockup can't collide with the title.
    const drawW = Math.min(logoH * ratio, 132);
    ctx.drawImage(logo, left, y, drawW, logoH);
  } else {
    drawLogoFallback(ctx, left, y, logoH);
    ctx.fillStyle = COLORS.navy;
    ctx.font = '700 15px Helvetica, Arial, sans-serif';
    ctx.fillText(siteName.toUpperCase(), left + logoH + 9, y + logoH / 2 + 5);
  }

  ctx.fillStyle = COLORS.muted;
  ctx.font = '400 11px Helvetica, Arial, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('Transaction Receipt', right, y + logoH / 2 + 4);
  ctx.textAlign = 'left';
  y += logoH + 22;

  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  y += 34;

  // ---------- Circular status badge ----------
  const st = statusStyle(txn.statusLabel);
  const r = 27;
  const cx = W / 2;
  const cy = y + r;

  // Soft halo, so the badge reads as a seal rather than a flat dot.
  ctx.beginPath();
  ctx.arc(cx, cy, r + 7, 0, Math.PI * 2);
  ctx.fillStyle = `${st.color}1a`;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = st.color;
  ctx.fill();

  drawStatusGlyph(ctx, st.glyph, cx, cy, r);
  y = cy + r + 26;

  ctx.textAlign = 'center';
  ctx.fillStyle = st.color;
  ctx.font = '700 13px Helvetica, Arial, sans-serif';
  ctx.fillText(st.text, cx, y);
  y += 26;

  // ---------- Amount headline ----------
  ctx.fillStyle = COLORS.ink;
  ctx.font = '700 30px Helvetica, Arial, sans-serif';
  ctx.fillText(formatNaira(txn.amount), cx, y);
  y += 30;
  ctx.textAlign = 'left';

  // ---------- Detail rows (NO balances) ----------
  const rows = [
    ['Reference', txn.transref],
    ['Service', txn.servicename],
    ['Description', brandText(txn.servicedesc)],
    ['Status', st.text],
    ['Date', receiptDate(txn.date)],
  ];
  if (txn.accountName) rows.push(['Account', txn.accountName]);

  // Label left, value right — the bank-receipt convention, and it keeps
  // long descriptions from crowding the label column.
  const labelW = 84;
  const valW = cw - labelW - 12;

  for (const [label, value] of rows) {
    if (value === null || value === undefined || value === '') continue;

    ctx.font = '400 11px Helvetica, Arial, sans-serif';
    const lines = wrapText(ctx, String(value), valW);
    const rowH = Math.max(22, lines.length * 15 + 8);

    ctx.fillStyle = COLORS.muted;
    ctx.fillText(label, left, y + 13);

    ctx.fillStyle = COLORS.ink;
    ctx.font = '600 11px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'right';
    let ly = y + 13;
    for (const ln of lines) {
      ctx.fillText(ln, right, ly);
      ly += 15;
    }
    ctx.textAlign = 'left';

    y += rowH;
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, y - 5);
    ctx.lineTo(right, y - 5);
    ctx.stroke();
  }

  // ---------- Footer ----------
  y += 20;
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.muted;
  ctx.font = '400 9.5px Helvetica, Arial, sans-serif';

  const foot = 'This receipt confirms the status of your transaction with us. '
    + `Thank you for using ${siteName}. Enjoy fast, reliable, and secure digital `
    + 'services with every transaction. Your trust matters to us.';
  for (const ln of wrapText(ctx, foot, cw - 20)) {
    ctx.fillText(ln, cx, y);
    y += 13;
  }

  y += 10;
  ctx.fillStyle = COLORS.faint;
  ctx.font = '400 9px Helvetica, Arial, sans-serif';
  ctx.fillText(`Generated ${receiptDate(new Date())}`, cx, y);
  y += 16;

  ctx.fillStyle = COLORS.navy;
  ctx.font = '700 11px Helvetica, Arial, sans-serif';
  ctx.fillText(siteName.toUpperCase(), cx, y);
  ctx.textAlign = 'left';
  y += 20;

  return y;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Render the receipt to a PNG and trigger a browser download.
 * Resolves once the download has been kicked off.
 */
export async function downloadReceiptImage({ txn, siteName = 'DATAHOOD', filename } = {}) {
  const W = 470;
  const scale = Math.max(2, Math.min(3, 2 * (window.devicePixelRatio || 1)));

  // Awaited before measuring: the logo's aspect ratio affects the header,
  // and measuring without it would size the canvas for a layout we then
  // don't draw.
  const logo = await loadLogo();

  // Measure pass — compute the required height.
  const measure = document.createElement('canvas');
  measure.width = W;
  measure.height = 1400;
  const contentH = drawReceipt(measure.getContext('2d'), W, txn, siteName, logo);
  const H = Math.ceil(contentH + 10);

  // Real canvas — high-DPI so it stays sharp when zoomed on a phone.
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(W * scale);
  canvas.height = Math.floor(H * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  drawReceipt(ctx, W, txn, siteName, logo);

  const name = filename || `receipt-${txn.transref}.png`;

  return new Promise((resolve, reject) => {
    if (canvas.toBlob) {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('Could not render receipt image')); return; }
        triggerDownload(blob, name);
        resolve();
      }, 'image/png');
    } else {
      // Fallback for older browsers without toBlob.
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      resolve();
    }
  });
}
