// ============================================================
//  Provider Controller — admin management of ALL providers
// ------------------------------------------------------------
//  Powers the admin "Providers" screen. One place to add/remove/
//  toggle providers for: airtime, data, cable, electricity, exam
//  (JAMB/WAEC/NECO), rechargepin, BVN validation, NIN verification,
//  payment gateways, WhatsApp, and wallet.
//
//  Security:
//   - apiKey / secretKey are ENCRYPTED at rest (AES-256-GCM).
//   - Secrets are NEVER returned to the client in full — only a
//     masked hint (last 4 chars) so the admin can tell them apart.
//   - Every write that sets a baseUrl goes through validateBaseUrl, so an
//     unsafe outbound target is refused at save time rather than at fetch
//     time. See the long note above that function for why the ordering
//     matters to refunds.
//   - Every privileged action here writes an admin_audit_log row (actor +
//     IP + user agent). The file log rotates and is purged under the
//     retention policy; these rows are the durable answer to "who pointed
//     our provider credentials at that host". Nothing in this file has a
//     ledger entry to fall back on.
//
//  WHERE A SECRET IS DECRYPTED — the full list, because an inaccurate
//  version of this list is how a decrypt site goes unreviewed:
//   1. maskSecret(), i.e. on EVERY listProviders call, for every row that
//      has a key. It only keeps the last 4 chars, but the plaintext does
//      exist in memory for a moment, and the frequency is "every time the
//      Providers screen opens" rather than anything rare.
//   2. getProviderBalance(), which puts the key in an Authorization header
//      on an outbound request. This is the only place a provider key
//      configured here leaves the server from this file, and it is guarded
//      and audited accordingly.
//   3. The purchase controllers (airtime/data/cable/...), which decrypt at
//      the moment of a sale. Not in this file.
//  testProvider() is NOT on that list: it checks reachability with no
//  credential attached, which is why plain http is tolerated there.
// ============================================================

import { Provider } from '../models/index.js';
import { encryptSecret, decryptSecret } from '../utils/crypto.js';
import { testProviderConnection } from '../services/providerService.js';
import {
  resolveBalanceUrl, balanceAuthHeader, parseBalance, describeNonJson,
  allowsDefault, noDefaultCategories, displayUrl,
} from '../utils/providerBalance.js';
import { checkOutboundUrl } from '../utils/ssrfGuard.js';
import { audit, auditAsync } from '../utils/auditLog.js';
import * as logger from '../utils/logger.js';

// ============================================================
//  A NOTE ON WHAT GOES IN AN AUDIT `detail` ON THIS FILE
// ------------------------------------------------------------
//  Provider rows hold the platform's outbound credentials, so the
//  temptation to record "what changed" is strongest exactly where it is
//  most dangerous. Two rules, both load-bearing:
//
//  1. A URL is recorded through displayUrl(), never raw. Several vendors
//     accept the API key as a query parameter, so a raw baseUrl can BE a
//     credential. displayUrl() keeps origin + path and collapses any
//     query string to '?…'.
//
//  2. Secret CHANGES are recorded as booleans, and the boolean must not
//     be named after the secret. utils/auditLog.js redacts on a
//     case-insensitive SUBSTRING match, and its pattern list contains
//     'apikey' and 'auth' — so a harmless `{ apiKeyRotated: true }`
//     would be stored as '[redacted]', which is worse than omitting it:
//     it reads as though a real secret leaked into the row and was caught.
//     Hence `credentialsChanged` and `keyStyle`.
// ============================================================

const CATEGORIES = [
  'airtime', 'data', 'cable', 'electricity', 'exam',
  'rechargepin', 'bvn', 'nin', 'payment', 'whatsapp', 'wallet',
];

// Show only the last 4 chars of a secret so the admin can identify it
// without ever exposing the full value.
function maskSecret(encrypted) {
  if (!encrypted) return null;
  try {
    const plain = decryptSecret(encrypted);
    if (!plain) return null;
    const tail = plain.slice(-4);
    return `••••${tail}`;
  } catch {
    return '••••';
  }
}

