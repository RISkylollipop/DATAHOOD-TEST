// ============================================================
//  Transaction Receipt PDF
// ------------------------------------------------------------
//  The server-rendered twin of frontend/src/utils/receiptImage.js.
//  Both must produce the SAME receipt for the same transaction —
//  a customer who downloads the PNG and the PDF should not get two
//  different-looking documents. Layout changes here need the same
//  change there.
//
//  Style follows what customers already recognise from Opay and
//  their bank: brand mark top-left, "Transaction Receipt" top-right,
//  a CIRCULAR status badge with a glyph, what was delivered as the
//  headline, then a label/value list.
//
//  ============ NO MONEY FIGURES. EVER. ============
//  This receipt carries NO amount, price, balance, discount or total.
//
//  Our users are RESELLERS. They buy at a discounted rate and sell on
//  at their own markup, and this receipt is what they hand to THEIR
//  customer as proof of delivery. Any figure printed here tells that
//  customer what the reseller paid, and therefore exactly what margin
//  they are taking. It would damage the user's business.
//
//  The reseller still sees everything — amount, balance before and
//  after — in the transaction list and detail view in their dashboard.
//  That is the split: full detail for the account holder, delivery
//  proof for the person they sold to.
//
//  This applies to the wallet balances too, which were already
//  omitted: equal old/new balances are the admin-side audit signal
//  that a failure was reversed, and a running balance in a document
//  the customer forwards to a vendor is a privacy problem besides.
//
//  Watch the DESCRIPTION, not just the labels. servicedesc is built
//  as e.g. "MTN Airtime purchase of N500 for 0801..." in
//  airtimeController — the price is inside the sentence. stripMoney()
//  below removes it at render time; the stored string keeps the
//  amount because the dashboard, search and duplicate-detection all
//  rely on it.
//  =================================================
//
//  BRANDING: receipts are issued as DATAHOOD, the business, not as
//  the individual site the purchase happened on (kwarapolydata came
//  from DATAHOOD). `siteName` is still accepted so a caller can
//  override it, but it is NOT read from site settings by default —
//  that would make the PDF say "KwaraPolyData" while the PNG says
//  "DATAHOOD" for the very same transaction.
//
//  Uses pdfkit (streamed, no temp files); the caller pipes the
//  returned document straight to the HTTP response.
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PassThrough } from 'stream';
import PDFDocument from 'pdfkit';
import { stripMoney } from './stripMoney.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DATAHOOD brand: blue→cyan monogram over a deep navy wordmark.
const BRAND = {
  name: 'DATAHOOD',
  navy: '#10306b',
  blue: '#1668e0',
  cyan: '#1fc8d8',
  ink: '#0f172a',
  muted: '#6b7280',
  faint: '#9ca3af',
  line: '#f1f2f4',
  border: '#e5e7eb',
};

// First readable file wins. The frontend serves the same asset at
// /logo-lockup.png, so a single file in frontend/public brands both receipts
// and they cannot drift apart.
//
// The LOCKUP (mark + DATAHOOD wordmark) rather than the bare mark: a receipt
// travels on its own, with no surrounding UI to say who issued it, so the
// business name has to be inside the image. logo.png is kept last as a
// fallback for a deployment that only copied the master asset across.
const LOGO_CANDIDATES = [
  path.join(__dirname, '..', 'assets', 'logo-lockup.png'),
  path.join(__dirname, '..', '..', 'frontend', 'public', 'logo-lockup.png'),
  path.join(__dirname, '..', 'public', 'logo-lockup.png'),
  path.join(__dirname, '..', '..', 'frontend', 'public', 'logo.png'),
];

function findLogo() {
  for (const p of LOGO_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // Unreadable path is the same as no logo — never fail a receipt over it.
    }
  }
  return null;
}

// Status code -> label, colour, and the glyph drawn inside the circle.
// The glyph matters: a tick reads as "done" at a glance, which is what
// someone forwarding a receipt is trying to prove.
// Mirrors STATUS_LABELS in walletController and statusStyle() in receiptImage.js.
const STATUS = {
  0: { label: 'SUCCESSFUL', color: '#0f9d58', glyph: 'check' },
  1: { label: 'REFUNDED', color: '#0891b2', glyph: 'back' },
  2: { label: 'FAILED', color: '#dc2626', glyph: 'cross' },
  5: { label: 'PROCESSING', color: '#d97706', glyph: 'clock' },
};

// 9MOBILE is branded "T2" in the UI — rewrite it (and legacy ETISALAT)
// wherever a network name appears in the human-readable description.
// Presentation only; the stored value never changes.
function brandNetworks(text) {
  return String(text || '')
    .replace(/9MOBILE/gi, 'T2')
    .replace(/ETISALAT/gi, 'T2');
}

// There is DELIBERATELY no currency formatter in this file.
//
// One used to live here (it printed "NGN 1,200.00" for the headline). It is
// gone rather than left unused, because a money formatter sitting in the
// receipt renderer is an invitation to print a figure — and the whole point
// of this file is that it cannot. If you find yourself needing one here,
// re-read the money rule at the top: the answer is that the figure belongs
// in the dashboard, not in the document the reseller's customer receives.

