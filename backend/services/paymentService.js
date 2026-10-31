// ============================================================
//  Payment Service — pluggable gateway adapter
// ------------------------------------------------------------
//  Supports multiple payment gateways behind one interface so
//  new ones can be added WITHOUT touching the purchase/wallet
//  code. Each gateway is a small adapter with the same shape.
//
//  Currently wired: Monnify, Paymentpoint, Palmpay.
//  To add a new gateway later: write one adapter object and
//  register it in the `gateways` map. The admin panel stores
//  each gateway's credentials (contract code, API key, secret)
//  in the DB — nothing hardcoded here.
//
//  NOTE: Endpoints below reflect each provider's public API but
//  cannot be verified from the build environment (outbound
//  network restricted). Confirm on your live server.
// ============================================================

// Node 18+ global fetch.
import * as logger from '../utils/logger.js';

// ------------------------------------------------------------
//  Outbound timeouts
// ------------------------------------------------------------
//  An unresponsive gateway must never hold an Express request open
//  indefinitely — under load that exhausts the connection pool and
//  takes the whole site down. Every call below is bounded.
//
//  Account creation is idempotent from our side (we pass a unique
//  accountReference), so a timeout is safe to surface as an error:
//  the user simply retries, and a duplicate reference is rejected
//  by the gateway rather than creating a second account.
const GATEWAY_TIMEOUT_MS = 30_000;
const GATEWAY_AUTH_TIMEOUT_MS = 15_000;

async function gwFetch(url, options = {}, ms = GATEWAY_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`Payment gateway did not respond within ${ms / 1000}s. Please try again.`);
    }
    throw err;
  }
}

// ------------------------------------------------------------
//  BVN handling
// ------------------------------------------------------------
//  A BVN is PASSED THROUGH to the gateway and never persisted or
//  logged. There is no BVN column on `subscribers`, by design — the
//  legacy funding page promised users "we do not have access to your
//  BVN nor do we store it on our SERVERS", and holding one would put
//  the platform inside a compliance regime it has no need to enter.
//  `sKYC`/`sKycDate`/`sKycType` record only THAT an identity was accepted,
//  when, and whether it was a BVN or a NIN — never the number itself.
//
//  Whether a BVN is required is a property of the MERCHANT CONTRACT,
//  not of the gateway software: two Monnify contracts can differ. So
//  `needsBvn` here is only a DEFAULT — the admin can override it per
//  gateway, and resolveNeedsBvn() below is the single source of truth.
//  Hardcoding it was how the funding page came to ask for a BVN on the
//  wrong gateways.
//
//  Never substitute a placeholder BVN for a missing one. The legacy PHP
//  did exactly that (a real 11-digit BVN sat in Account.php), which
//  silently attached every such account to one stranger's identity.
function digitsOnly(v) {
  return String(v ?? '').replace(/\D/g, '');
}

/**
 * Resolve whether this gateway needs a BVN, admin override winning.
 * @param {object} adapter  gateway adapter
 * @param {object} extraConfig  parsed Provider.extraConfig
 */
export function resolveNeedsBvn(adapter, extraConfig = {}) {
  const override = extraConfig?.requireBvn;
  if (override === true || override === 'true' || override === 1 || override === '1') return true;
  if (override === false || override === 'false' || override === 0 || override === '0') return false;
  return adapter?.needsBvn === true;
}

// ---------- Monnify ----------
const monnify = {
  name: 'Monnify',
  // Reserving an account against a verified identity (BVN or NIN) is now
  // the norm across Nigerian collection gateways, not a per-contract
  // extra: NIBSS/NIMC must be able to match the number to a real person
  // before a permanent account is issued. Default ON.
  //
  // The admin can still switch it off per gateway via `requireBvn` in
  // extraConfig for a legacy contract that reserves from the contract
  // code alone — resolveNeedsBvn() remains the single source of truth.
  needsBvn: true,
  // Fields the admin must fill in the UI:
  requiredConfig: ['apiKey', 'secretKey', 'contractCode', 'baseUrl'],

  async getToken(cfg) {
    const auth = Buffer.from(`${cfg.apiKey}:${cfg.secretKey}`).toString('base64');
    const res = await gwFetch(`${cfg.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
    }, GATEWAY_AUTH_TIMEOUT_MS);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.responseMessage || 'Monnify auth failed');
    return data.responseBody.accessToken;
  },

  async createVirtualAccount(cfg, {
    customerName, customerEmail, accountReference, identity,
  }) {
    const token = await this.getToken(cfg);
    const id = identity || {};
    const clean = digitsOnly(id.idNumber);

    // ONE request yields SEVERAL account numbers, one per partner bank
    // (Wema, Sterling, Moniepoint...). That is what `getAllAvailableBanks`
    // does, and Monnify returns them in responseBody.accounts. Do NOT loop
    // and call this three times to get three banks: each call reserves a
    // SEPARATE account against the same identity, burning the customer's
    // reservation quota and leaving orphaned accounts that still accept
    // money nobody is reconciling. The caller persists every entry of the
    // returned array — see paymentController.createAccountHandler.
    const res = await gwFetch(`${cfg.baseUrl}/api/v2/bank-transfer/reserved-accounts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountReference,
        accountName: customerName,
        currencyCode: 'NGN',
        contractCode: cfg.contractCode,
        customerEmail,
        customerName,
        // BVN and NIN are separate fields — both 11 digits, so the type
        // can never be inferred from the value. Sending a NIN in `bvn`
        // fails the NIBSS match and returns as "invalid BVN", which reads
        // like the number is wrong when only the field was.
        //
        // The key is OMITTED rather than sent empty: Monnify validates
        // format whenever the field is present, so `"bvn": ""` is
        // rejected where an absent key is accepted.
        ...(clean && id.idType === 'nin' ? { nin: clean } : {}),
        ...(clean && id.idType !== 'nin' ? { bvn: clean } : {}),
        getAllAvailableBanks: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.responseMessage || 'Monnify VA creation failed');
    return data.responseBody;
  },

  // Monnify signs webhooks with your secret; verify HMAC SHA512.
  verifyWebhook(cfg, signature, rawBody) {
    // Implemented in the webhook route with crypto — placeholder marker here.
    return { provider: 'monnify', needsHmacVerify: true };
  },
};