// Safe representation of a provider row for the client (no raw secrets).
function publicProvider(p) {
  let extra = null;
  if (p.extraConfig) {
    try { extra = JSON.parse(p.extraConfig); } catch { extra = null; }
  }
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    baseUrl: p.baseUrl,
    apiKeyHint: maskSecret(p.apiKey),
    secretKeyHint: maskSecret(p.secretKey),
    hasApiKey: Boolean(p.apiKey),
    hasSecretKey: Boolean(p.secretKey),
    extraConfig: extra,
    authStyle: p.authStyle,
    status: p.status,
    isDefault: p.isDefault,
    lastCheckedAt: p.lastCheckedAt,
    lastStatus: p.lastStatus,
    createdAt: p.createdAt,
  };
}

// ---------- List ----------

/**
 * GET /api/admin/providers?category=data
 */
export async function listProviders(req, res) {
  try {
    const where = {};
    if (req.query.category) where.category = req.query.category;

    const providers = await Provider.findAll({ where, order: [['category', 'ASC'], ['name', 'ASC']] });
    return res.json({
      status: 'success',
      categories: CATEGORIES,
      // Sent, not duplicated in the client: the UI hides the "default"
      // checkbox for these. A second hard-coded copy of the rule in JSX is
      // one refactor away from disagreeing with the server.
      noDefaultCategories: noDefaultCategories(),
      data: providers.map(publicProvider),
    });
  } catch (err) {
    logger.error('listProviders failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load providers.' });
  }
}

// ---------- Create ----------

// ============================================================
//  Write-time validation of an admin-supplied baseUrl
// ------------------------------------------------------------
//  Every provider driver eventually fetch()es this value with a
//  DECRYPTED api key attached. Validating on the way IN is better than
//  validating at fetch time for one specific reason: the purchase path
//  cannot tell "we refused to dial" apart from "we dialled and don't
//  know what happened" — services/providerService.js classifyFetchError
//  maps any non-timeout throw to 'network-error', and dataController
//  treats that as delivery-unknown and deliberately LEAVES the wallet
//  debited pending reconciliation. So a guard that threw from inside the
//  shared fetch would strand a real customer's money every time an admin
//  fat-fingered a URL. Rejecting the row at save time keeps the bad value
//  out of the database entirely and leaves refund semantics untouched.
//
//  Two deliberate carve-outs:
//
//  1. A BARE PATH is allowed. A `wallet` row may legitimately hold just
//     '/api/user/balance', which resolveBalanceUrl() joins onto a sibling
//     row's origin. Only values carrying their own scheme are checked
//     here; the joined result is re-checked in getProviderBalance.
//
//  2. PLAIN HTTP IS WARNED, NOT REFUSED. requireHttps is off because a
//     hard refusal would mean an admin editing an existing http provider
//     (to rotate a key, say) could no longer save it at all — turning a
//     hardening change into an outage. The confidentiality rule is still
//     enforced where a plaintext key actually goes on the wire, in
//     getProviderBalance below.
// ============================================================
function validateBaseUrl(raw, { name, category }) {
  const value = String(raw).trim();

  // No scheme => a relative path, not a fetch target on its own.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return { ok: true };

  const verdict = checkOutboundUrl(value, { requireHttps: false });
  if (!verdict.ok) {
    return {
      ok: false,
      msg: `That Base URL is not allowed: ${verdict.reason}.`,
    };
  }
  if (verdict.url.protocol === 'http:') {
    logger.warn('Provider saved with a plain-http Base URL', {
      name, category, host: verdict.url.hostname,
    });
  }
  return { ok: true };
}

/**
 * POST /api/admin/providers
 * body: { name, category, baseUrl, apiKey?, secretKey?, extraConfig?, authStyle?, status?, isDefault? }
 */
