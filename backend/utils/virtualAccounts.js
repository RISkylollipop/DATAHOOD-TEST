// ============================================================
//  Virtual (reserved) account helper
// ------------------------------------------------------------
//  A user may hold reserved accounts at SEVERAL gateways at once —
//  one set each from Monnify, Paymentpoint, Palmpay. Within one
//  gateway there may still be several partner banks (Monnify hands
//  back up to four: Wema / Moniepoint / Sterling / Fidelity).
//
//  Storage lives in `virtual_accounts`, one row per account. Before
//  that table existed, accounts were four flat columns on
//  `subscribers` — which could hold exactly one gateway, and whose
//  single `sVirtualAccountRef` made a second gateway overwrite the
//  first one's webhook lookup key. See sql/virtual_accounts_table.sql.
//
//  Live users still have those columns populated, so this module reads
//  BOTH and merges: table rows first, then any legacy account number
//  the table does not already know about. Nothing is migrated eagerly
//  — a user who never funds again never needs a row.
//
//  Comparisons between table and legacy values happen HERE, in JS,
//  never as a SQL join. The legacy tables are latin1 and the new one
//  is utf8mb4; cross-collation comparison has already broken queries
//  in this project twice.
// ============================================================

import { VirtualAccount } from '../models/index.js';

/**
 * Legacy column -> bank label map. `sBankNo` is the primary slot and
 * carries its own label in `sBankName`; the rest are fixed banks from
 * the Monnify multi-account response.
 */
const SLOTS = [
  { field: 'sBankNo', label: null, fallback: 'Wema Bank' },
  { field: 'sRolexBank', label: 'Moniepoint MFB', fallback: 'Moniepoint MFB' },
  { field: 'sSterlingBank', label: 'Sterling Bank', fallback: 'Sterling Bank' },
  { field: 'sFidelityBank', label: 'Fidelity Bank', fallback: 'Fidelity Bank' },
];

/** Legacy rows carry no gateway. These bank names only ever came from one. */
const BANK_TO_GATEWAY = [
  [/wema|moniepoint|monie ?point|sterling|fidelity/i, 'monnify'],
  [/palmpay/i, 'palmpay'],
];

/**
 * Which gateway issued a legacy account, judged by its bank name.
 *
 * Deliberately conservative: an unrecognised bank returns null rather
 * than a guess. A wrong guess is worse than no guess — it would tell
 * the user they already hold a gateway they do not, hiding the only
 * button that would fix their funding. null reads as "unknown", which
 * blocks nothing.
 */
export function inferGateway(bankName) {
  const name = String(bankName || '');
  if (!name) return null;
  for (const [re, gateway] of BANK_TO_GATEWAY) {
    if (re.test(name)) return gateway;
  }
  return null;
}

/** Reject '', null, and the legacy '0'/'null' placeholder strings. */
function cleanNumber(value) {
  if (!value) return '';
  const clean = String(value).trim();
  if (!clean || clean === '0' || clean.toLowerCase() === 'null') return '';
  return clean;
}

/** The name a sender sees at their bank. */
function displayName(user) {
  return [user.sFname, user.sLname].filter(Boolean).join(' ').trim()
    || user.sPhone
    || '';
}

/**
 * Accounts still held only in the old Subscriber columns.
 * Exported for the migration harness and for callers that already have
 * a Subscriber in hand but no database access.
 */
export function legacyVirtualAccounts(user) {
  if (!user) return [];
  const accountName = displayName(user);
  const reference = cleanNumber(user.sVirtualAccountRef);

  const out = [];
  for (const slot of SLOTS) {
    const number = cleanNumber(user[slot.field]);
    if (!number) continue;
    const bankName = slot.label || user.sBankName || slot.fallback;
    out.push({
      gateway: inferGateway(bankName),
      bankName,
      accountNumber: number,
      accountName,
      // Every legacy account shares the one column, which is exactly the
      // defect this table fixes. Kept so the webhook fallback can match.
      accountReference: reference,
      legacy: true,
    });
  }
  return out;
}

/**
 * Every reserved account a user can be funded through.
 *
 * @param {object} user A Subscriber instance (or plain row).
 * @returns {Promise<Array<{gateway: string|null, bankName: string,
 *   accountNumber: string, accountName: string, accountReference: string,
 *   legacy: boolean}>>}
 */
export async function buildVirtualAccounts(user) {
  if (!user) return [];

  const rows = await VirtualAccount.findAll({
    where: { sId: user.sId, status: 'active' },
    order: [['gateway', 'ASC'], ['id', 'ASC']],
  });

  const out = rows.map((r) => ({
    gateway: r.gateway || null,
    bankName: r.bankName || '',
    accountNumber: String(r.accountNumber || ''),
    accountName: r.accountName || displayName(user),
    accountReference: String(r.accountReference || ''),
    legacy: false,
  }));

  // Merge legacy columns by account NUMBER, not by gateway: the same
  // account may appear in both places during migration, and showing a
  // user two copies of one account number invites them to pay the
  // wrong one twice over.
  const known = new Set(out.map((a) => a.accountNumber));
  for (const acct of legacyVirtualAccounts(user)) {
    if (known.has(acct.accountNumber)) continue;
    known.add(acct.accountNumber);
    out.push(acct);
  }
  return out;
}

/** True when the user holds at least one reserved account anywhere. */
export async function hasVirtualAccount(user) {
  return (await buildVirtualAccounts(user)).length > 0;
}

/**
 * Gateway keys the user already holds an account with.
 *
 * Legacy accounts whose gateway could not be inferred are omitted on
 * purpose — see inferGateway. The cost of omitting is a duplicate
 * account at one gateway; the cost of guessing wrong is a user who can
 * never add a working gateway.
 */
export async function heldGateways(user) {
  const accounts = await buildVirtualAccounts(user);
  return new Set(accounts.map((a) => a.gateway).filter(Boolean));
}

/**
 * Group accounts for display: one entry per gateway, banks nested.
 * `gateway: null` collects legacy accounts of unknown origin.
 */
export function groupByGateway(accounts) {
  const groups = new Map();
  for (const acct of accounts) {
    const key = acct.gateway || '';
    if (!groups.has(key)) groups.set(key, { gateway: acct.gateway || null, accounts: [] });
    groups.get(key).accounts.push(acct);
  }
  return [...groups.values()];
}