/**
 * Remove any money figure from a human-readable description.
 *
 * servicedesc is written for the RESELLER's dashboard, where the price
 * belongs — airtime's is literally "MTN Airtime purchase of N500 for
 * 0801...". On a receipt handed to their customer that same sentence
 * gives away the buy price, so it is stripped here, at render time only.
 *
 * The `\b` before N is load-bearing: without it "MTN 1GB" matches N-space-1
 * and renders as "MT GB". In "MTN" the N follows a word character, so there
 * is no boundary there and the network name survives. Covered by a test in
 * scripts/receipt_money_test.mjs — do not "simplify" this regex.
 */
// Moved to utils/stripMoney.js and imported at the top of this file. It was
// private here, so whatsappService.js could not reuse it — and shipped the
// customer a receipt with the price in it. One copy now, three renderers.

// "7 Aug 2026, 19:35" — 24-hour, matching how Nigerian bank receipts print
// the time, and matching receiptDate() in the frontend renderer.
function dateStr(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(dt).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
}

/** DH monogram + wordmark, drawn when no logo file is present. */
function drawLogoFallback(doc, x, y, box, brandName) {
  doc.save();
  doc.roundedRect(x, y, box, box, box * 0.24)
    .fill(doc.linearGradient(x, y, x + box, y + box)
      .stop(0, BRAND.blue)
      .stop(1, BRAND.cyan));
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(box * 0.46)
    .text('DH', x, y + box * 0.27, { width: box, align: 'center' });
  doc.restore();

  doc.fillColor(BRAND.navy).font('Helvetica-Bold').fontSize(14)
    .text(brandName.toUpperCase(), x + box + 8, y + box * 0.3);
}

/** Glyph inside the circular status badge, stroked in white. */
function drawStatusGlyph(doc, kind, cx, cy, r) {
  doc.save();
  doc.strokeColor('#ffffff').lineWidth(Math.max(2, r * 0.14)).lineCap('round').lineJoin('round');

  if (kind === 'check') {
    doc.moveTo(cx - r * 0.42, cy + r * 0.02)
      .lineTo(cx - r * 0.12, cy + r * 0.34)
      .lineTo(cx + r * 0.45, cy - r * 0.34)
      .stroke();
  } else if (kind === 'cross') {
    doc.moveTo(cx - r * 0.32, cy - r * 0.32).lineTo(cx + r * 0.32, cy + r * 0.32).stroke();
    doc.moveTo(cx + r * 0.32, cy - r * 0.32).lineTo(cx - r * 0.32, cy + r * 0.32).stroke();
  } else if (kind === 'back') {
    // Reversal arrow — an open ring with a head, reading as "money returned".
    doc.circle(cx, cy, r * 0.36).stroke();
    doc.moveTo(cx - r * 0.5, cy - r * 0.06)
      .lineTo(cx - r * 0.34, cy + r * 0.16)
      .lineTo(cx - r * 0.12, cy - r * 0.02)
      .stroke();
  } else {
    // Clock — pending/unknown.
    doc.circle(cx, cy, r * 0.4).stroke();
    doc.moveTo(cx, cy - r * 0.22).lineTo(cx, cy + r * 0.04).lineTo(cx + r * 0.2, cy + r * 0.16).stroke();
  }

  doc.restore();
}

/**
 * Build the receipt and pipe it to a writable stream (the res).
 * @param {object} opts { res, txn, siteName?, accountName? }
 *   txn: { transref, servicename, servicedesc, status, date }
 *        `amount`, `oldbal` and `newbal` are IGNORED even when present —
 *        no money figure may appear on this document. See the header.
 */
