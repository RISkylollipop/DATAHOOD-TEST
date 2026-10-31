// ============================================================
//  Provider Service — VTU fulfillment adapter
// ------------------------------------------------------------
//  Faithfully mirrors the request/response contract the legacy
//  PHP used (Airtime.php, InternetData.php). Endpoints and keys
//  are NOT hardcoded — they are read from the `apiconfigs` table
//  so the admin panel controls them.
//
//  IMPORTANT: These endpoints cannot be verified from the build
//  environment (outbound network is restricted). Use the
//  `testProviderConnection` helper on your own server to confirm
//  a provider responds before relying on it in production.
//
//  ---------------------------------------------------------------
//  RESULT CONTRACT — which fields may reach a user
//  ---------------------------------------------------------------
//  Every helper here resolves to a result object. Of its fields,
//  `msg`, `error`, `cause` and `raw` are OPERATOR-ONLY: they carry
//  provider wording, our diagnostics, hostnames and raw payloads.
//  Pass them to the file logger and nothing else.
//
//  Callers translate `reason` into customer copy via
//  utils/publicErrors.js. Never write `msg` into a response body —
//  that is how "your server IP is likely not whitelisted with this
//  provider" ended up in a user's toast: an internal hint telling
//  the user to fix infrastructure they do not own, while naming our
//  upstream supplier. `reason` is the stable, safe field; it is a
//  fixed vocabulary we control, so mapping it cannot leak text.
// ============================================================

// Uses Node 18+ global fetch (no axios, no node-fetch package).

// ------------------------------------------------------------
//  Outbound timeouts
// ------------------------------------------------------------
//  Without a timeout an unresponsive provider holds the socket —
//  and the Express request behind it — open indefinitely. Under
//  load that exhausts the connection pool and takes the whole
//  site down, so every outbound call below is bounded.
//
//  The budgets are deliberately asymmetric:
//
//   * PURCHASE is generous (45s). Aborting a purchase early does
//     NOT cancel it at the provider — the bundle may still be
//     delivered. That leaves an unknown-delivery transaction that
//     an admin has to reconcile by hand, which costs far more than
//     waiting. We only give up once it is clear nothing is coming.
//
//   * VERIFY is short (20s). Nothing is charged and no state is
//     created, so failing fast is free and the customer gets to
//     retry instead of watching a spinner.
//
//   * AUTH is short (15s). It runs BEFORE the purchase is sent, so
//     a timeout here means nothing was ordered — cheap to abort.
//
//   * PING is shortest (10s). It only answers "is this host up?"
//     for the admin panel.
const TIMEOUTS = {
  purchase: 45_000,
  verify: 20_000,
  auth: 15_000,
  ping: 10_000,
};

/**
 * fetch() with a hard deadline.
 *
 * AbortSignal.timeout() rejects with a DOMException named 'TimeoutError'.
 * That name is what callers use to distinguish "the provider never answered"
 * from "DNS/TLS/connection refused" — a critical difference, because a real
 * connection error proves the request never landed (safe to refund), while a
 * timeout means it may well have (must NOT auto-refund).
 *
 * @param {string} url
 * @param {object} options standard fetch options
 * @param {number} ms deadline in milliseconds
 */
async function fetchWithTimeout(url, options = {}, ms = TIMEOUTS.purchase) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
}

/**
 * Classify a thrown fetch error into the `reason` codes the controllers
 * branch on when deciding whether a refund is safe.
 *
 *   'timeout'       — no response within the deadline.
 *   'network-error' — DNS failure, refused connection, TLS error, or a
 *                     socket dropped mid-response.
 *
 * Both mean delivery is UNKNOWN, so neither is safe to auto-refund. It is
 * tempting to treat a connection error as proof the order never landed, but
 * fetch also throws this way when the socket dies while reading the response
 * — by which point the provider has already fulfilled the request. Only an
 * explicit 'failed' from the provider is authoritative enough to refund on;
 * everything else stays status=5 for reconciliation.
 */
