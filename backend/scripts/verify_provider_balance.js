// ============================================================
//  scripts/verify_provider_balance.js
// ------------------------------------------------------------
//  The wallet-balance path, checked without a database or a network.
//
//   A. URL RESOLUTION. A configured Wallet row wins over the legacy
//      /api/user/ guess, and an absolute URL is used exactly as the
//      operator typed it. This is the actual bug: the URL used to be
//      guessed with no field anywhere to correct it, so a vendor whose
//      balance does not live at /api/user/ read "Unavailable" forever.
//   B. PARSING. Vendors return the figure under different keys and in
//      different types, including formatted strings like "N12,345.67"
//      that Number() turns into NaN.
//   C. ZERO IS NOT MISSING. A real zero balance and an unparseable
//      response must never collapse into the same card — one means
//      "top up", the other means "your config is wrong".
//   D. NO DEFAULT for the wallet category, enforced server-side and
//      not merely hidden in the UI.
//   E. AUTH STYLE. The row's own authStyle is honoured, rather than
//      the hostname sniff that made the admin dropdown decoration.
//   F. AN HTML BODY is named as an IP allowlist problem, because
//      "Unexpected token <" tells the operator nothing about the
//      whitelisting that actually fixes it.
//   G. WHICH ROWS GET A CARD — one per vendor rather than one per
//      service row, every vendor rather than a chosen default, and
//      nothing at all for a vendor with no key anywhere. A figure
//      fetched perfectly but never rendered is the same as no figure,
//      so this frontend rule is verified here beside the backend.
//
//  ---- and then it breaks itself on purpose ----
//  A green suite proves nothing until you have watched it go red, so
//  the CONTROL block re-runs the key assertions against deliberately
//  broken versions of each function. A mutant that survives means the
//  assertion above it is decorative.
//
//  Usage:  node scripts/verify_provider_balance.js
// ============================================================

import {
  toAmount, parseBalance, balanceAuthHeader, resolveBalanceUrl,
  describeNonJson, allowsDefault, noDefaultCategories, displayUrl,
} from '../utils/providerBalance.js';
// Reaching across into the frontend on purpose. This rule decides whether an
// operator can SEE a balance at all, so an untested version of it makes every
// backend assertion above moot — a perfectly-fetched figure that never renders
// is the same as no figure. It is plain .js precisely so this import works.
import { balanceCardProviders } from '../../frontend/src/utils/balanceCards.js';

