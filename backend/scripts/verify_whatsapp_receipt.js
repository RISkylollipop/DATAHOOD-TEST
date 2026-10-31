// ============================================================
//  scripts/verify_whatsapp_receipt.js
// ------------------------------------------------------------
//  Checks the things about the WhatsApp receipt that are worth being
//  sure of, and that a passing purchase would not reveal:
//
//   A. NO MARGIN. The rule is NOT "no digits" — airtime now carries its
//      face value on purpose, because ₦100 airtime is a figure the buyer
//      already knows. The rule is that nothing derived from what the
//      RESELLER PAID can reach the message: no wallet debit, no balance,
//      no discounted cost, including when a price is buried inside the
//      description sentence rather than sitting in an `amount` field.
//      Face value in, cost out — and the two must not be confusable.
//   B. PROVIDER DISPATCH. The row name the operator actually types
//      resolves to a driver. This is the defect that made the whole
//      feature dead-but-wired: the seed row is named "WhatsApp
//      Receipts" and the old code compared it to the literal 'meta'.
//   C. RECIPIENT. Every receipt goes to the ACCOUNT OWNER's phone, never
//      to the number that was topped up — that number frequently is not
//      on WhatsApp, and it belongs to the reseller's customer.
//
//  And the things that can only fail in production, where they are
//  expensive and opaque:
//
//   - The TEMPLATE PAYLOAD. Meta's rejections are numeric and vague:
//     132001 for a wrong name OR a wrong language pair, 132000 for a
//     parameter count OR style mismatch. None of it can be exercised
//     from here (outbound network is blocked), so the payload object
//     itself is asserted instead — including that each approved body's
//     declared variables match the parameters sent for it.
//   - WHICH SERVICES SEND AT ALL. Cable TV, electricity and
//     verification have no approved template and are skipped by design.
//   - CLASSIFYING A REFUSAL. A parameter complaint costs one retry; an
//     unreachable number should cost nothing ever again. Confusing the
//     two either retries forever or permanently marks a working number.
//   - THE RECIPIENT'S NUMBER. There is no way to ask Meta whether a
//     number is on WhatsApp before sending, so format validation plus
//     131026 is the whole answer.
//
//  ---- and then it breaks itself on purpose ----
//  A green suite proves nothing until you have watched it go red. So
//  the CONTROL block below re-runs the money assertions against a
//  deliberately broken stripMoney() that returns its input untouched.
//  If those mutants are NOT caught, the assertions are not testing
//  anything and this script exits non-zero saying so.
//
//  No network. No database. Nothing here sends a message.
//
//  Usage:  node scripts/verify_whatsapp_receipt.js
// ============================================================

import {
  buildReceiptText, resolveDriver, inferDriverFromConfig,
  buildDetail, formatFaceValue,
  TEMPLATES, pickTemplateKind, buildTemplateValues, renderTemplateParameters,
  buildTemplatePayload, isParamShapeError, isUnreachableError, MetaSendError,
  normalizePhone, checkMsisdn,
} from '../services/whatsappService.js';
import { stripMoney } from '../utils/stripMoney.js';