function classifyFetchError(err) {
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return {
    reason: timedOut ? 'timeout' : 'network-error',
    msg: timedOut
      ? 'The network provider did not respond in time. Please check your transaction history before retrying.'
      : 'Server Connection Error',
    error: err?.message,
    cause: err?.cause ? String(err.cause?.message || err.cause) : undefined,
  };
}


/**
 * Detect which auth style a provider host uses.
 * Matches the branching logic in the old PHP.
 */
function detectAuthStyle(host) {
  if (host.includes('n3tdata')) {
    return { style: 'basic', userUrl: 'https://n3tdata.com/api/user/' };
  }
  if (host.includes('bilalsadasub')) {
    return { style: 'basic', userUrl: 'https://bilalsadasub.com/api/user/' };
  }
  return { style: 'token', userUrl: null };
}

/**
 * For basic-auth providers: exchange the Basic key for a short-lived AccessToken.
 */
async function getAccessToken(userUrl, apiKey) {
  const res = await fetchWithTimeout(userUrl, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${apiKey}`,
      'Content-Type': 'application/json',
    },
  }, TIMEOUTS.auth);
  if (!res.ok) throw new Error(`Provider auth failed (${res.status})`);
  const data = await res.json();
  return data.AccessToken;
}

/**
 * Safely parse a provider's HTTP response. VTU providers frequently return an
 * HTML/text page (e.g. "Access denied" when the calling server's IP is NOT
 * whitelisted, a Cloudflare challenge, or a 403/404 page) instead of JSON.
 * res.json() throws on that, which callers would otherwise mislabel as a
 * generic "Server Connection Error". This surfaces the true reason.
 * @returns {{ok:true, data:any} | {ok:false, msg:string, detail:string}}
 */
async function parseJsonSafe(res) {
  const text = await res.text();
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160);
    const blocked = /access denied|forbidden|not authoriz|whitelist|cloudflare|<html/i.test(text);
    const msg = blocked
      ? 'Provider blocked the request — your server IP is likely not whitelisted with this provider.'
      : `Provider returned an unexpected (non-JSON) response (HTTP ${res.status}).`;
    return { ok: false, msg, detail: `HTTP ${res.status}: ${snippet}` };
  }
}

/**
 * Purchase airtime through the configured provider.
 * @param {object} opts { host, apiKey, networkId, amount, phone, ref, airtimeType, portedNumber }
 * @returns {Promise<{status:'success'|'fail', msg?:string, raw?:any}>}
 */
export async function purchaseAirtime(opts) {
  const { host, apiKey, networkId, amount, phone, ref, airtimeType, portedNumber = false } = opts;
  const { style, userUrl } = detectAuthStyle(host);

  try {
    if (style === 'basic') {
      const accessToken = await getAccessToken(userUrl, apiKey);
      const res = await fetchWithTimeout(host, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Token ${accessToken}` },
        body: JSON.stringify({
          network: String(networkId),
          amount: String(amount),
          phone: String(phone),
          bypass: Boolean(portedNumber),
          'request-id': String(ref),
          plan_type: airtimeType,
        }),
      }, TIMEOUTS.purchase);
      const parsed = await parseJsonSafe(res);
      if (!parsed.ok) return { status: 'fail', msg: parsed.msg, error: parsed.detail, reason: 'non-json' };
      const result = parsed.data;
      if (result.status === 'successful' || result.status === 'success') {
        return { status: 'success', raw: result };
      }
      if (result.status === 'failed') {
        return { status: 'fail', msg: 'Network Error, Please Try Again Later', raw: result, reason: 'explicit-fail' };
      }
      return { status: 'fail', msg: 'Server/Network Error', raw: result, reason: 'unknown-status' };
    }

    // Token style (Maskawasub / Premiumsub default)
    const res = await fetchWithTimeout(host, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${apiKey}` },
      body: JSON.stringify({
        network: String(networkId),
        amount: String(amount),
        mobile_number: String(phone),
        Ported_number: Boolean(portedNumber),
        'request-id': String(ref),
        airtime_type: airtimeType,
      }),
    }, TIMEOUTS.purchase);
    const parsed = await parseJsonSafe(res);
    if (!parsed.ok) return { status: 'fail', msg: parsed.msg, error: parsed.detail, reason: 'non-json' };
    const result = parsed.data;
    if (result.Status === 'successful' || result.Status === 'processing') {
      return { status: 'success', raw: result };
    }
    if (result.Status === 'failed') {
      return { status: 'fail', msg: 'Network Error, Please Try Again Later', raw: result, reason: 'explicit-fail' };
    }
    return { status: 'fail', msg: 'Server/Network Error', raw: result, reason: 'unknown-status' };
  } catch (err) {
    return { status: 'fail', ...classifyFetchError(err) };
  }
}

/**
 * Purchase a data bundle through the configured provider.
 */
export async function purchaseData(opts) {
  const { host, apiKey, networkId, phone, ref, planId, portedNumber = false } = opts;
  const { style, userUrl } = detectAuthStyle(host);

  try {
    let token = apiKey;
    if (style === 'basic') token = await getAccessToken(userUrl, apiKey);

    const res = await fetchWithTimeout(host, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}` },
      body: JSON.stringify({
        network: String(networkId),
        mobile_number: String(phone),
        Ported_number: Boolean(portedNumber),
        'request-id': String(ref),
        plan: String(planId),
      }),
    }, TIMEOUTS.purchase);
    const parsed = await parseJsonSafe(res);
    if (!parsed.ok) return { status: 'fail', msg: parsed.msg, error: parsed.detail, reason: 'non-json' };
    const result = parsed.data;
    const flag = result.Status ?? result.status;
    if (flag === 'successful' || flag === 'processing') {
      return { status: 'success', raw: result };
    }
    if (flag === 'failed') {
      return { status: 'fail', msg: 'Network Error, Please Try Again Later', raw: result, reason: 'explicit-fail' };
    }
    return { status: 'fail', msg: 'Server/Network Error', raw: result, reason: 'unknown-status' };
  } catch (err) {
    return { status: 'fail', ...classifyFetchError(err) };
  }
}