export async function createProvider(req, res) {
  try {
    const { name, category, baseUrl, apiKey, secretKey, extraConfig, authStyle, status, isDefault } = req.body;

    if (!name || !category) {
      return res.status(400).json({ status: 'fail', msg: 'Provider name and category are required.' });
    }
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ status: 'fail', msg: `Invalid category. Allowed: ${CATEGORIES.join(', ')}` });
    }
    if (baseUrl) {
      const urlCheck = validateBaseUrl(baseUrl, { name, category });
      if (!urlCheck.ok) {
        // A refused URL is a security event, not a typo, and it gets a durable
        // row with the actor and IP on it. checkOutboundUrl rejects loopback,
        // private ranges and the cloud metadata address — an admin does not
        // reach for 169.254.169.254 by accident, so a cluster of these is
        // either a compromised admin session or someone probing the VPS's own
        // internals through our own admin API.
        await audit({
          req, action: 'provider.create', targetType: 'provider', outcome: 'fail',
          detail: { refused: 'unsafe-base-url', reason: urlCheck.msg, category, url: displayUrl(baseUrl) },
        });
        return res.status(400).json({ status: 'fail', msg: urlCheck.msg });
      }
    }

    const provider = await Provider.create({
      name: String(name).trim(),
      category,
      baseUrl: baseUrl ? String(baseUrl).trim() : null,
      apiKey: apiKey ? encryptSecret(apiKey) : null,
      secretKey: secretKey ? encryptSecret(secretKey) : null,
      extraConfig: extraConfig ? JSON.stringify(extraConfig) : null,
      authStyle: authStyle || 'token',
      status: status === 'active' ? 'active' : 'inactive',
      // Enforced here rather than only hidden in the UI: the admin API is
      // reachable directly, and a stray isDefault on a wallet row is exactly
      // the state that makes only one balance card appear.
      isDefault: allowsDefault(category) ? Boolean(isDefault) : false,
    });

    // If flagged default, clear default from siblings in the same category.
    if (provider.isDefault) {
      await ensureSingleDefault(category, provider.id);
    }

    logger.info('Provider created', { id: provider.id, category, name });
    // Awaited, unlike the wallet paths: a provider row is the platform's
    // outbound trust boundary and there is no ledger, no transaction and no
    // second copy of this fact anywhere. If the insert is going to fail, it
    // should fail before the admin is told the row was saved. audit() cannot
    // throw, so this can only add latency to a once-in-a-while admin action.
    await audit({
      req, action: 'provider.create', targetType: 'provider', targetId: provider.id,
      detail: {
        name: provider.name,
        category,
        url: provider.baseUrl ? displayUrl(provider.baseUrl) : null,
        credentialsChanged: Boolean(apiKey || secretKey),
        keyStyle: provider.authStyle,
        status: provider.status,
        isDefault: provider.isDefault,
      },
    });
    return res.status(201).json({ status: 'success', msg: 'Provider added.', data: publicProvider(provider) });
  } catch (err) {
    logger.error('createProvider failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not add provider.' });
  }
}

// ---------- Update ----------

/**
 * PUT /api/admin/providers/:id
 * Only re-encrypts a secret if a NEW value is supplied (empty = keep existing).
 */
