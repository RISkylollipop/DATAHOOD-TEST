// Throwaway harness for stripMoney(), the guard that keeps prices off the
// customer-facing receipt. Run: node scripts/receipt_money_test.mjs
//
// The strings below are the REAL servicedesc templates, copied from the
// controllers that build them:
//   airtimeController.js:144  `${net.network} Airtime purchase of N${amt} for ${phone}`
//   dataController.js:112     `Purchase of ${net.network} ${plan.name} ${dataType} ${plan.day} Days Plan for ${phone}`
//   billsController.js:125    `Purchase of ${provider} ${metertype} electricity token for meter ${meternumber}`
//   billsController.js:292    `Purchase of ${provider} ${plan.name} for IUC ${iucnumber}`
//   verificationController.js `${meta.label} verification for ${maskId(cleaned)}`
//   paymentController.js:458  `${providerName} payment via ${paymentMethod}`
import assert from 'assert';

// Kept in sync by hand with backend/utils/transactionReceipt.js and
// frontend/src/utils/receiptImage.jsx. Any change must land in all three.
function stripMoney(text) {
  return String(text || '')
    .replace(/(?:\s*\b(?:of|worth)\s+)?(?:₦|NGN|N)\s?\d[\d,]*(?:\.\d{1,2})?\b/gi, '')
    .replace(/\s*\b(?:of|for|worth)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
};

const eq = (input, expected) => check(JSON.stringify(input), () => {
  assert.strictEqual(stripMoney(input), expected);
});

// ---------- the actual leak: airtime embeds the price ----------
eq('MTN Airtime purchase of N500 for 08012345678',
   'MTN Airtime purchase for 08012345678');
eq('GLO Airtime purchase of N1,000 for 08055555555',
   'GLO Airtime purchase for 08055555555');
eq('9MOBILE Airtime purchase of N50 for 08099999999',
   '9MOBILE Airtime purchase for 08099999999');
eq('AIRTEL Airtime purchase of N2500.00 for 07011112222',
   'AIRTEL Airtime purchase for 07011112222');

// ---------- THE false positive that must not happen ----------
// A naive /N\s?\d/ eats the N of MTN and renders "MT 1GB".
check('network names survive: MTN / MTN 1GB', () => {
  assert.strictEqual(stripMoney('Purchase of MTN 1GB SME 30 Days Plan for 08012345678'),
    'Purchase of MTN 1GB SME 30 Days Plan for 08012345678');
  assert.strictEqual(stripMoney('MTN 2GB'), 'MTN 2GB');
  assert.strictEqual(stripMoney('MTN 500MB'), 'MTN 500MB');
});

// ---------- descriptions that contain no money: must pass through UNTOUCHED ----------
for (const s of [
  'Purchase of MTN 1GB SME 30 Days Plan for 08012345678',
  'Purchase of GLO 3.5GB CORPORATE 30 Days Plan for 08055555555',
  'Purchase of IKEDC prepaid electricity token for meter 45678901234',
  'Purchase of DSTV Compact for IUC 7034567890',
  'BVN verification for 1234****89',
  'NIN verification for 5678****12',
  'Monnify payment via bank transfer',
  'Wallet funding via bank transfer',
]) eq(s, s);

// ---------- other money shapes ----------
eq('Airtime worth NGN 200 for 08012345678', 'Airtime for 08012345678');
eq('Recharge ₦300 for 08012345678', 'Recharge for 08012345678');
eq('Purchase of N1,250.50 bundle', 'Purchase bundle');
eq('Data purchase for N500', 'Data purchase');   // trailing preposition cleaned
eq('N500', '');
eq('NGN 500', '');
eq('₦1,000.00', '');

// ---------- must not eat plan sizes, dates, meter/IUC/phone numbers ----------
check('sizes, days and long numbers survive', () => {
  assert.strictEqual(stripMoney('1GB 30 Days'), '1GB 30 Days');
  assert.strictEqual(stripMoney('for meter 45678901234'), 'for meter 45678901234');
  assert.strictEqual(stripMoney('for IUC 7034567890'), 'for IUC 7034567890');
  assert.strictEqual(stripMoney('for 08012345678'), 'for 08012345678');
  assert.strictEqual(stripMoney('2.5GB'), '2.5GB');
});

// ---------- no output may contain a currency marker or a bare N-number ----------
const CORPUS = [
  'MTN Airtime purchase of N500 for 08012345678',
  'GLO Airtime purchase of N1,000 for 08055555555',
  'Airtime worth NGN 200 for 08012345678',
  'Recharge ₦300 for 08012345678',
  'Purchase of MTN 1GB SME 30 Days Plan for 08012345678',
  'Purchase of IKEDC prepaid electricity token for meter 45678901234',
];
check('SWEEP: no money marker survives in any output', () => {
  for (const s of CORPUS) {
    const out = stripMoney(s);
    assert.ok(!/₦/.test(out), `naira sign left in: ${out}`);
    assert.ok(!/\bNGN\b/i.test(out), `NGN left in: ${out}`);
    assert.ok(!/\bN\s?\d/.test(out), `N-figure left in: ${out}`);
  }
});

// ---------- edge cases ----------
check('null/undefined/empty are safe', () => {
  for (const v of [null, undefined, '', 0]) assert.strictEqual(stripMoney(v), '');
});
check('idempotent — running twice changes nothing', () => {
  for (const s of CORPUS) assert.strictEqual(stripMoney(stripMoney(s)), stripMoney(s));
});

console.log(`\n  ${pass} assertions passed${process.exitCode ? ' (with failures above)' : ''}`);
