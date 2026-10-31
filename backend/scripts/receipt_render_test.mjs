// Throwaway harness: render the receipt PDF to a file so the layout can be
// looked at, rather than reasoned about. Run: node scripts/receipt_render_test.mjs
//
// Exists because the logo swap changed how the header image is sized (from a
// squashing `{ height }` to an aspect-preserving `fit`) and the money strip
// changed the headline from one short line to a wrapping sentence. Both are
// visual, and neither is covered by the string-level assertions in
// receipt_money_test.mjs.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { streamTransactionReceipt } from '../utils/transactionReceipt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', '..', 'tmp-receipts');
fs.mkdirSync(outDir, { recursive: true });

// The real servicedesc templates, including airtime's embedded price — the
// one description that actually exercises stripMoney().
const CASES = [
  ['airtime-with-price', {
    transref: 'DH1723105512345',
    servicename: 'Airtime',
    servicedesc: 'MTN Airtime purchase of N500 for 08012345678',
    status: 0,
    date: new Date('2026-08-07T19:35:00+01:00'),
  }],
  ['data-long-desc', {
    transref: 'DH1723105598765',
    servicename: 'Data',
    servicedesc: 'Purchase of 9MOBILE 3.5GB CORPORATE GIFTING 30 Days Plan for 08099999999',
    status: 0,
    date: new Date('2026-08-07T09:02:00+01:00'),
  }],
  ['electricity-failed', {
    transref: 'DH1723105511111',
    servicename: 'Electricity',
    servicedesc: 'Purchase of IKEDC prepaid electricity token for meter 45678901234',
    status: 2,
    date: new Date('2026-08-06T14:20:00+01:00'),
  }],
  ['cable-refunded', {
    transref: 'DH1723105522222',
    servicename: 'Cable TV',
    servicedesc: 'Purchase of DSTV Compact for IUC 7034567890',
    status: 1,
    date: new Date('2026-08-05T08:00:00+01:00'),
  }],
];

// streamTransactionReceipt pipes to anything writable, so a file stream
// stands in for the HTTP response.
for (const [name, txn] of CASES) {
  const file = path.join(outDir, `${name}.pdf`);
  const out = fs.createWriteStream(file);
  const done = new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); });
  streamTransactionReceipt({ res: out, txn, accountName: 'Musa Ibrahim' });
  await done;
  console.log(`  ${name.padEnd(22)} ${(fs.statSync(file).size / 1024).toFixed(1)} KB  ${file}`);
}
console.log('\n  rendered', CASES.length, 'receipts');