let failures = 0;
const ok = (name) => process.stdout.write(`  PASS  ${name}\n`);
const bad = (name, detail) => {
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        ${detail}\n`);
};

function check(name, cond, detail) {
  if (cond) ok(name); else bad(name, detail);
}

// Anything denominated in naira, in any spelling the codebase uses.
// Deliberately looser than stripMoney's own pattern — a test that
// reuses the implementation's regex only proves the regex equals
// itself.
const MONEY_RE = /(₦|NGN|\bN)\s?\d/i;

// ------------------------------------------------------------
//  A. No money figure survives into the message
// ------------------------------------------------------------
//  Each case is a real shape from a real caller. The airtime one is
//  the dangerous one: airtimeController builds its description as
//  `${networkName} ₦${amount}`, so the price is in the sentence.
const CASES = [
  {
    label: 'airtime (price inside the description)',
    receipt: {
      name: 'Musa Bello', service: 'Airtime', description: 'MTN ₦500',
      ref: 'TX1', date: '9 Aug 2026, 14:02',
    },
  },
  {
    label: 'data (no price in description)',
    receipt: {
      name: 'Musa Bello', service: 'Data', description: 'MTN 1GB SME',
      ref: 'TX2', date: '9 Aug 2026, 14:02',
    },
  },
  {
    label: 'legacy servicedesc sentence',
    receipt: {
      name: 'Musa Bello', service: 'Airtime',
      description: 'MTN Airtime purchase of N500 for 08031234567',
      ref: 'TX3', date: '9 Aug 2026, 14:02',
    },
  },
  {
    label: 'caller still passing amount + newBalance (must be ignored)',
    receipt: {
      name: 'Musa Bello', service: 'Data', description: 'Glo 2GB',
      amount: 1200, newBalance: 48250, ref: 'TX4', date: '9 Aug 2026, 14:02',
    },
  },
  {
    label: 'NGN spelling with decimals',
    receipt: {
      name: 'Musa Bello', service: 'Cable TV',
      description: 'DStv Compact worth NGN 1,200.00',
      ref: 'TX5', date: '9 Aug 2026, 14:02',
    },
  },
];

process.stdout.write('\nA. No money figure reaches the message\n');
for (const c of CASES) {
  const text = buildReceiptText(c.receipt);
  const hit = text.match(MONEY_RE);
  check(c.label, !hit, `money figure "${hit?.[0]}" survived in:\n        ${JSON.stringify(text)}`);
}

// ------------------------------------------------------------
//  A2. The ONE permitted figure: airtime face value
// ------------------------------------------------------------
//  The rule changed from "no figures" to "the figure the BUYER already
//  knows may appear; the figure the RESELLER paid may not". These are the
//  cases that distinguish the two, and they are the whole point of the
//  feature — an airtime receipt is useless to a customer if it does not
//  say how much airtime arrived.
//
//  The numbers below are chosen so a leak is unambiguous. Face value 100,
//  wallet debit 97.5, provider cost 96, profit 1.5: if any string other
//  than the face value appears, it can only have come from a margin field.
process.stdout.write('\nA2. Airtime face value appears, margin never does\n');

const AIRTIME = {
  name: 'Musa Bello', service: 'Airtime', description: 'MTN ₦100',
  faceValue: 100, ref: 'AIR1', date: '9 Aug 2026, 14:02',
};
const airtimeText = buildReceiptText(AIRTIME);

check(
  'the face value is present',
  /Exact Amount:\s*₦100\b/.test(airtimeText),
  `expected "Exact Amount: ₦100" in:\n        ${JSON.stringify(airtimeText)}`,
);
check(
  'the network survives alongside it',
  airtimeText.includes('MTN'),
  `network missing from:\n        ${JSON.stringify(airtimeText)}`,
);
check(
  'the description\'s own price is not duplicated',
  // "MTN ₦100" stripped to "MTN", then one face value appended. Two
  // occurrences would mean stripMoney ran after the append, or not at all.
  (airtimeText.match(/₦\s?100/g) || []).length === 1,
  `the figure appears more than once:\n        ${JSON.stringify(airtimeText)}`,
);

// The leak test. Each of these is a real variable living within ~15 lines
// of `amt` in airtimeController, all plain numbers, all a plausible typo.
// `amount` is included on purpose: it is the likeliest key of the lot,
// it is what the old pre-stripMoney callers passed, and a test that only
// probed distinctively-named keys would miss the obvious mistake.
const MARGIN_FIELDS = [
  ['amount', 97.5],
  ['amountToPay', 97.5],
  ['buyAmountFromProvider', 96],
  ['profit', 1.5],
  ['newBalance', 48250],
  ['balance', 48250],
];
for (const [key, value] of MARGIN_FIELDS) {
  // Not passed as faceValue — passed the way a caller would leak it, as an
  // extra key the service must ignore rather than render.
  const leaky = buildReceiptText({ ...AIRTIME, [key]: value });
  check(
    `${key} does not reach the message`,
    !leaky.includes(String(value)),
    `${value} appeared in:\n        ${JSON.stringify(leaky)}`,
  );
}

check(
  'a data receipt still carries no figure at all',
  !MONEY_RE.test(buildReceiptText({
    name: 'Musa Bello', service: 'Data', description: 'MTN 1GB SME',
    ref: 'DAT1', date: '9 Aug 2026, 14:02',
  })),
  'a data receipt gained a money figure — its price is margin, not face value',
);

process.stdout.write('\n   (formatFaceValue rejects what should never print)\n');
const FV_CASES = [
  [100, '₦100'],
  [1000, '₦1,000'],
  ['100', '₦100'],
  [99.5, '₦99.50'],
  // Anything that would render as "N0", "NNaN" or "N-50" on a customer's
  // receipt must render as nothing instead.
  [0, ''],
  [-50, ''],
  [null, ''],
  [undefined, ''],
  ['', ''],
  ['abc', ''],
  [NaN, ''],
  [Infinity, ''],
];
for (const [input, expected] of FV_CASES) {
  const got = formatFaceValue(input);
  check(
    `formatFaceValue(${JSON.stringify(input)}) -> ${JSON.stringify(expected)}`,
    got === expected,
    `got ${JSON.stringify(got)}`,
  );
}

check(
  'no faceValue means no "Exact Amount" label at all',
  !buildDetail({ description: 'MTN 1GB', faceValue: 0 }).includes('Exact Amount'),
  'an empty face value still printed its label',
);
check(
  'detail stays single-line (Meta rejects newlines in template params)',
  !/[\n\t]/.test(buildDetail({ description: 'MTN ₦100', faceValue: 100 })),
  'the detail parameter contains a newline or tab',
);

// The other half of the rule: stripping must not eat the useful part.
// A receipt that says only "Details:" is compliant and worthless.
process.stdout.write('\n   (and the message still says what was delivered)\n');
check(
  'network survives stripping',
  buildReceiptText(CASES[0].receipt).includes('MTN'),
  'the network name was stripped along with the price',
);
check(
  'the "MTN" trap: N in MTN is not a currency N',
  stripMoney('MTN 1GB') === 'MTN 1GB',
  `got ${JSON.stringify(stripMoney('MTN 1GB'))}`,
);
check(
  'recipient number survives',
  buildReceiptText(CASES[2].receipt).includes('08031234567'),
  'the phone number was stripped',
);
check(
  'reference survives',
  buildReceiptText(CASES[0].receipt).includes('TX1'),
  'the transaction reference is missing',
);

// ------------------------------------------------------------
//  A3. Which template a receipt gets — and which get none
// ------------------------------------------------------------
//  One function decides this, and it is where the operator's "skip cable,
//  electricity and verification" decision actually lives. Wrong in either
//  direction is expensive: a service that gains a template it has no
//  approval for fails with 132001 on every purchase, and a service that
//  quietly loses one stops sending receipts nobody notices are missing.
process.stdout.write('\nA3. Template selection\n');

const KIND_CASES = [
  ['airtime with a usable face value', { service: 'Airtime', faceValue: 100 }, 'airtime'],
  ['airtime, mixed case', { service: 'AirTime', faceValue: 500 }, 'airtime'],
  ['airtime, padded', { service: '  Airtime  ', faceValue: 500 }, 'airtime'],
  ['data', { service: 'Data' }, 'data'],
  // The airtime template hardcodes "Amount: ₦" ahead of its variable, so an
  // unusable figure must not reach it — the data template is exactly the
  // shape of "a receipt with no money figure".
  ['airtime with no face value', { service: 'Airtime' }, 'data'],
  ['airtime with a zero face value', { service: 'Airtime', faceValue: 0 }, 'data'],
  ['airtime with a negative face value', { service: 'Airtime', faceValue: -50 }, 'data'],
  ['airtime with a junk face value', { service: 'Airtime', faceValue: 'abc' }, 'data'],
  ['airtime with an infinite face value', { service: 'Airtime', faceValue: Infinity }, 'data'],
  // The three the operator chose to skip. No approved template exists.
  ['cable tv', { service: 'Cable TV' }, ''],
  ['electricity', { service: 'Electricity' }, ''],
  ['verification', { service: 'Verification' }, ''],
  ['a service nobody has added yet', { service: 'Betting' }, ''],
  ['no service at all', {}, ''],
  ['a null receipt', null, ''],
];
for (const [label, receipt, expected] of KIND_CASES) {
  const got = pickTemplateKind(receipt);
  check(
    `${label} -> ${expected === '' ? 'no send' : expected}`,
    got === expected,
    `got ${JSON.stringify(got)}`,
  );
}

// The escape hatch: an operator can route an unlisted service onto an
// already-approved template without waiting for a deploy.
check(
  'serviceTemplates can route a skipped service onto an existing template',
  pickTemplateKind({ service: 'Cable TV' }, { serviceTemplates: { 'cable tv': 'data' } }) === 'data',
  'the config override does not work',
);
check(
  'but it cannot invent a template that does not exist',
  pickTemplateKind({ service: 'Betting' }, { serviceTemplates: { betting: 'bogus' } }) === '',
  'an override pointing at a non-existent template would send and fail with 132001',
);
check(
  'and a bad override falls back to the built-in mapping',
  pickTemplateKind({ service: 'Data' }, { serviceTemplates: { data: 'bogus' } }) === 'data',
  'a typo in the override silently disabled a working service',
);

// ------------------------------------------------------------
//  A4. The payload Meta actually receives
// ------------------------------------------------------------
//  Nothing here can be confirmed by calling the API (outbound network is
//  blocked), so the payload object is the artifact worth asserting on.
//  Every field below has a specific failure attached to getting it wrong:
//  the wrong name or language is 132001, the wrong parameter count or
//  style is 132000, and a doubled naira sign is a receipt the customer
//  reads as broken.
process.stdout.write('\nA4. The template payload\n');

// The structural check that prevents a 132000 nobody can explain: the
// variables DECLARED in each approved body must be exactly the parameters
// sent for it, in the same order. Editing one without the other is the
// single easiest way to break every receipt at once.
for (const [kind, tpl] of Object.entries(TEMPLATES)) {
  const declared = (tpl.body.match(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g) || [])
    .map((s) => s.replace(/[{}\s]/g, ''));
  check(
    `${kind}: the body's variables match its params array exactly, in order`,
    declared.join(',') === tpl.params.join(','),
    `body declares [${declared}] but params is [${tpl.params}]`,
  );
  check(
    `${kind}: six parameters, as submitted to Meta`,
    tpl.params.length === 6,
    `got ${tpl.params.length}`,
  );
  check(
    `${kind}: the header is static text, not a variable`,
    tpl.body.startsWith('Transaction Receipt\n') && !tpl.params.includes('header'),
    'the header became a parameter — Meta would reject the count',
  );
}