export async function updateProvider(req, res) {
  try {
    const provider = await Provider.findByPk(req.params.id);
    if (!provider) return res.status(404).json({ status: 'fail', msg: 'Provider not found.' });

    const { name, baseUrl, apiKey, secretKey, extraConfig, authStyle, status, isDefault } = req.body;

    if (baseUrl) {
      const urlCheck = validateBaseUrl(baseUrl, {
        name: name || provider.name, category: provider.category,
      });
      if (!urlCheck.ok) {
        await audit({
          req, action: 'provider.update', targetType: 'provider', targetId: provider.id,
          outcome: 'fail',
          detail: { refused: 'unsafe-base-url', reason: urlCheck.msg, url: displayUrl(baseUrl) },
        });
        return res.status(400).json({ status: 'fail', msg: urlCheck.msg });
      }
    }

    // Read BEFORE the assignments below. The single most valuable sentence this
    // audit row can produce is "the URL our decrypted provider key is sent to
    // changed from A to B" — and after `provider.baseUrl = ...` runs, A is gone
    // and the row could only ever say "it is now B", which is also what a
    // routine no-op save says. Same reason previousStatus is captured before the
    // assignment in userController.changeStatus.
    const previousUrl = provider.baseUrl;
    const previousStatus = provider.status;

    if (name !== undefined) provider.name = String(name).trim();
    if (baseUrl !== undefined) provider.baseUrl = baseUrl ? String(baseUrl).trim() : null;
    if (authStyle !== undefined) provider.authStyle = authStyle;
    if (status !== undefined) provider.status = status === 'active' ? 'active' : 'inactive';
    if (extraConfig !== undefined) provider.extraConfig = extraConfig ? JSON.stringify(extraConfig) : null;

    // Only overwrite secrets when a non-empty value is provided.
    if (apiKey) provider.apiKey = encryptSecret(apiKey);
    if (secretKey) provider.secretKey = encryptSecret(secretKey);

    if (isDefault !== undefined) {
      provider.isDefault = allowsDefault(provider.category) ? Boolean(isDefault) : false;
    }

    await provider.save();

    if (provider.isDefault) await ensureSingleDefault(provider.category, provider.id);

    logger.info('Provider updated', { id: provider.id });
    await audit({
      req, action: 'provider.update', targetType: 'provider', targetId: provider.id,
      detail: {
        name: provider.name,
        category: provider.category,
        // Both sides, and only when they actually differ. An unconditional
        // before/after pair on every save buries the one row that matters
        // under a hundred that say nothing changed.
        ...(provider.baseUrl !== previousUrl ? {
          urlFrom: previousUrl ? displayUrl(previousUrl) : null,
          urlTo: provider.baseUrl ? displayUrl(provider.baseUrl) : null,
        } : {}),
        ...(provider.status !== previousStatus ? { statusFrom: previousStatus, statusTo: provider.status } : {}),
        // True means a NEW secret was written over the old one. The value is
        // never recorded, in any form — not masked, not hashed, not a length.
        // See the header note on why this key is not called apiKeyRotated.
        credentialsChanged: Boolean(apiKey || secretKey),
        keyStyle: provider.authStyle,
        isDefault: provider.isDefault,
      },
    });
    return res.json({ status: 'success', msg: 'Provider updated.', data: publicProvider(provider) });
  } catch (err) {
    logger.error('updateProvider failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not update provider.' });
  }
}

// ---------- Toggle status ----------

/**
 * PATCH /api/admin/providers/:id/toggle
 */
export async function toggleProvider(req, res) {
  try {
    const provider = await Provider.findByPk(req.params.id);
    if (!provider) return res.status(404).json({ status: 'fail', msg: 'Provider not found.' });

    provider.status = provider.status === 'active' ? 'inactive' : 'active';
    await provider.save();

    // An availability action, and it cuts both ways. Flipping a default row to
    // inactive stops every purchase in that category — which surfaces to
    // customers as "no active provider configured", a refund path. Flipping one
    // TO active silently starts routing real money through a row someone had
    // deliberately parked. Neither leaves a ledger entry.
    await audit({
      req, action: 'provider.toggle', targetType: 'provider', targetId: provider.id,
      detail: {
        name: provider.name, category: provider.category,
        statusTo: provider.status, isDefault: provider.isDefault,
      },
    });

    return res.json({
      status: 'success',
      msg: `Provider ${provider.status === 'active' ? 'activated' : 'deactivated'}.`,
      data: publicProvider(provider),
    });
  } catch (err) {
    logger.error('toggleProvider failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not change provider status.' });
  }
}

// ---------- Delete ----------

/**
 * DELETE /api/admin/providers/:id
 */