export function streamTransactionReceipt({ res, txn, siteName, accountName }) {
  const brandName = siteName || BRAND.name;
  const st = STATUS[txn.status] || { label: 'UNKNOWN', color: BRAND.muted, glyph: 'clock' };

  const doc = new PDFDocument({ size: 'A5', margin: 40 });
  doc.pipe(res);

  const pageWidth = doc.page.width;
  const left = 40;
  const right = pageWidth - left;
  const contentWidth = right - left;

  // ---------- Header: logo left, title right ----------
  let y = 40;
  const logoH = 30;
  const logoPath = findLogo();
  if (logoPath) {
    try {
      // `fit` scales to fit INSIDE the box preserving aspect ratio, where a
      // bare { height } would let a wide lockup run into the right-aligned
      // title. The lockup is ~5.25:1, so at 30pt tall it wants ~158pt of
      // width — under the 150 cap it is the width that binds, not the height.
      doc.image(logoPath, left, y, { fit: [150, logoH], align: 'left', valign: 'center' });
    } catch {
      drawLogoFallback(doc, left, y, logoH, brandName);
    }
  } else {
    drawLogoFallback(doc, left, y, logoH, brandName);
  }

  doc.fillColor(BRAND.muted).font('Helvetica').fontSize(10)
    .text('Transaction Receipt', left, y + logoH / 2 - 4, { width: contentWidth, align: 'right' });

  y += logoH + 18;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(BRAND.border).lineWidth(1).stroke();

  // ---------- Circular status badge ----------
  y += 30;
  const r = 24;
  const cx = pageWidth / 2;
  const cy = y + r;

  // Soft halo, so the badge reads as a seal rather than a flat dot.
  doc.save().fillOpacity(0.12).circle(cx, cy, r + 6).fill(st.color).restore();
  doc.circle(cx, cy, r).fill(st.color);
  drawStatusGlyph(doc, st.glyph, cx, cy, r);

  y = cy + r + 14;
  doc.fillColor(st.color).font('Helvetica-Bold').fontSize(12)
    .text(st.label, left, y, { width: contentWidth, align: 'center' });

  // ---------- Headline: WHAT WAS DELIVERED ----------
  // This is where a bank receipt puts the amount. Ours must not carry one
  // (see the money rule at the top of this file), and the thing the
  // recipient actually needs to confirm is the bundle and the number it
  // went to — so that takes the headline slot instead.
  y += 22;
  const headline = brandNetworks(stripMoney(txn.servicedesc));
  doc.font('Helvetica-Bold').fontSize(15);
  const headlineH = doc.heightOfString(headline, { width: contentWidth, align: 'center' });
  doc.fillColor(BRAND.ink)
    .text(headline, left, y, { width: contentWidth, align: 'center' });
  y += headlineH;

  // ---------- Detail rows ----------
  // NO amount, NO balances. Description is omitted here because it is now
  // the headline above — repeating it would just pad the receipt.
  // Label left, value right — the bank-receipt convention.
  y += 26;
  const labelW = 100;
  const valW = contentWidth - labelW - 10;

  const rows = [
    ['Reference', txn.transref],
    ['Service', txn.servicename],
    ['Status', st.label],
    ['Date', dateStr(txn.date)],
  ];
  if (accountName) rows.push(['Account', accountName]);

  for (const [label, value] of rows) {
    if (value === null || value === undefined || value === '') continue;

    doc.fillColor(BRAND.muted).font('Helvetica').fontSize(9.5)
      .text(label, left, y, { width: labelW });

    doc.font('Helvetica-Bold').fontSize(9.5);
    const vh = doc.heightOfString(String(value), { width: valW, align: 'right' });
    doc.fillColor(BRAND.ink)
      .text(String(value), left + labelW + 10, y, { width: valW, align: 'right' });

    y += Math.max(20, vh + 8);
    doc.moveTo(left, y - 5).lineTo(right, y - 5).strokeColor(BRAND.line).lineWidth(1).stroke();
  }

  // ---------- Footer ----------
  y += 16;
  doc.fillColor(BRAND.muted).font('Helvetica').fontSize(8)
    .text(
      'This receipt confirms the status of your transaction with us. '
        + `Thank you for using ${brandName}. Enjoy fast, reliable, and secure digital `
        + 'services with every transaction. Your trust matters to us.',
      left, y, { width: contentWidth, align: 'center' }
    );

  y = doc.y + 12;
  doc.fillColor(BRAND.faint).fontSize(7.5)
    .text(`Generated ${dateStr(new Date())}`, left, y, { width: contentWidth, align: 'center' });

  y = doc.y + 8;
  doc.fillColor(BRAND.navy).font('Helvetica-Bold').fontSize(10)
    .text(brandName.toUpperCase(), left, y, { width: contentWidth, align: 'center' });

  doc.end();
}

/**
 * Render the SAME receipt to a Buffer instead of an HTTP response — for
 * emailing it as an attachment.
 *
 * It drives streamTransactionReceipt() through a PassThrough and concatenates
 * the chunks, so there is exactly ONE receipt renderer: the emailed PDF and
 * the dashboard download can never drift, which is the whole reason the PNG/PDF
 * twins are kept in lock-step. No temp files.
 *
 * The same money rule applies transitively — this produces the identical
 * document, so it carries no amount, price or balance either.
 *
 * @param {object} opts { txn, siteName?, accountName? } — see streamTransactionReceipt
 * @returns {Promise<Buffer>}
 */
export function renderReceiptPdfBuffer({ txn, siteName, accountName }) {
  return new Promise((resolve, reject) => {
    try {
      const sink = new PassThrough();
      const chunks = [];
      sink.on('data', (chunk) => chunks.push(chunk));
      sink.on('end', () => resolve(Buffer.concat(chunks)));
      sink.on('error', reject);
      // streamTransactionReceipt pipes the pdfkit doc into whatever `res` it is
      // given and calls doc.end(); a PassThrough is a valid writable, so the
      // renderer needs no change to serve a Buffer.
      streamTransactionReceipt({ res: sink, txn, siteName, accountName });
    } catch (err) {
      reject(err);
    }
  });
}