// ---------- Paymentpoint ----------
const paymentpoint = {
  name: 'Paymentpoint',
  needsBvn: true,
  requiredConfig: ['apiKey', 'secretKey', 'businessId', 'baseUrl'],

  async createVirtualAccount(cfg, {
    customerName, customerEmail, accountReference, phone, identity,
  }) {
    const id = identity || {};
    const clean = digitsOnly(id.idNumber);
    const res = await gwFetch(`${cfg.baseUrl}/api/v1/createVirtualAccount`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'api-key': cfg.secretKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: customerEmail,
        name: customerName,
        // The KYC phone when we have one: this is matched against the
        // identity record, not used to contact the customer, so the
        // profile's login number is the wrong value if they differ.
        phoneNumber: id.phone || phone,
        ...(id.firstName ? { firstName: id.firstName } : {}),
        ...(id.lastName ? { lastName: id.lastName } : {}),
        bankType: 'all',
        businessId: cfg.businessId,
        accountReference,
        ...(clean && id.idType === 'nin' ? { nin: clean } : {}),
        ...(clean && id.idType !== 'nin' ? { bvn: clean } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || 'Paymentpoint VA creation failed');
    return data;
  },

  verifyWebhook(cfg, signature, rawBody) {
    return { provider: 'paymentpoint', needsHmacVerify: true };
  },
};

// ---------- Palmpay ----------
const palmpay = {
  name: 'Palmpay',
  needsBvn: true,
  requiredConfig: ['appId', 'merchantId', 'privateKey', 'publicKey', 'baseUrl'],

  async createVirtualAccount(cfg, {
    customerName, customerEmail, accountReference, phone, identity,
  }) {
    const id = identity || {};
    const clean = digitsOnly(id.idNumber);
    // Palmpay uses RSA-signed requests; signing handled in a helper on your server.
    const res = await gwFetch(`${cfg.baseUrl}/api/v2/virtual/account/label/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.appId}`,
        'Content-Type': 'application/json',
        // 'Signature': <RSA signature built from sorted params + privateKey>
      },
      body: JSON.stringify({
        requestTime: Date.now(),
        version: 'V2.0',
        nonceStr: accountReference,
        // The identity name when supplied — Palmpay matches the account
        // name against the BVN/NIN record, so the profile name is only a
        // fallback for a contract that does not require an identity.
        virtualAccountName: id.fullName || customerName,
        identityType: 'personal',
        licenseNumber: accountReference,
        customerName: id.fullName || customerName,
        ...(id.firstName ? { firstName: id.firstName } : {}),
        ...(id.lastName ? { lastName: id.lastName } : {}),
        email: customerEmail,
        phone: id.phone || phone,
        ...(clean && id.idType === 'nin' ? { nin: clean } : {}),
        ...(clean && id.idType !== 'nin' ? { bvn: clean } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.respMsg || 'Palmpay VA creation failed');
    return data;
  },

  verifyWebhook(cfg, signature, rawBody) {
    return { provider: 'palmpay', needsRsaVerify: true };
  },
};

// ---------- Registry ----------
// Add a new gateway later by dropping an adapter here.
const gateways = {
  monnify,
  paymentpoint,
  palmpay,
};

/**
 * List gateway definitions (for the admin UI to render config fields).
 */
export function listGateways() {
  return Object.entries(gateways).map(([key, g]) => ({
    key,
    name: g.name,
    requiredConfig: g.requiredConfig,
    // The DEFAULT only. The admin's `requireBvn` in extraConfig overrides
    // it — resolveNeedsBvn() is the source of truth. Surfaced so the
    // gateway form can show which way the switch currently falls.
    needsBvn: g.needsBvn === true,
  }));
}

/**
 * Get an adapter by key. Throws if unknown.
 */
export function getGateway(key) {
  const g = gateways[key?.toLowerCase()];
  if (!g) throw new Error(`Unknown payment gateway: ${key}`);
  return g;
}

/**
 * Create a virtual account through whichever gateway is active for this user.
 */
export async function createVirtualAccount(gatewayKey, cfg, customer) {
  try {
    const gateway = getGateway(gatewayKey);
    return await gateway.createVirtualAccount(cfg, customer);
  } catch (err) {
    // `customer` carries a full identity block now — BVN/NIN, the name on
    // the bank record and the registered phone. Log the gateway and the
    // message ONLY. Never the customer object, never a field-by-field
    // spread that a later edit could quietly widen, and never `identity`
    // even partially: a "just the last 4" convenience here becomes a
    // permanent partial-BVN trail in the log files.
    logger.error('Virtual account creation failed', { gateway: gatewayKey, error: err.message, stack: err.stack });
    throw err;
  }
}