export async function deleteProvider(req, res) {
  try {
    const provider = await Provider.findByPk(req.params.id);
    if (!provider) return res.status(404).json({ status: 'fail', msg: 'Provider not found.' });

    // Read before destroy(): afterwards the instance is detached and the row is
    // gone, so this is the only surviving description of WHAT was deleted. An
    // audit row saying nothing but the id is close to useless a month later.
    const erased = {
      name: provider.name,
      category: provider.category,
      url: provider.baseUrl ? displayUrl(provider.baseUrl) : null,
      hadCredentials: Boolean(provider.apiKey || provider.secretKey),
      wasDefault: provider.isDefault,
    };

    await provider.destroy();
    logger.info('Provider deleted', { id: req.params.id });
    // Deleting the default row for a category is an outage: the purchase
    // controllers look up { status:'active', isDefault:true } and refund when
    // they find nothing. That makes this the one destructive action here whose
    // effect a customer feels within seconds.
    await audit({
      req, action: 'provider.delete', targetType: 'provider', targetId: provider.id,
      detail: erased,
    });
    return res.json({ status: 'success', msg: 'Provider removed.' });
  } catch (err) {
    logger.error('deleteProvider failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not remove provider.' });
  }
}

// ---------- Test connection ----------

/**
 * POST /api/admin/providers/:id/test
 * Runs a live reachability check. MUST run on your server (needs real network).
 */
export async function testProvider(req, res) {
  try {
    const provider = await Provider.findByPk(req.params.id);
    if (!provider) return res.status(404).json({ status: 'fail', msg: 'Provider not found.' });
    if (!provider.baseUrl) {
      return res.status(400).json({ status: 'fail', msg: 'This provider has no base URL to test.' });
    }

    // Rows written before validateBaseUrl existed are not covered by the
    // write-time check, and this endpoint is the most direct SSRF primitive
    // in the admin API: it reports reachability, which is exactly the signal
    // a port scan of the VPS's own internals needs. http is tolerated here
    // (no credential is sent) but a private/loopback target is not.
    const safeTest = checkOutboundUrl(provider.baseUrl, { requireHttps: false });
    if (!safeTest.ok) {
      logger.warn('Blocked provider reachability test to an unsafe URL', {
        provider: provider.name, reason: safeTest.reason,
      });
      // Only the BLOCKED case is audited here. A successful reachability test
      // sends no credential and reaches a public host an admin already
      // configured, so a row per click would be noise. A blocked one means this
      // endpoint was pointed at the VPS's own internals — the single most
      // useful admin-API primitive for mapping an internal network, because it
      // answers reachable/unreachable per target. That is worth keeping with an
      // actor and an IP against it.
      await audit({
        req, action: 'provider.test', targetType: 'provider', targetId: provider.id,
        outcome: 'fail',
        detail: {
          refused: 'unsafe-base-url', reason: safeTest.reason,
          name: provider.name, url: displayUrl(provider.baseUrl),
        },
      });
      return res.status(400).json({
        status: 'fail',
        msg: `That provider's Base URL cannot be tested: ${safeTest.reason}.`,
      });
    }

    const result = await testProviderConnection(provider.baseUrl);

    provider.lastCheckedAt = new Date();
    provider.lastStatus = result.reachable ? 'reachable' : 'unreachable';
    await provider.save();

    return res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('testProvider failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not run test.' });
  }
}

// ---------- Get provider balance (admin only) ----------

/**
 * GET /api/admin/providers/:id/balance
 *
 * Fetches the account credit held with a vendor (Maskawasub/Premiumsub/etc).
 *
 * The endpoint is no longer guessed. It comes from that vendor's `wallet`
 * row — one per vendor, its baseUrl being the balance URL exactly as their
 * docs give it, configured in the same screen as their airtime/data rows.
 * The old `/api/user/` guess remains as a fallback so an install that has
 * not added wallet rows keeps working, but it is the last resort, not the
 * only option: it is what made Maskawasub permanently "Unavailable" with no
 * field anywhere to correct the path.
 *
 * Credentials fall back to a same-named sibling row, because a vendor issues
 * ONE key for all its services. Making the operator paste the same key onto
 * a wallet row too would mean a key rotation silently breaks the balance
 * card while purchases keep working.
 */