/**
 * Verify an electricity meter number before purchase.
 * @param {object} opts { host, apiKey, provider, meterNumber, meterType }
 * @returns {Promise<{status, msg?, customerName?, raw?}>}
 */
export async function verifyMeter(opts) {
  const { host, apiKey, provider, meterNumber, meterType } = opts;
  try {
    const res = await fetchWithTimeout(host, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${apiKey}` },
      body: JSON.stringify({
        disco_name: String(provider),
        meter_number: String(meterNumber),
        MeterType: String(meterType),
      }),
    }, TIMEOUTS.verify);
    const parsed = await parseJsonSafe(res);
    if (!parsed.ok) return { status: 'fail', msg: parsed.msg, error: parsed.detail, reason: 'non-json' };
    const result = parsed.data;
    const name = result.name || result.customerName || result.customer_name || null;
    if (name || result.invalid === false || result.Status === 'success') {
      return { status: 'success', customerName: name, raw: result };
    }
    return { status: 'fail', msg: result.msg || 'Could not verify meter number', raw: result, reason: 'unknown-status' };
  } catch (err) {
    return { status: 'fail', ...classifyFetchError(err) };
  }
}

/**
 * Purchase an electricity token through the configured provider.
 * @param {object} opts { host, apiKey, provider, meterNumber, meterType, phone, amount, ref }
 */
export async function purchaseElectricity(opts) {
  const { host, apiKey, provider, meterNumber, meterType, phone, amount, ref } = opts;
  try {
    const res = await fetchWithTimeout(host, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${apiKey}` },
      body: JSON.stringify({
        disco_name: String(provider),
        amount: String(amount),
        meter_number: String(meterNumber),
        MeterType: String(meterType),
        phone: String(phone),
        'request-id': String(ref),
      }),
    }, TIMEOUTS.purchase);
    const parsed = await parseJsonSafe(res);
    if (!parsed.ok) return { status: 'fail', msg: parsed.msg, error: parsed.detail, reason: 'non-json' };
    const result = parsed.data;
    const flag = result.Status ?? result.status;
    if (flag === 'successful' || flag === 'success' || flag === 'processing') {
      // token is what the customer needs for prepaid meters
      const token = result.token || result.Token || result.purchased_code || null;
      return { status: 'success', token, raw: result };
    }
    if (flag === 'failed') {
      return { status: 'fail', msg: result.msg || 'Network Error, Please Try Again Later', raw: result, reason: 'explicit-fail' };
    }
    return { status: 'fail', msg: result.msg || 'Server/Network Error', raw: result, reason: 'unknown-status' };
  } catch (err) {
    return { status: 'fail', ...classifyFetchError(err) };
  }
}