let failures = 0;
const ok = (name) => process.stdout.write(`  PASS  ${name}\n`);
const bad = (name, detail) => {
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        ${detail}\n`);
};
const check = (name, cond, detail) => (cond ? ok(name) : bad(name, detail));

// ------------------------------------------------------------
process.stdout.write('\nA. Balance URL resolution\n');

const MASKAWA_DATA = 'https://maskawasub.com/api/data/';

check(
  'a configured wallet row is used verbatim',
  resolveBalanceUrl({
    walletUrl: 'https://maskawasub.com/api/user/',
    fallbackBaseUrl: MASKAWA_DATA,
  }).url === 'https://maskawasub.com/api/user/',
  'the operator-supplied URL was rewritten',
);
check(
  'an unusual wallet path is NOT normalised to /api/user/',
  // The point of the whole change. A vendor whose balance lives somewhere
  // else was unreachable before, because the path was hard-coded.
  resolveBalanceUrl({
    walletUrl: 'https://premiumsub.com.ng/api/v2/account/balance',
    fallbackBaseUrl: 'https://premiumsub.com.ng/api/data/',
  }).url === 'https://premiumsub.com.ng/api/v2/account/balance',
  'a custom balance path was overwritten by the legacy guess',
);
check(
  'the wallet row wins over the guess',
  resolveBalanceUrl({ walletUrl: 'https://x.com/bal', fallbackBaseUrl: MASKAWA_DATA }).source === 'wallet-row',
  'the guess took priority over explicit configuration',
);

const rel = resolveBalanceUrl({ walletUrl: '/api/user/', fallbackBaseUrl: MASKAWA_DATA });
check(
  'a relative wallet path resolves against the vendor origin',
  rel.url === 'https://maskawasub.com/api/user/' && rel.source === 'wallet-row-relative',
  `got ${JSON.stringify(rel)}`,
);
check(
  'a relative path does NOT nest under the category path',
  // new URL('/api/user/', '…/api/data/') must not yield '…/api/data/api/user/'.
  !rel.url.includes('/api/data/'),
  `got ${rel.url}`,
);

const guessed = resolveBalanceUrl({ walletUrl: '', fallbackBaseUrl: MASKAWA_DATA });
check(
  'no wallet row falls back to the legacy guess',
  guessed.url === 'https://maskawasub.com/api/user/' && guessed.source === 'guessed',
  `got ${JSON.stringify(guessed)}`,
);
check(
  'the fallback is labelled as a guess, not as configuration',
  // The UI prints "path assumed" off this. A guess that reports itself as
  // configured is how the next breakage looks like a mystery.
  guessed.source === 'guessed',
  `source was ${guessed.source}`,
);
check(
  'nothing configured at all resolves to null, not a bad URL',
  resolveBalanceUrl({ walletUrl: '', fallbackBaseUrl: '' }) === null,
  'an empty config produced a URL to fetch',
);
check(
  'a non-URL baseUrl still yields something rather than throwing',
  resolveBalanceUrl({ walletUrl: '', fallbackBaseUrl: 'maskawasub.com' })?.url.endsWith('api/user/'),
  'the string-join fallback did not fire',
);
check(
  'whitespace around a pasted URL is trimmed',
  resolveBalanceUrl({ walletUrl: '  https://x.com/bal  ', fallbackBaseUrl: MASKAWA_DATA }).url
    === 'https://x.com/bal',
  'a copy-pasted URL with stray spaces was used raw',
);

// ------------------------------------------------------------
process.stdout.write('\nB. Reading the figure out of a vendor response\n');

const SHAPES = [
  ['legacy user.wallet_balance', { user: { wallet_balance: 12345.67 } }, 12345.67],
  ['top-level wallet_balance', { wallet_balance: 500 }, 500],
  ['top-level balance', { balance: 42 }, 42],
  ['user.balance', { user: { balance: 7 } }, 7],
  ['data-wrapped balance', { data: { balance: 88 } }, 88],
  ['data-wrapped wallet_balance', { data: { wallet_balance: 99 } }, 99],
  ['data.user.wallet_balance', { data: { user: { wallet_balance: 1 } } }, 1],
  // The types vendors actually send.
  ['numeric string', { balance: '1500.50' }, 1500.5],
  ['thousands separators', { balance: '12,345.67' }, 12345.67],
  ['naira-prefixed string', { balance: '₦12,345' }, 12345],
  ['N-prefixed string', { wallet_balance: 'N2,000' }, 2000],
  ['string with spaces', { balance: ' 300 ' }, 300],
];
for (const [label, payload, expected] of SHAPES) {
  const got = parseBalance(payload);
  check(`${label} -> ${expected}`, got === expected, `got ${JSON.stringify(got)}`);
}

const UNREADABLE = [
  ['empty object', {}],
  ['null', null],
  ['a string body', 'OK'],
  ['unrelated fields', { status: 'success', message: 'fine' }],
  ['non-numeric balance', { balance: 'unavailable' }],
  ['null balance', { balance: null }],
  ['empty-string balance', { balance: '' }],
];
for (const [label, payload] of UNREADABLE) {
  check(`${label} -> null (not 0)`, parseBalance(payload) === null, `got ${JSON.stringify(parseBalance(payload))}`);
}

// ------------------------------------------------------------
process.stdout.write('\nC. Zero is a balance, not a failure\n');
//  The old code ended with `parseFloat(balance) || 0`, which turned every
//  unparseable response into a confident "N0.00". An operator seeing zero
//  tops up; an operator seeing an error fixes their config. Collapsing the
//  two sends them to do the wrong thing.
check(
  'a genuine zero balance parses as 0',
  parseBalance({ balance: 0 }) === 0,
  'a real zero was reported as unreadable',
);
check(
  'a zero STRING balance parses as 0',
  parseBalance({ balance: '0' }) === 0,
  'a real zero was reported as unreadable',
);
check(
  'an unreadable response is null, NOT 0',
  parseBalance({ nothing: 'here' }) === null,
  'an unreadable response would render as a confident N0.00',
);
check(
  'toAmount separates the two as well',
  toAmount(0) === 0 && toAmount('abc') === null && toAmount(undefined) === null,
  `got ${toAmount(0)}, ${toAmount('abc')}, ${toAmount(undefined)}`,
);
check(
  'a negative balance (owed) survives',
  parseBalance({ balance: '-250.5' }) === -250.5,
  `got ${parseBalance({ balance: '-250.5' })}`,
);
check(
  'NaN and Infinity are rejected',
  toAmount(NaN) === null && toAmount(Infinity) === null,
  'a non-finite number would reach the card',
);

// ------------------------------------------------------------
process.stdout.write('\nD. Wallet has no default provider\n');
check('wallet refuses a default', allowsDefault('wallet') === false, 'wallet would accept isDefault');
check('data still allows one', allowsDefault('data') === true, 'a fulfilment category lost its default');
check('airtime still allows one', allowsDefault('airtime') === true, 'a fulfilment category lost its default');
check('cable still allows one', allowsDefault('cable') === true, 'a fulfilment category lost its default');
check('payment still allows one', allowsDefault('payment') === true, 'a gateway lost its default');
check('whatsapp still allows one', allowsDefault('whatsapp') === true, 'whatsapp lost its default');
check(
  'the list the UI reads matches the rule the API enforces',
  noDefaultCategories().length === 1 && noDefaultCategories()[0] === 'wallet',
  `got ${JSON.stringify(noDefaultCategories())}`,
);
check(
  'undefined/empty categories do not accidentally become no-default',
  allowsDefault(undefined) === true && allowsDefault('') === true,
  'a missing category was treated as wallet',
);

// ------------------------------------------------------------
process.stdout.write('\nE. Auth header follows the row, not the hostname\n');
check(
  'basic is honoured',
  balanceAuthHeader({ authStyle: 'basic', apiKey: 'K', baseUrl: 'https://x.com' }) === 'Basic K',
  'the admin dropdown was ignored',
);
check(
  'bearer is honoured',
  balanceAuthHeader({ authStyle: 'bearer', apiKey: 'K', baseUrl: 'https://x.com' }) === 'Bearer K',
  'the admin dropdown was ignored',
);
check(
  'token is the default',
  balanceAuthHeader({ authStyle: 'token', apiKey: 'K', baseUrl: 'https://x.com' }) === 'Token K',
  'the default changed',
);
check(
  'a missing authStyle still sends Token',
  balanceAuthHeader({ apiKey: 'K', baseUrl: 'https://x.com' }) === 'Token K',
  'rows saved before authStyle existed would break',
);
check(
  'the legacy hostname sniff still covers untouched rows',
  balanceAuthHeader({ authStyle: 'token', apiKey: 'K', baseUrl: 'https://n3tdata.com/api/' }) === 'Basic K',
  'an existing n3tdata row would start failing after upgrade',
);
check(
  'an explicit style beats the hostname sniff',
  balanceAuthHeader({ authStyle: 'bearer', apiKey: 'K', baseUrl: 'https://n3tdata.com/api/' }) === 'Bearer K',
  'the sniff overrode what the operator chose',
);

// ------------------------------------------------------------
process.stdout.write('\nF. An HTML body is named as an IP allowlist problem\n');
//  Premiumsub answers an unlisted server IP with an HTML "Access denied"
//  page, historically surfacing as a JSON parse error about "<". Nothing in
//  that message suggests whitelisting, which is what it actually needs.
for (const body of ['<!DOCTYPE html><html>Access denied', '<html><body>no</body></html>']) {
  check(
    `HTML body -> allowlist hint (${body.slice(0, 22)}…)`,
    /allowlist/i.test(describeNonJson(body)),
    `got ${JSON.stringify(describeNonJson(body))}`,
  );
}
check(
  'an empty body says so',
  /empty/i.test(describeNonJson('')),
  `got ${JSON.stringify(describeNonJson(''))}`,
);
check(
  'plain garbage is not blamed on the allowlist',
  !/allowlist/i.test(describeNonJson('kaboom')),
  'a non-HTML body was misdiagnosed as an IP problem',
);

// ------------------------------------------------------------
process.stdout.write('\nG. Which providers get a card\n');

// The operator's real table: Maskawasub and Premiumsub each hold one row per
// service plus a wallet row, and only ONE row per vendor carries the key.
const REAL_TABLE = [
  { name: 'Maskawasub', category: 'airtime', baseUrl: 'https://maskawasub.com/api/topup/', hasApiKey: true, isDefault: true },
  { name: 'Maskawasub', category: 'data', baseUrl: 'https://maskawasub.com/api/data/', hasApiKey: true, isDefault: true },
  { name: 'Maskawasub', category: 'wallet', baseUrl: 'https://maskawasub.com/api/user/', hasApiKey: false, isDefault: false },
  { name: 'Premiumsub', category: 'airtime', baseUrl: 'https://premiumsub.com.ng/api/topup/', hasApiKey: true, isDefault: false },
  { name: 'Premiumsub', category: 'wallet', baseUrl: 'https://premiumsub.com.ng/api/user/', hasApiKey: false, isDefault: false },
];
const picked = balanceCardProviders(REAL_TABLE);
check(
  'one card per vendor, not one per service row',
  picked.length === 2,
  `got ${picked.length}: ${JSON.stringify(picked.map((p) => `${p.name}/${p.category}`))}`,
);
check(
  'every card is a wallet row (so the configured URL is the one used)',
  picked.every((p) => p.category === 'wallet'),
  `got ${JSON.stringify(picked.map((p) => p.category))}`,
);
check(
  'BOTH vendors appear — no default means none is singled out',
  picked.some((p) => p.name === 'Maskawasub') && picked.some((p) => p.name === 'Premiumsub'),
  `got ${JSON.stringify(picked.map((p) => p.name))}`,
);
check(
  'a wallet row with no key ON ITSELF still gets a card',
  // The key lives on the sibling airtime row; the server falls back by name.
  // Requiring it on the wallet row would show nothing for a correct setup.
  picked.every((p) => p.hasApiKey === false),
  'the fixture no longer exercises the sibling-key fallback',
);

// A wallet row the operator created is NEVER dropped. It was, and the result
// was the bug report "i added another api wallet address now but the card that
// will show the balance is not show" — no card, no message, nothing to act on.
// The row is kept and `needs` names the missing piece.
check(
  'a vendor with NO key anywhere still gets a card, flagged as needing a key',
  (() => {
    const r = balanceCardProviders([
      { name: 'Newvendor', category: 'wallet', baseUrl: 'https://n.com/bal', hasApiKey: false },
    ]);
    return r.length === 1 && r[0].needs === 'key';
  })(),
  'a configured row vanished with no explanation — the original complaint',
);
check(
  'a wallet row with no Base URL is flagged as needing the URL',
  (() => {
    const r = balanceCardProviders([
      { name: 'V', category: 'wallet', baseUrl: '', hasApiKey: true },
    ]);
    return r.length === 1 && r[0].needs === 'url';
  })(),
  'the operator is not told which field is blank',
);
check(
  'a missing URL is reported ahead of a missing key',
  // Both can be absent. The URL is the field on the row in front of them; the
  // key is somewhere else entirely, so leading with it sends them to the wrong
  // screen.
  balanceCardProviders([
    { name: 'V', category: 'wallet', baseUrl: '', hasApiKey: false },
  ])[0].needs === 'url',
  'a blank Base URL was reported as a key problem',
);
check(
  'a fully configured row carries no `needs`, so it fetches',
  balanceCardProviders(REAL_TABLE).every((p) => p.needs === null),
  'a working card would render as unconfigured and never call the API',
);

// The defect behind the report: the server matches vendor names under a MySQL
// _ci collation (case-insensitive), so it finds the sibling key. A JS Set does
// not. The card was withheld for a setup that would have worked.
check(
  'a key on a differently-capitalised sibling row still counts',
  (() => {
    const r = balanceCardProviders([
      { name: 'Maskawasub', category: 'airtime', baseUrl: 'https://m.com/t/', hasApiKey: true },
      { name: 'maskawasub', category: 'wallet', baseUrl: 'https://m.com/bal', hasApiKey: false },
    ]);
    return r.length === 1 && r[0].needs === null;
  })(),
  'case-sensitive name matching hid a card whose balance would have fetched',
);
check(
  'surrounding whitespace in a name does not split a vendor in two',
  (() => {
    const r = balanceCardProviders([
      { name: 'Premiumsub ', category: 'data', baseUrl: 'https://p.com/d/', hasApiKey: true },
      { name: 'Premiumsub', category: 'wallet', baseUrl: 'https://p.com/bal', hasApiKey: false },
    ]);
    return r.length === 1 && r[0].needs === null;
  })(),
  'a stray space meant the key was not found',
);
check(
  'the legacy fallback dedupes case-insensitively too',
  balanceCardProviders([
    { name: 'Maskawasub', category: 'airtime', baseUrl: 'https://m.com/t/', hasApiKey: true },
    { name: 'MASKAWASUB', category: 'data', baseUrl: 'https://m.com/d/', hasApiKey: true },
  ]).length === 1,
  'one vendor rendered twice because the capitalisation differed',
);
check(
  'no wallet rows falls back to fulfilment rows, deduped by name',
  (() => {
    const legacy = balanceCardProviders([
      { name: 'Maskawasub', category: 'airtime', baseUrl: 'https://m.com/api/topup/', hasApiKey: true },
      { name: 'Maskawasub', category: 'data', baseUrl: 'https://m.com/api/data/', hasApiKey: true },
      { name: 'Maskawasub', category: 'cable', baseUrl: 'https://m.com/api/cable/', hasApiKey: true },
      { name: 'Nokey', category: 'data', baseUrl: 'https://n.com/', hasApiKey: false },
    ]);
    return legacy.length === 1 && legacy[0].name === 'Maskawasub';
  })(),
  'the pre-wallet-row install lost its cards',
);
check(
  'a whatsapp/payment row never becomes a balance card',
  balanceCardProviders([
    { name: 'Monnify', category: 'payment', baseUrl: 'https://x', hasApiKey: true },
    { name: 'Meta', category: 'whatsapp', baseUrl: 'https://y', hasApiKey: true },
  ]).length === 0,
  'a non-fulfilment provider was asked for a wallet balance',
);
check(
  'a payment/whatsapp row is not counted as a key source for a wallet card',
  // Monnify holds a key, but it is a gateway. If its name ever matched a
  // fulfilment vendor's, that key would not authenticate the balance call.
  // Kept as a card WITH `needs`, so nothing silently disappears either way.
  (() => {
    const r = balanceCardProviders([
      { name: 'Solo', category: 'wallet', baseUrl: 'https://s.com/bal', hasApiKey: false },
      { name: 'Monnify', category: 'payment', baseUrl: 'https://x', hasApiKey: true },
    ]);
    return r.length === 1 && r[0].name === 'Solo' && r[0].needs === 'key';
  })(),
  'an unrelated gateway key satisfied a wallet row',
);
check(
  'an empty or missing list does not throw',
  balanceCardProviders([]).length === 0 && balanceCardProviders(undefined).length === 0,
  'the first render (before providers load) would crash the page',
);
check(
  'a wallet row wins over its own vendor\'s fulfilment rows',
  // Both are candidates; taking the fulfilment row would use the legacy
  // guessed URL and ignore the path the operator configured.
  balanceCardProviders(REAL_TABLE).every((p) => p.category === 'wallet'),
  'a fulfilment row shadowed a configured wallet row',
);

// ------------------------------------------------------------
process.stdout.write('\nH. The URL is shown without its query string\n');
//  Error copy names the endpoint that answered, because "no balance field"
//  is unactionable without it. Some vendors authenticate by query string, so
//  Base URL may hold `?token=LIVE_KEY` — which would otherwise reach the
//  admin screen, the log file, and any screenshot of either.
check(
  'a query-string key never survives',
  displayUrl('https://v.com/api/balance?token=SECRET123') === 'https://v.com/api/balance?…',
  `got ${displayUrl('https://v.com/api/balance?token=SECRET123')}`,
);
check(
  'the secret value itself is absent from the output',
  !displayUrl('https://v.com/bal?apikey=SUPERSECRET&x=1').includes('SUPERSECRET'),
  'a live key would be printed to the admin screen',
);
check(
  'the path is kept, so two endpoints stay distinguishable',
  displayUrl('https://maskawasub.com/api/user/') === 'https://maskawasub.com/api/user/',
  `got ${displayUrl('https://maskawasub.com/api/user/')}`,
);
check(
  'a fragment is dropped too',
  displayUrl('https://v.com/bal#tok=abc') === 'https://v.com/bal',
  `got ${displayUrl('https://v.com/bal#tok=abc')}`,
);
check(
  'an unparseable string is still cut at the first ?',
  displayUrl('not a url?token=SECRET') === 'not a url',
  `got ${displayUrl('not a url?token=SECRET')}`,
);
check(
  'empty input yields empty, not "undefined"',
  displayUrl('') === '' && displayUrl(undefined) === '' && displayUrl(null) === '',
  'a missing URL would render the string "undefined" to the operator',
);

// ------------------------------------------------------------
//  CONTROL — every assertion above must be able to fail
// ------------------------------------------------------------
process.stdout.write('\nCONTROL: re-running key assertions against broken implementations\n');
let uncaught = 0;
const mutant = (label, caught) => {
  if (caught) process.stdout.write(`  caught  ${label}\n`);
  else {
    uncaught += 1;
    process.stdout.write(`  MISSED  ${label} — the assertion above it proves nothing\n`);
  }
};

// 1. The original bug: always guess /api/user/, ignoring the wallet row.
const brokenResolve = ({ fallbackBaseUrl }) => ({
  url: new URL('/api/user/', fallbackBaseUrl).href, source: 'guessed',
});
mutant(
  'resolveBalanceUrl ignores the wallet row',
  brokenResolve({ fallbackBaseUrl: 'https://premiumsub.com.ng/api/data/' }).url
    !== 'https://premiumsub.com.ng/api/v2/account/balance',
);

// 1b. Case-sensitive vendor matching — the reported defect. The server finds
//     the sibling key (MySQL _ci collation), the UI does not, so the card is
//     withheld from a setup that would have fetched fine.
const brokenCase = (rows) => {
  const keyed = new Set(rows.filter((p) => p.hasApiKey).map((p) => p.name));
  return rows.filter((p) => p.category === 'wallet' && p.baseUrl && keyed.has(p.name));
};
const mixedCase = [
  { name: 'Maskawasub', category: 'airtime', baseUrl: 'https://m.com/t/', hasApiKey: true },
  { name: 'maskawasub', category: 'wallet', baseUrl: 'https://m.com/bal', hasApiKey: false },
];
mutant(
  'vendor names are matched case-sensitively',
  brokenCase(mixedCase).length === 0
    && balanceCardProviders(mixedCase).length === 1,
);

// 1c. Silently dropping an unconfigured wallet row: the operator adds a row,
//     nothing appears, and there is no message anywhere saying why.
const brokenDrop = (rows) => rows.filter(
  (p) => p.category === 'wallet' && p.baseUrl
    && rows.some((s) => s.hasApiKey && s.name === p.name),
);
const halfDone = [{ name: 'Newvendor', category: 'wallet', baseUrl: 'https://n.com/bal', hasApiKey: false }];
mutant(
  'an unconfigured wallet row disappears instead of explaining itself',
  brokenDrop(halfDone).length === 0
    && balanceCardProviders(halfDone).length === 1
    && balanceCardProviders(halfDone)[0].needs === 'key',
);

// 1d. Flagging every row as needing something — cards would render as "Not set
//     up" forever and never call the API.
const brokenAlwaysNeeds = (rows) => balanceCardProviders(rows).map((p) => ({ ...p, needs: 'key' }));
mutant(
  'a fully configured row is still marked unconfigured',
  brokenAlwaysNeeds(REAL_TABLE).every((p) => p.needs === 'key')
    && balanceCardProviders(REAL_TABLE).every((p) => p.needs === null),
);

// 2. The original parse: `parseFloat(x) || 0`, which hides every failure
//    behind a confident zero.
const brokenParse = (p) => parseFloat(p?.balance ?? p?.wallet_balance) || 0;
mutant(
  'parseBalance returns 0 for an unreadable response',
  brokenParse({ nothing: 'here' }) === 0 && parseBalance({ nothing: 'here' }) === null,
);
mutant(
  'parseBalance mangles a formatted string',
  // parseFloat("12,345.67") === 12 — off by a thousandfold, and it would
  // have rendered as a plausible-looking N12.00.
  brokenParse({ balance: '12,345.67' }) === 12 && parseBalance({ balance: '12,345.67' }) === 12345.67,
);

// 3. Wallet allowed a default.
const brokenAllows = () => true;
mutant('allowsDefault always true', brokenAllows('wallet') === true && allowsDefault('wallet') === false);

// 4. Auth ignores the row's style (the pre-change behaviour).
const brokenAuth = ({ apiKey, baseUrl }) => (/n3tdata|bilalsadasub/i.test(baseUrl) ? `Basic ${apiKey}` : `Token ${apiKey}`);
mutant(
  'auth header ignores authStyle',
  brokenAuth({ authStyle: 'bearer', apiKey: 'K', baseUrl: 'https://x.com' }) === 'Token K'
    && balanceAuthHeader({ authStyle: 'bearer', apiKey: 'K', baseUrl: 'https://x.com' }) === 'Bearer K',
);

// 5. Non-JSON bodies all described the same way.
const brokenDescribe = () => 'Provider response was not JSON.';
mutant(
  'describeNonJson gives no allowlist hint',
  !/allowlist/i.test(brokenDescribe('<html>')) && /allowlist/i.test(describeNonJson('<html>')),
);

// 6. The pre-change card filter: fulfilment categories only, so a wallet row
//    is never picked and the configured balance URL is never used.
const brokenCards = (ps) => {
  const F = ['airtime', 'data', 'cable', 'electricity'];
  const seen = new Set();
  return ps.filter((p) => {
    if (!p.hasApiKey || !F.includes(p.category) || seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
};
mutant(
  'card filter ignores wallet rows',
  brokenCards(REAL_TABLE).every((p) => p.category !== 'wallet')
    && balanceCardProviders(REAL_TABLE).every((p) => p.category === 'wallet'),
);
mutant(
  'card filter requires the key on the wallet row itself',
  // Would show nothing for the operator's real table, where the key sits on
  // the sibling airtime row.
  REAL_TABLE.filter((p) => p.category === 'wallet' && p.hasApiKey).length === 0
    && balanceCardProviders(REAL_TABLE).length === 2,
);

// 6b. The redactor that isn't: echo the URL as given. An untested redactor is
//     worse than none, because it reads as protection while leaking.
const brokenDisplay = (u) => String(u || '');
mutant(
  'displayUrl passes the query string through',
  brokenDisplay('https://v.com/bal?token=SECRET123').includes('SECRET123')
    && !displayUrl('https://v.com/bal?token=SECRET123').includes('SECRET123'),
);

// 7. Superseded by the operator's report. This used to assert that a keyless
//    vendor got NO card, on the reasoning that a red "Unavailable" on a fresh
//    install looks broken. True, but the cure was worse: a row the operator had
//    just created produced no card and no message at all, which looks *more*
//    broken and gives them nothing to act on. The rule is now "always render,
//    but say what is missing", so the risk worth guarding is the opposite one —
//    a keyless row rendering as a live card that fetches and fails red.
const NEW_INSTALL = [
  { name: 'Newvendor', category: 'wallet', baseUrl: 'https://n.com/bal', hasApiKey: false },
];
const brokenKeyless = (ps) => ps
  .filter((p) => p.category === 'wallet' && p.baseUrl)
  .map((p) => ({ ...p, needs: null })); // renders as ready → fetches → red
mutant(
  'a keyless wallet row is rendered as a live card instead of "Not set up"',
  brokenKeyless(NEW_INSTALL)[0].needs === null
    && balanceCardProviders(NEW_INSTALL)[0].needs === 'key',
);

// 8. Drop the name dedupe on the fulfilment fallback: an install with no
//    wallet rows shows Maskawasub four times, once per service row, each
//    card fetching the same balance from the same guessed URL.
const NO_WALLET_ROWS = [
  { name: 'Maskawasub', category: 'airtime', baseUrl: 'https://m.com/api/topup/', hasApiKey: true },
  { name: 'Maskawasub', category: 'data', baseUrl: 'https://m.com/api/data/', hasApiKey: true },
  { name: 'Maskawasub', category: 'cable', baseUrl: 'https://m.com/api/cable/', hasApiKey: true },
];
const brokenDedupe = (ps) => ps.filter(
  (p) => p.hasApiKey && ['airtime', 'data', 'cable', 'electricity'].includes(p.category),
);
mutant(
  'fulfilment fallback loses the name dedupe',
  brokenDedupe(NO_WALLET_ROWS).length === 3 && balanceCardProviders(NO_WALLET_ROWS).length === 1,
);

// 9. Consult `status`. The seeded wallet rows arrive inactive and no purchase
//    path ever looks one up, so gating on it hides every card immediately
//    after migration — a plausible-looking filter that reproduces the bug.
const SEEDED = REAL_TABLE.map((p) => (p.category === 'wallet' ? { ...p, status: 'inactive' } : { ...p, status: 'active' }));
const brokenStatus = (ps) => ps.filter(
  (p) => p.category === 'wallet' && p.baseUrl && p.status === 'active',
);
mutant(
  'card filter gates wallet rows on status',
  brokenStatus(SEEDED).length === 0 && balanceCardProviders(SEEDED).length === 2,
);

// ------------------------------------------------------------
process.stdout.write('\n' + '-'.repeat(58) + '\n');
if (failures === 0 && uncaught === 0) {
  process.stdout.write('All checks passed, and every control mutant was caught.\n\n');
  process.exit(0);
}
if (failures) process.stdout.write(`${failures} assertion(s) failed.\n`);
if (uncaught) {
  process.stdout.write(
    `${uncaught} control mutant(s) survived — those assertions are decorative.\n`,
  );
}
process.stdout.write('\n');
process.exit(1);