export async function getProviderBalance(req, res) {
  try {
    const provider = await Provider.findByPk(req.params.id);
    if (!provider) return res.status(404).json({ status: 'fail', msg: 'Provider not found.' });

    // Same vendor, every category — the wallet URL and any usable key live here.
    const siblings = await Provider.findAll({ where: { name: provider.name } });
    const walletRow = provider.category === 'wallet'
      ? provider
      : siblings.find((s) => s.category === 'wallet');

    const target = resolveBalanceUrl({
      walletUrl: walletRow?.baseUrl,
      // A wallet row's own baseUrl is not its own fallback origin; use a
      // service row for that, since the wallet row may hold a bare path.
      fallbackBaseUrl: siblings.find((s) => s.category !== 'wallet' && s.baseUrl)?.baseUrl
        || (provider.category === 'wallet' ? null : provider.baseUrl),
    });
    if (!target) {
      return res.status(400).json({
        status: 'fail',
        msg: `No balance URL for ${provider.name}. Add a Wallet provider row with `
          + 'the vendor\'s balance endpoint as its Base URL.',
      });
    }

    // ---------- Validate the target BEFORE decrypting anything ----------
    //
    // `target.url` is assembled from a database row an admin typed. The
    // request below attaches this vendor's DECRYPTED API key in an
    // Authorization header, so a baseUrl pointing at an attacker's host is a
    // one-click credential exfiltration, and one pointing at 169.254.169.254
    // or 127.0.0.1 turns this endpoint into a probe for the VPS's own
    // internals. The check sits above `decryptSecret` on purpose: a key we are
    // not going to send should never be brought into memory in plaintext.
    //
    // Not a complete SSRF defence — see utils/ssrfGuard.js on DNS rebinding.
    // The reason is admin-facing because only an admin can cause it and only
    // an admin can fix it; it names the rule broken, never a resolved address.
    const safeTarget = checkOutboundUrl(target.url);
    if (!safeTarget.ok) {
      logger.warn('Blocked provider balance fetch to an unsafe URL', {
        provider: provider.name, source: target.source, reason: safeTarget.reason,
      });
      // Awaited, unlike the success row below. This one is rare and it is the
      // interesting one: something in the database tried to make us send a
      // decrypted vendor key to a place the guard refuses. The file log rotates
      // and is purged under the retention policy; this row does not.
      await audit({
        req, action: 'provider.balance_read', targetType: 'provider', targetId: provider.id,
        outcome: 'fail',
        detail: {
          refused: 'unsafe-balance-url', reason: safeTarget.reason,
          name: provider.name, source: target.source, url: displayUrl(target.url),
        },
      });
      return res.status(400).json({
        status: 'fail',
        msg: `The balance URL saved for ${provider.name} is not allowed: ${safeTarget.reason}. `
          + 'Correct that provider\'s Base URL.',
      });
    }

    // The key may sit on any row for this vendor — prefer the row asked about,
    // then the wallet row, then whichever sibling has one.
    const keyRow = [provider, walletRow, ...siblings].find((r) => r?.apiKey);
    if (!keyRow) {
      return res.status(400).json({
        status: 'fail',
        msg: `No API key saved for ${provider.name}. Add it to any of that provider's rows.`,
      });
    }
    const apiKey = decryptSecret(keyRow.apiKey);

    // ---------- Record the EGRESS, not the outcome ----------
    //
    // This row is written before the fetch and deliberately not on the success
    // path further down, because what is worth recording is "a decrypted vendor
    // credential left this server, bound for that host, at the request of this
    // admin from this IP". Whether the reply parsed is irrelevant to that fact —
    // and a host set up to harvest the key would answer with garbage or hang,
    // which are exactly the branches that never reach the success path. Logging
    // after a 200 would therefore miss every case worth investigating.
    //
    // checkOutboundUrl above stops loopback, private ranges, the metadata
    // address and plain http. It cannot stop a PUBLIC https host that an admin
    // (or someone holding an admin session) typed on purpose. For that case
    // this row is the whole defence: it names the destination, so the key that
    // needs rotating and the URL that needs correcting are both recoverable
    // afterwards. Fire-and-forget because the admin overview fetches one of
    // these per vendor on every page load and must not wait on an insert.
    auditAsync({
      req, action: 'provider.balance_read', targetType: 'provider', targetId: provider.id,
      detail: {
        name: provider.name,
        // Which row's key actually went on the wire — it is not always the row
        // in the URL, and after a rotation "whose key was this" is the question.
        keyFrom: keyRow.category,
        source: target.source,
        url: displayUrl(target.url),
      },
    });

    const response = await fetch(target.url, {
      method: 'GET',
      headers: {
        Authorization: balanceAuthHeader({
          authStyle: keyRow.authStyle, apiKey, baseUrl: target.url,
        }),
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });

    // Read as text first: an error page is far more common than an error
    // status here, and response.json() on HTML throws a parse error that
    // says nothing about the actual cause.
    const body = await response.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      const msg = describeNonJson(body);
      logger.warn('Provider balance response was not JSON', {
        provider: provider.name, url: displayUrl(target.url), source: target.source,
        httpStatus: response.status, bodyStart: body.slice(0, 120),
      });
      return res.status(502).json({ status: 'fail', msg });
    }

    if (!response.ok) {
      logger.warn('Provider balance fetch HTTP error', {
        provider: provider.name, url: displayUrl(target.url), status: response.status,
      });
      return res.status(502).json({
        status: 'fail',
        msg: response.status === 401 || response.status === 403
          ? `Provider rejected the API key (${response.status}). Check the key on the ${provider.name} row.`
          : `Provider returned ${response.status}.`,
      });
    }

    const balance = parseBalance(data);
    if (balance === null) {
      // The response body is the only thing that tells an operator which
      // field to look for, so it goes in the log — vendor balance payloads
      // carry no customer PII.
      logger.warn('Provider balance parse failed', {
        provider: provider.name, url: displayUrl(target.url), source: target.source, response: data,
      });
      return res.status(502).json({
        status: 'fail',
        // Name the URL and the field that changes it, whichever way the URL
        // was arrived at. The seed pre-fills every Wallet row with the common
        // /api/user/ path, so a CONFIGURED row is just as likely to hold a
        // wrong URL as a right one — and the old copy only offered the "check
        // your endpoint" hint when the path had been guessed, which is how
        // this looked like a dead feature the first time round.
        msg: `No balance field in ${provider.name}'s response from ${displayUrl(target.url)}`
          + (target.source === 'guessed'
            ? ' — and that path was assumed, not configured. Add a Wallet row '
              + `for ${provider.name} with their balance endpoint as its Base URL.`
            : `. Check that Base URL on the ${provider.name} Wallet row against `
              + 'their API docs.'),
      });
    }

    return res.json({
      status: 'success',
      data: {
        provider: provider.name,
        balance,
        // Lets the UI mark a card as running on the legacy guess rather than a
        // configured path, which is the difference between "working" and
        // "working by luck".
        source: target.source,
      },
    });
  } catch (err) {
    logger.error('getProviderBalance failed', { error: err.message, stack: err.stack, id: req.params.id });
    const timedOut = /abort|timeout/i.test(err.message || '');
    return res.status(502).json({
      status: 'fail',
      msg: timedOut ? 'Provider did not respond in time.' : 'Could not fetch provider balance.',
    });
  }
}

// ---------- helper ----------

// Guarantee exactly one default provider per category.
// Exported because the payment gateway form (paymentController) writes
// provider rows too, and two places disagreeing about how many defaults
// may exist is how several rows ended up flagged at once.
export async function ensureSingleDefault(category, keepId) {
  const { Op } = await import('sequelize');
  await Provider.update(
    { isDefault: false },
    { where: { category, id: { [Op.ne]: keepId } } }
  );
}
