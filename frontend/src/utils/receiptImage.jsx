// ============================================================
//  Transaction Receipt — PNG (client-side)
// ------------------------------------------------------------
//  A shareable receipt in the style customers already know from
//  their bank and Opay: brand mark top-left, "Transaction Receipt"
//  top-right, a CIRCULAR status badge, what was delivered as the
//  headline, then a clean label/value list.
//
//  Drawn entirely with the Canvas 2D API — no dependency to install
//  and nothing to keep in sync with a template file.
//
//  ============ NO MONEY FIGURES. EVER. ============
//  This receipt carries NO amount, price, balance, discount or total.
//
//  Our users are RESELLERS. They buy at a discounted rate and sell on
//  at their own markup, and this is the document they hand to THEIR
//  customer as proof of delivery. Any figure printed here tells that
//  customer what the reseller paid, and so exactly what margin they
//  are taking. It would damage the user's business.
//
//  The reseller still sees everything — amount, balance before and
//  after — in the transaction list and detail view in their own
//  dashboard. Full detail for the account holder; delivery proof for
//  the person they sold to.
//
//  Wallet balances were already omitted for the same family of
//  reasons: equal old/new balances are the admin-side audit signal
//  that a failure was reversed, and a running balance in a screenshot
//  the customer forwards on is a privacy problem besides.
//
//  Watch the DESCRIPTION, not just the labels. servicedesc arrives as
//  e.g. "MTN Airtime purchase of N500 for 0801..." — the price is
//  inside the sentence. stripMoney() removes it at render time; the
//  stored string keeps the amount because the dashboard, search and
//  duplicate-detection all depend on it.
//  =================================================
//
//  LOGO: loaded from `/logo.png` (drop the DATAHOOD PNG in
//  frontend/public/). If it is missing or fails to load the receipt
//  still renders — drawLogoFallback paints the DH monogram and
//  wordmark, so a missing asset can never break a download.
//
//  Usage: await downloadReceiptImage({ txn, siteName?, filename? })
//    txn: { transref, servicename, servicedesc, statusLabel, date }
//    `amount` is ignored even when present.
// ============================================================

// formatNaira is deliberately NOT imported. This renderer must not be able
// to print a money figure — see the money rule in the header comment.
import { brandText } from '../config';

/**
 * Strip any money figure out of a description before it goes on the receipt.
 *
 * Must stay behaviourally identical to stripMoney() in
 * backend/utils/transactionReceipt.js — the PNG and the PDF are twins and
 * have to render the same sentence for the same transaction.
 *
 * The `\b`-less "MTN" case is the trap: a naive /N\s?\d/ turns "MTN 1GB"
 * into "MT GB". Here the N in "MTN" is preceded by a word character so the
 * (?:₦|NGN|N) alternation only fires where a real figure follows a boundary.
 */
export function stripMoney(text) {
  return String(text || '')
    .replace(/(?:\s*\b(?:of|worth)\s+)?(?:₦|NGN|N)\s?\d[\d,]*(?:\.\d{1,2})?\b/gi, '')
    .replace(/\s*\b(?:of|for|worth)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

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

// The full horizontal lockup (mark + DATAHOOD wordmark), not the bare mark:
// a receipt is forwarded on its own with no surrounding UI to name the
// business, so the wordmark has to be inside the image.
//
// Safe here specifically because the receipt canvas is always white. The
// wordmark is navy and would be near-invisible on a dark surface, which is
// why the in-app sidebar uses logo-mark.png plus themed live text instead.
const LOGO_SRC = `${PUBLIC_BASE}/logo-lockup.png`;

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
    // Scale to fit a box, never to fill it. The lockup is ~5.25:1, so a
    // width cap is what actually binds — clamping width alone while passing
    // a fixed height to drawImage would stretch it. Deriving BOTH dimensions
    // from one scale factor keeps the aspect ratio whatever the asset is.
    const ratio = logo.naturalWidth / logo.naturalHeight || 1;
    const maxW = 150;
    const scale = Math.min(1, maxW / (logoH * ratio));
    const drawW = logoH * ratio * scale;
    const drawH = logoH * scale;
    // Vertically centred in the logoH band so a scaled-down wide lockup
    // still lines up with the title on the right.
    ctx.drawImage(logo, left, y + (logoH - drawH) / 2, drawW, drawH);
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

  // ---------- Headline: WHAT WAS DELIVERED ----------
  // Where a bank receipt puts the amount. Ours carries no figure (see the
  // money rule in the header), and what the recipient needs to confirm is
  // the bundle and the number it went to — so that takes the slot.
  ctx.fillStyle = COLORS.ink;
  ctx.font = '700 15px Helvetica, Arial, sans-serif';
  const headline = brandText(stripMoney(txn.servicedesc));
  for (const ln of wrapText(ctx, headline, cw - 20)) {
    ctx.fillText(ln, cx, y);
    y += 19;
  }
  y += 12;
  ctx.textAlign = 'left';

  // ---------- Detail rows ----------
  // NO amount, NO balances. Description is the headline above, so it is not
  // repeated here.
  const rows = [
    ['Reference', txn.transref],
    ['Service', txn.servicename],
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