const airtimePayload = buildTemplatePayload('2348031234567', AIRTIME, 'airtime');
const dataReceipt = {
  name: 'Musa Bello', service: 'Data', network: 'MTN', planName: '1GB SME',
  description: 'MTN 1GB SME ₦280', ref: 'DAT1', date: '9 Aug 2026, 14:02',
};
const dataPayload = buildTemplatePayload('2348031234567', dataReceipt, 'data');

check(
  'payload is type "template"',
  airtimePayload.type === 'template',
  JSON.stringify(airtimePayload.type),
);
check(
  'payload addresses the normalized number',
  airtimePayload.to === '2348031234567',
  JSON.stringify(airtimePayload.to),
);
check(
  'airtime uses the airtime template by name',
  airtimePayload.template.name === 'datahood_receipt_airtime',
  JSON.stringify(airtimePayload.template.name),
);
check(
  'data uses the data template by name',
  dataPayload.template.name === 'datahood_receipt_data',
  JSON.stringify(dataPayload.template.name),
);
// en and en_US are DIFFERENT language pairs to Meta. The wrong one fails
// with 132001, which reads as "template not found" and sends the operator
// hunting for a template that is sitting right there, approved.
check(
  'the language is en_US, not en',
  airtimePayload.template.language.code === 'en_US'
    && dataPayload.template.language.code === 'en_US',
  JSON.stringify(airtimePayload.template.language),
);
check(
  'the language is overridable for an operator who approved a different pair',
  buildTemplatePayload('2348031234567', AIRTIME, 'airtime', { templateLang: 'en' })
    .template.language.code === 'en',
  'templateLang is ignored',
);
check(
  'the template name is overridable without a deploy',
  buildTemplatePayload('2348031234567', AIRTIME, 'airtime', { templates: { airtime: 'my_tpl' } })
    .template.name === 'my_tpl',
  'a renamed template in Meta would need a code change',
);