/**
 * Verify a cable TV IUC/smartcard number before purchase.
 * @param {object} opts { host, apiKey, provider, iucNumber }
 */
export async function verifyIUC(opts) {
  const { host, apiKey, provider, iucNumber } = opts;
  try {
    const res = await fetchWithTimeout(host, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${apiKey}` },
      body: JSON.stringify({
        cablename: String(provider),
        smart_card_number: String(iucNumber),
      }),
    }, TIMEOUTS.verify);
    const parsed = await parseJsonSafe(res);
    if (!parsed.ok) return { status: 'fail', msg: parsed.msg, error: parsed.detail, reason: 'non-json' };
    const result = parsed.data;
    const name = result.name || result.customerName || result.customer_name || null;
    if (name || result.Status === 'success' || result.invalid === false) {
      return { status: 'success', customerName: name, raw: result };
    }
    return { status: 'fail', msg: result.msg || 'Could not verify IUC number', raw: result, reason: 'unknown-status' };
  } catch (err) {
    return { status: 'fail', ...classifyFetchError(err) };
  }
}

/**
 * Purchase a cable TV subscription through the configured provider.
 * @param {object} opts { host, apiKey, provider, iucNumber, planId, phone, ref, subType }
 */
export async function purchaseCable(opts) {
  const { host, apiKey, provider, iucNumber, planId, phone, ref, subType } = opts;
  try {
    const res = await fetchWithTimeout(host, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${apiKey}` },
      body: JSON.stringify({
        cablename: String(provider),
        cableplan: String(planId),
        smart_card_number: String(iucNumber),
        phone: String(phone),
        subtype: subType || 'change',
        'request-id': String(ref),
      }),
    }, TIMEOUTS.purchase);
    const parsed = await parseJsonSafe(res);
    if (!parsed.ok) return { status: 'fail', msg: parsed.msg, error: parsed.detail, reason: 'non-json' };
    const result = parsed.data;
    const flag = result.Status ?? result.status;
    if (flag === 'successful' || flag === 'success' || flag === 'processing') {
      return { status: 'success', raw: result };
    }
    if (flag === 'failed') {
      return { status: 'fail', msg: result.msg || 'Network Error, Please Try Again Later', raw: result, reason: 'explicit-fail' };
    }
    return { status: 'fail', msg: result.msg || 'Server/Network Error', raw: result, reason: 'unknown-status' };
  } catch (err) {
    return { status: 'fail', ...classifyFetchError(err) };
  }
}

/**
 * Lightweight reachability check for the admin "Test connection" button.
 * Run this ON YOUR SERVER — it needs real outbound network access.
 */
export async function testProviderConnection(host) {
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(host, { method: 'GET' }, TIMEOUTS.ping);
    return {
      reachable: true,
      httpStatus: res.status,
      ms: Date.now() - started,
      note: 'Host responded. A 4xx/405 is normal for a GET on a POST-only endpoint — it still proves reachability.',
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      reachable: false,
      error: timedOut ? `No response within ${TIMEOUTS.ping / 1000}s` : err.message,
      timedOut,
      ms: Date.now() - started,
    };
  }
}