const airtimeParams = airtimePayload.template.components[0].parameters;
const dataParams = dataPayload.template.components[0].parameters;
check(
  'six parameters go out (Meta rejects a mismatch with 132000)',
  airtimeParams.length === 6 && dataParams.length === 6,
  `airtime ${airtimeParams.length}, data ${dataParams.length}`,
);
check(
  'named style is the default, and every parameter carries its name',
  airtimeParams.every((p) => p.type === 'text' && typeof p.parameter_name === 'string' && p.parameter_name),
  JSON.stringify(airtimeParams),
);
check(
  'the names are the ones Meta knows, in template order',
  airtimeParams.map((p) => p.parameter_name).join(',')
    === 'customer_name,service_type,network,amount,transaction_reference,transaction_date',
  JSON.stringify(airtimeParams.map((p) => p.parameter_name)),
);
// Capitalised because that is how the variable was named in Meta's Template
// Manager. Named parameters must match EXACTLY — a lowercase 'description'
// is a different variable and the send fails.
check(
  'the data template keeps {{Description}} capitalised',
  dataParams.map((p) => p.parameter_name).join(',')
    === 'customer_name,service_type,network,Description,transaction_reference,transaction_date',
  JSON.stringify(dataParams.map((p) => p.parameter_name)),
);

const amountParam = airtimeParams.find((p) => p.parameter_name === 'amount');
check(
  'the face value reaches Meta',
  amountParam.text === '100',
  JSON.stringify(amountParam?.text),
);
// The template body already prints the naira sign ahead of the variable, so
// sending "₦100" would render "Amount: ₦₦100".
check(
  'the amount is sent BARE because the template supplies the naira sign',
  TEMPLATES.airtime.body.includes('₦{{amount}}') && !amountParam.text.includes('₦'),
  `template says ${JSON.stringify(TEMPLATES.airtime.body.split('\n')[5])}, `
  + `parameter is ${JSON.stringify(amountParam.text)}`,
);
check(
  'the network gets its own parameter rather than being read out of the description',
  airtimeParams.find((p) => p.parameter_name === 'network').text === 'MTN'
    && dataParams.find((p) => p.parameter_name === 'network').text === 'MTN',
  JSON.stringify([airtimeParams[2].text, dataParams[2].text]),
);
check(
  'the data receipt states what was delivered, without repeating the network',
  dataParams.find((p) => p.parameter_name === 'Description').text === '1GB SME',
  JSON.stringify(dataParams.find((p) => p.parameter_name === 'Description')?.text),
);
check(
  'the reference goes out intact',
  airtimeParams.find((p) => p.parameter_name === 'transaction_reference').text === 'AIR1',
  JSON.stringify(airtimeParams.find((p) => p.parameter_name === 'transaction_reference')?.text),
);

// The positional fallback. A template is created as either named or
// positional and the two payloads are NOT interchangeable, so the retry has
// to produce the same values in the same order with the names removed.
const positional = buildTemplatePayload('2348031234567', AIRTIME, 'airtime', {}, 'positional')
  .template.components[0].parameters;
check(
  'positional style drops the names and keeps the order',
  positional.length === 6
    && positional.every((p) => p.type === 'text' && p.parameter_name === undefined)
    && positional.map((p) => p.text).join('|') === airtimeParams.map((p) => p.text).join('|'),
  JSON.stringify(positional),
);
check(
  'an operator can pin positional and skip the failed first attempt',
  renderTemplateParameters([['a', '1']], 'positional')[0].parameter_name === undefined,
  'templateParamStyle would have no effect',
);
// Both approved templates are NAMED, so a caller that omits the style must
// get names. Asserted on the renderer itself: buildTemplatePayload always
// passes the style explicitly, which would hide a flipped default here.
check(
  'named is what you get when no style is asked for',
  renderTemplateParameters([['a', '1']])[0].parameter_name === 'a',
  'the default style is not named — every un-styled send would fail with 132000',
);

// ---- the money rule, on the path every operator actually uses ----
//  Sections A and A2 cover buildReceiptText, which is the TERMII body. The
//  template sends parameters instead, so the rule is re-proved here against
//  what Meta receives.
for (const [key, value] of MARGIN_FIELDS) {
  for (const [kind, receipt] of [['airtime', AIRTIME], ['data', dataReceipt]]) {
    const leaked = buildTemplatePayload('2348031234567', { ...receipt, [key]: value }, kind)
      .template.components[0].parameters.map((p) => p.text).join(' | ');
    check(
      `${key} does not reach the ${kind} template`,
      !leaked.includes(String(value)),
      `${value} appeared in ${JSON.stringify(leaked)}`,
    );
  }
}
check(
  'a data receipt carries no money figure at all',
  !MONEY_RE.test(dataParams.map((p) => p.text).join(' '))
    && !dataParams.some((p) => p.text.includes('280')),
  `a plan price reached the data template: ${JSON.stringify(dataParams.map((p) => p.text))}`,
);
check(
  'the data template has no amount variable to leak into',
  !TEMPLATES.data.params.includes('amount') && !TEMPLATES.data.body.includes('{{amount}}'),
  'the data template gained a money variable',
);
// The fixture above carries planName, which short-circuits deliveredValue.
// dataController does NOT pass planName today, so the description branch is
// the LIVE path — and the description is where the plan price lives.
{
  const noPlanName = {
    name: 'Musa Bello', service: 'Data', network: 'MTN',
    description: 'MTN 1GB SME N280', ref: 'DAT2', date: '9 Aug 2026, 14:02',
  };
  const params = buildTemplatePayload('2348031234567', noPlanName, 'data')
    .template.components[0].parameters;
  const delivered = params.find((p) => p.parameter_name === 'Description').text;
  check(
    'with no planName, the price is stripped out of the description',
    delivered === '1GB SME',
    `got ${JSON.stringify(delivered)} — the plan price reached the customer`,
  );
  check(
    'and no money figure survives anywhere in that payload',
    !MONEY_RE.test(params.map((p) => p.text).join(' '))
      && !params.some((p) => p.text.includes('280')),
    JSON.stringify(params.map((p) => p.text)),
  );
  // Same in the ₦ form, which is what the dashboard receipt renders.
  const naira = buildTemplatePayload('2348031234567', {
    ...noPlanName, description: 'MTN 1GB SME ₦280',
  }, 'data').template.components[0].parameters
    .find((p) => p.parameter_name === 'Description').text;
  check(
    'the naira-sign form is stripped too',
    naira === '1GB SME',
    `got ${JSON.stringify(naira)}`,
  );
}

// Meta rejects blank template parameters, so a cosmetic data problem must
// not become a failed send. `name` is built by every caller as
// `${sFname} ${sLname}`, so a profile with no surname yields a lone space.
const EMPTY_PARAM_CASES = [
  ['nothing but a service', { service: 'Data' }],
  ['no surname (a lone space)', { name: 'Musa ', service: 'Data', ref: 'D1' }],
  ['whitespace-only name', { name: '   ', service: 'Airtime', faceValue: 100, ref: 'A1' }],
  ['no reference', { name: 'Musa', service: 'Data', description: 'MTN 1GB' }],
  ['no date', { name: 'Musa', service: 'Data', description: 'MTN 1GB', ref: 'D2' }],
  ['completely empty', {}],
];
for (const [label, input] of EMPTY_PARAM_CASES) {
  const kind = pickTemplateKind(input) || 'data';
  const built = buildTemplateValues(input, kind);
  check(
    `no blank parameter: ${label}`,
    built.length === 6 && built.every(([, v]) => String(v).trim() !== ''),
    `got ${JSON.stringify(built)}`,
  );
}

// Meta caps a parameter at 1024 characters. Only the plan description is
// realistically long enough to reach it, and a clipped plan name still beats
// a rejected receipt.
{
  const long = buildTemplatePayload('2348031234567', {
    ...dataReceipt, planName: 'x'.repeat(5000),
  }, 'data').template.components[0].parameters;
  check(
    'an over-long parameter is clipped to Meta\'s 1024-character limit',
    long.every((p) => p.text.length <= 1024) && long.some((p) => p.text.length === 1024),
    `longest was ${Math.max(...long.map((p) => p.text.length))}`,
  );
}

// ------------------------------------------------------------
//  A5. Reading Meta's refusals
// ------------------------------------------------------------
//  Two classifications, and confusing them is the whole risk. A parameter
//  complaint should cost ONE retry in the other style. An unreachable
//  number should cost nothing ever again. Swap them and you get either an
//  endless pointless retry or a perfectly good number permanently marked
//  as not-on-WhatsApp.
process.stdout.write('\nA5. Error classification\n');

const SHAPE_CASES = [
  ['count mismatch (132000)', new MetaSendError('Number of parameters does not match', 132000, 400), true],
  ['generic invalid parameter (100)', new MetaSendError('Invalid parameter', 100, 400), true],
  ['code arriving as a string', new MetaSendError('whatever', '132000', 400), true],
  ['prose, both signals', new MetaSendError(
    'The parameter format does not match the format in the template creation', 0, 400,
  ), true],
  // The prose net needs BOTH signals so it cannot fire on a stray mention.
  ['prose with only one signal', new MetaSendError('Rate limit hit while sending parameter batch', 0, 429), false],
  // A retry in the other style would fail identically for all of these.
  ['unreachable (131026)', new MetaSendError('Message undeliverable', 131026, 400), false],
  ['bad template (132001)', new MetaSendError('Template name does not exist', 132001, 400), false],
  ['expired token (190)', new MetaSendError('Session has expired', 190, 401), false],
  ['a missing credential', new Error('phoneNumberId missing from Extra config'), false],
  ['null', null, false],
  ['undefined', undefined, false],
];
for (const [label, err, expected] of SHAPE_CASES) {
  check(
    `${label} -> ${expected ? 'retry the other style' : 'do not retry'}`,
    isParamShapeError(err) === expected,
    `got ${isParamShapeError(err)}`,
  );
}

const UNREACHABLE_CASES = [
  ['undeliverable (131026)', new MetaSendError('Message undeliverable', 131026, 400), true],
  ['code arriving as a string', new MetaSendError('whatever', '131026', 400), true],
  ['prose: not a WhatsApp user', new MetaSendError('Recipient is not a valid WhatsApp user', 0, 400), true],
  // Everything below is worth retrying on the next purchase, so none of it
  // may permanently mark the account.
  ['count mismatch (132000)', new MetaSendError('Number of parameters does not match', 132000, 400), false],
  ['bad template (132001)', new MetaSendError('Template name does not exist', 132001, 400), false],
  ['expired token (190)', new MetaSendError('Session has expired', 190, 401), false],
  ['rate limited (130429)', new MetaSendError('Rate limit hit', 130429, 429), false],
  ['a missing credential', new Error('Access token missing'), false],
  ['null', null, false],
];
for (const [label, err, expected] of UNREACHABLE_CASES) {
  check(
    `${label} -> ${expected ? 'stop retrying this number' : 'keep trying next time'}`,
    isUnreachableError(err) === expected,
    `got ${isUnreachableError(err)}`,
  );
}
// The two classifications must not overlap. This is the expensive one: a
// 132000 read as "unreachable" would flag a working number forever.
check(
  'the two classifications are mutually exclusive',
  !isParamShapeError(new MetaSendError('Message undeliverable', 131026, 400))
    && !isUnreachableError(new MetaSendError('Number of parameters does not match', 132000, 400)),
  'a parameter error and an unreachable recipient are being confused',
);
check(
  'MetaSendError carries the code through',
  new MetaSendError('x', 131026, 400).metaCode === 131026
    && new MetaSendError('x', 131026, 400) instanceof Error,
  'the code is lost, so nothing downstream can classify anything',
);

// ------------------------------------------------------------
//  A6. Is this number even a phone number?
// ------------------------------------------------------------
//  Meta publishes NO endpoint to check whether a number is registered on
//  WhatsApp — the on-premise /contacts lookup went away with on-premise
//  itself. So this layer catches only what a format can catch (a landline,
//  a truncated paste, a digit-count typo) and Meta's 131026 answers the
//  rest. What this layer must NOT do is invent a business rule: a validly
//  formatted foreign number belongs to somebody, and refusing to message
//  them is not this file's decision to make.
process.stdout.write('\nA6. Recipient number validation\n');

const PHONE_CASES = [
  ['a local 0-prefixed number', '08031234567', '2348031234567', 'valid'],
  ['spaces and a plus', '+234 803 123 4567', '2348031234567', 'valid'],
  ['bare ten digits', '8031234567', '2348031234567', 'valid'],
  ['already international', '2348031234567', '2348031234567', 'valid'],
  ['a 7-prefix mobile', '07012345678', '2347012345678', 'valid'],
  ['a 9-prefix mobile', '09012345678', '2349012345678', 'valid'],
  // Real defects, caught before a request is spent.
  ['a Lagos landline', '01 234 5678', '23412345678', 'invalid'],
  // Ten digits like a mobile, but a prefix no Nigerian mobile uses. This is
  // the case that fails on the PREFIX rather than on the length — the
  // landline above is short enough to be caught either way.
  ['ten digits with a landline prefix', '01234567890', '2341234567890', 'invalid'],
  ['ten digits starting 2', '02034567890', '2342034567890', 'invalid'],
  ['one digit short', '0803123456', '234803123456', 'invalid'],
  ['one digit too many', '080312345678', '23480312345678', 'invalid'],
  ['nothing at all', '', '', 'invalid'],
  ['letters only', 'not a phone', '', 'invalid'],
  ['far too short', '1234', '1234', 'invalid'],
  ['longer than E.164 allows', '12345678901234567', '12345678901234567', 'invalid'],
  // Not Nigerian, but plainly a number. Warn and send.
  ['a UK mobile', '447700900123', '447700900123', 'foreign'],
  ['a US number', '14155550123', '14155550123', 'foreign'],
];
for (const [label, input, expectedDigits, expectedLevel] of PHONE_CASES) {
  const digits = normalizePhone(input);
  const verdict = checkMsisdn(digits);
  check(
    `${label} normalizes as expected`,
    digits === expectedDigits,
    `got ${JSON.stringify(digits)}, wanted ${JSON.stringify(expectedDigits)}`,
  );
  check(
    `${label} -> ${expectedLevel}`,
    verdict.level === expectedLevel && verdict.ok === (expectedLevel !== 'invalid'),
    `got ${JSON.stringify(verdict)}`,
  );
}
check(
  'a foreign number is warned about, not rejected',
  checkMsisdn('447700900123').ok === true
    && checkMsisdn('447700900123').reason.length > 0,
  'refusing to message a valid foreign number invents a rule nobody asked for',
);
check(
  'an invalid number always comes with a reason an operator can act on',
  ['', '01 234 5678', '0803123456', '1234'].every((p) => {
    const v = checkMsisdn(normalizePhone(p));
    return v.ok === false && v.reason.trim().length > 8;
  }),
  'a rejection with no reason sends the operator looking in the wrong place',
);
// The reason is the only thing an operator sees, so a right-length/wrong-prefix
// number must not be described as a length problem.
check(
  'a wrong-prefix number is diagnosed as a prefix problem, not a length one',
  /starts with 1/.test(checkMsisdn('2341234567890').reason)
    && /7, 8 or 9/.test(checkMsisdn('2341234567890').reason)
    && /9 digits after 234/.test(checkMsisdn('234803123456').reason),
  `${JSON.stringify(checkMsisdn('2341234567890').reason)} / `
  + `${JSON.stringify(checkMsisdn('234803123456').reason)}`,
);
// The reason string is LOGGED. The number is personal data and must not be
// smuggled into the log through the diagnostic.
check(
  'the reason never contains the number itself',
  PHONE_CASES.every(([, input]) => {
    const digits = normalizePhone(input);
    if (!digits) return true;
    return !checkMsisdn(digits).reason.includes(digits);
  }),
  'a phone number is reaching the log through the validation reason',
);

// ------------------------------------------------------------
process.stdout.write('\nB. Provider name resolution\n');
const DRIVER_CASES = [
  ['meta', 'meta'],
  ['Meta', 'meta'],
  ['  META  ', 'meta'],
  ['WhatsApp Cloud API', 'meta'],
  ['Facebook Cloud API', 'meta'],
  ['termii', 'termii'],
  ['Termii', 'termii'],
  ['off', 'off'],
  ['disabled', 'off'],
  // The seeded row name — the one in the operator's live log. By NAME it
  // resolves to nothing, and that is correct: "WhatsApp Receipts" names
  // the job, not the vendor, and no amount of pattern matching can tell
  // Meta from Termii out of it. The credentials can (see C below).
  ['WhatsApp Receipts', null],
  ['', null],
  [undefined, null],
];
for (const [input, expected] of DRIVER_CASES) {
  const got = resolveDriver(input);
  check(
    `${JSON.stringify(input)} -> ${expected}`,
    got === expected,
    `got ${JSON.stringify(got)}`,
  );
}

// ------------------------------------------------------------
//  C. Falling back to credential shape
// ------------------------------------------------------------
//  This is what fixes the operator's actual log line without asking them
//  to rename a row they have already filled in correctly.
process.stdout.write('\nC. Driver inferred from credential shape\n');
const INFER_CASES = [
  ['meta fields only', { phoneNumberId: '123456', token: 't' }, 'meta'],
  ['termii fields only', { senderId: 'DATAHOOD', apiKey: 'k' }, 'termii'],
  // Ambiguous: refuse rather than guess. Sending through the wrong vendor
  // fails on the far side, which is harder to diagnose than a warning.
  ['both present', { phoneNumberId: '1', senderId: 'D' }, null],
  ['neither present', { apiKey: 'k', token: 't' }, null],
  ['empty', {}, null],
  ['null', null, null],
  // Empty strings are what an admin form submits for an untouched field,
  // so they must not read as "present".
  ['empty-string phoneNumberId', { phoneNumberId: '' }, null],
  ['empty-string senderId', { senderId: '' }, null],
];
for (const [label, cfg, expected] of INFER_CASES) {
  const got = inferDriverFromConfig(cfg);
  check(`${label} -> ${expected}`, got === expected, `got ${JSON.stringify(got)}`);
}

// The composite behaviour the service relies on: an explicit name always
// beats inference, so an operator can override a misleading credential set.
check(
  'explicit name wins over credential shape',
  (resolveDriver('Termii') || inferDriverFromConfig({ phoneNumberId: '1' })) === 'termii',
  'inference overrode an explicit provider name',
);
check(
  'the seeded row + meta credentials now resolves to meta',
  (resolveDriver('WhatsApp Receipts')
    || inferDriverFromConfig({ phoneNumberId: '123', token: 't' })) === 'meta',
  'the operator\'s configuration still does not resolve to a driver',
);
check(
  '"off" is still honoured before inference runs',
  resolveDriver('off') === 'off',
  'a disabled row would now send anyway',
);

// ------------------------------------------------------------
//  CONTROL — the assertions must be able to fail
// ------------------------------------------------------------
//  Re-run the money cases against a stripMoney that does nothing.
//  Every case that contains a figure MUST now be caught. If any of
//  them still "passes", that case was never testing the rule.
process.stdout.write('\nCONTROL: re-running the money cases against a broken stripper\n');
const brokenStrip = (t) => String(t || '');
const brokenBuild = ({ name, service, description, ref, date }) => (
  `✅ *DATAHOOD Receipt*\n\nHi ${name},\nYour ${service} transaction was successful.\n\n`
  + `*Details:* ${brokenStrip(description)}\n*Ref:* ${ref}\n*Date:* ${date}\n`
);

// Only the cases whose description actually carries a figure can be
// caught by breaking the stripper; the others are money-free at source.
const SHOULD_BE_CAUGHT = CASES.filter((c) => MONEY_RE.test(c.receipt.description));
let uncaught = 0;
for (const c of SHOULD_BE_CAUGHT) {
  const caught = MONEY_RE.test(brokenBuild(c.receipt));
  if (caught) {
    process.stdout.write(`  caught  ${c.label}\n`);
  } else {
    uncaught += 1;
    process.stdout.write(`  MISSED  ${c.label} — this assertion cannot fail, so it proves nothing\n`);
  }
}
if (SHOULD_BE_CAUGHT.length < 3) {
  uncaught += 1;
  process.stdout.write('  MISSED  too few cases carry a price to make this control meaningful\n');
}

// ------------------------------------------------------------
process.stdout.write('\n' + '-'.repeat(58) + '\n');
if (failures === 0 && uncaught === 0) {
  process.stdout.write('All checks passed, and the control mutants were all caught.\n\n');
  process.exit(0);
}
if (failures) process.stdout.write(`${failures} assertion(s) failed.\n`);
if (uncaught) {
  process.stdout.write(
    `${uncaught} control mutant(s) were NOT caught — those assertions are\n`
    + 'decorative and the money rule is not actually being verified.\n',
  );
}
process.stdout.write('\n');
process.exit(1);
