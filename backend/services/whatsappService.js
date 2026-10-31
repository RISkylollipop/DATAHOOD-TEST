// ============================================================
//  WhatsApp Service — transaction receipts
// ------------------------------------------------------------
//  Provider-agnostic. Supports:
//    - Meta WhatsApp Cloud API (approved templates, one per service)
//    - Termii (Nigerian aggregator, plain text)
//  Which one is active + credentials come from the row the admin
//  fills in under Providers → WhatsApp. Nothing here is hardcoded,
//  and a missing/disabled config fails soft so a receipt never
//  blocks a purchase.
//
//  ======= ONE MONEY FIGURE, AND ONLY ONE =======
//  NO price, balance, discount, profit or wallet total appears in
//  this message. The single permitted figure is `receipt.faceValue`:
//  the FACE VALUE the recipient's line was credited with.
//
//  Why that one is safe when nothing else is. A reseller buys N100
//  of MTN airtime for, say, N97 and sells it on at N100. The N100 is
//  already known to the buyer — they asked for N100 of airtime and
//  they can dial *556# and see it. It discloses nothing. The N97 is
//  the reseller's margin, and that is the number that must never
//  leave the dashboard.
//
//  So the rule is not "no numbers", it is: the figure the BUYER
//  already knows may appear; the figure the RESELLER paid may not.
//
//  This matters because a WhatsApp message is the single most
//  forwardable artifact the platform produces. Forwarding it to the
//  buyer as proof of delivery is not a misuse of the feature, it is
//  why resellers want it. Assume every one of these is read by the
//  customer.
//
//  Two consequences for anyone editing this file:
//
//   1. faceValue must be the amount the buyer REQUESTED, never a
//      computed one. In airtimeController that is `amt`
//      (parseFloat of req.body.amount). It is NOT `amountToPay`
//      (amt * discountPct / 100, the wallet debit) and NOT
//      `buyAmountFromProvider` or `profit`. Those three sit within
//      fifteen lines of each other around airtimeController.js:110
//      and they are all plain numbers, so nothing but the variable
//      name stops the wrong one being passed. Check the name.
//
//   2. DATA receipts pass no faceValue and must keep it that way.
//      A data plan's price is not a denomination the buyer named —
//      "1GB SME" is what they bought — so its price is margin.
//
//  Everything else is still scrubbed: stripMoney() runs over
//  `description` here rather than being trusted to the four callers,
//  because airtime descriptions arrive as "MTN N500" with the figure
//  inside the string, and `amount`/`newBalance` keys are ignored
//  outright even when a caller passes them.
//  ==============================================
//
//  BRANDING: receipts are issued as Noblesmegadata, matching the PNG and
//  the PDF. A customer who gets a WhatsApp receipt saying
//  "KwaraPolyData" and a PDF saying "Noblesmegadata" for the same
//  transaction has reason to think one of them is a scam.
//
//  NOTE: both providers require setup/approval and are paid:
//    - Meta: verified WhatsApp Business number, then a Meta-APPROVED
//      template per service (see TEMPLATES for the exact submitted
//      bodies — the parameter count must match or Meta rejects the
//      send with error 132000, and the language pair must match or it
//      rejects with 132001).
//    - Termii: API key + registered sender ID.
//  Endpoints below cannot be verified from the build environment
//  (outbound network restricted) — confirm on your server.
//
//  ======= WHY TEMPLATES, AND WHY TWO OF THEM =======
//  Meta's template requirement is NOT about formatting. It is about who
//  spoke first. A BUSINESS-INITIATED message must be an approved
//  template; free-form text is only permitted inside the 24-hour
//  customer-service window, which opens when the CUSTOMER messages the
//  business number. A receipt is business-initiated by definition — it
//  is triggered by a purchase, not by a reply — so for a reseller whose
//  customers have never messaged the business number, a template is the
//  only path that works. There is no styling trick around this: WhatsApp
//  renders no HTML at all (a tag prints literally to the recipient), so
//  a prettier message cannot buy an exemption.
//
//  There are TWO templates because airtime and data differ in a way one
//  template cannot absorb: airtime states a money figure the buyer named
//  and can verify, data states a plan description and no figure at all
//  (see the money rule above). One template covering both would have to
//  either print "Amount: ₦" with nothing after it, or leak a plan price.
//
//  Cable TV, electricity and verification have NO template and are
//  skipped — see SERVICE_TEMPLATES. They still produce the PNG/PDF
//  receipt in the dashboard.
//  ==============================================
// ============================================================

import * as logger from '../utils/logger.js';
import { stripMoney } from '../utils/stripMoney.js';

// Node 18+ global fetch.

// ------------------------------------------------------------
//  Provider identity
// ------------------------------------------------------------
//  The controllers build cfg as `{ provider: row.name, ...extraConfig }`,
//  so `provider` is whatever free text the operator typed into the
//  Name box — and providers_table.sql seeds that box with
//  "WhatsApp Receipts". Matching it against the literal 'meta' could
//  never succeed, which is how this feature managed to be fully wired
//  and completely dead at the same time.
//
//  So: normalise, and match on recognisable substrings rather than
//  equality. "Meta", "WhatsApp Cloud API", "Facebook Cloud" and
//  "meta" all mean the same thing to an operator, and should mean the
//  same thing here. An explicit `provider` key in the Extra config
//  JSON still wins, for anyone who wants to be unambiguous.
const DRIVERS = {
  meta: [/\bmeta\b/, /cloud\s*api/, /\bfacebook\b/, /\bgraph\b/],
  termii: [/\btermii\b/],
  off: [/^off$/, /^disabled$/, /^none$/],
};

/**
 * Work out which driver a config means.
 * @returns {'meta'|'termii'|'off'|null} null when nothing matches
 */
export function resolveDriver(rawProvider) {
  const v = String(rawProvider ?? '').trim().toLowerCase();
  if (!v) return null;
  for (const [driver, patterns] of Object.entries(DRIVERS)) {
    if (patterns.some((re) => re.test(v))) return driver;
  }
  return null;
}

/**
 * Second chance when the NAME says nothing useful.
 *
 * The seeded row is called "WhatsApp Receipts", which describes the job
 * rather than the vendor and matches no pattern above — so the feature
 * reported "provider name not recognised" while being otherwise correctly
 * configured. Telling the operator to rename a row they have already
 * filled in is a poor answer when the config itself is unambiguous.
 *
 * The credentials differ in shape, and neither vendor's fields make sense
 * for the other: Meta addresses a phone number ID on the Graph API,
 * Termii sends from a registered alphanumeric sender ID. Either one alone
 * identifies the driver beyond doubt.
 *
 * Returns null when BOTH or NEITHER are present. Guessing between two
 * populated credential sets would silently send through the wrong vendor
 * and fail on the far side, which is harder to diagnose than the warning.
 *
 * @returns {'meta'|'termii'|null}
 */
export function inferDriverFromConfig(cfg) {
  const hasMeta = Boolean(cfg?.phoneNumberId);
  const hasTermii = Boolean(cfg?.senderId);
  if (hasMeta && !hasTermii) return 'meta';
  if (hasTermii && !hasMeta) return 'termii';
  return null;
}

// ------------------------------------------------------------
//  The approved templates
// ------------------------------------------------------------
//  TWO templates, one per service, because they differ in a way no
//  single template can absorb: airtime carries a money figure and data
//  carries a plan description. Both headers read "Transaction Receipt"
//  as STATIC text inside the template — it is not a variable, so it is
//  not sent as a parameter.
//
//  The bodies below are what was submitted to Meta. Keep them in step
//  with each template's `params` array: Meta rejects a count mismatch
//  with error 132000 and an unknown template/language pair with 132001.
export const TEMPLATES = {
  airtime: {
    name: 'Noblesmegadata_receipt_airtime',
    body:
      'Transaction Receipt\n'
      + 'Hi {{customer_name}},\n'
      + 'Your {{service_type}} transaction was successful.\n'
      + 'Transaction Details:\n'
      + 'Network: {{network}}\n'
      + 'Amount: ₦{{amount}}\n'
      + 'Reference: {{transaction_reference}}\n'
      + 'Date: {{transaction_date}}\n'
      + 'Thank you for choosing Noblesmegadata.',
    // Order matters for the POSITIONAL fallback below ({{1}}..{{6}}).
    params: ['customer_name', 'service_type', 'network', 'amount', 'transaction_reference', 'transaction_date'],
  },
  data: {
    name: 'Noblesmegadata_receipt_data',
    body:
      'Transaction Receipt\n'
      + 'Hi {{customer_name}},\n'
      + 'Your {{service_type}} transaction was successful.\n'
      + 'Transaction Details:\n'
      + 'Network: {{network}}\n'
      + 'Value: {{Description}}\n'
      + 'Reference: {{transaction_reference}}\n'
      + 'Date: {{transaction_date}}\n'
      + 'Thank you for choosing Noblesmegadata.',
    // 'Description' is capitalised because that is how the variable was
    // named in Meta's Template Manager, and named parameters must match
    // EXACTLY — a lowercase 'description' is a different variable and the
    // send fails. If the template is ever recreated with a consistent
    // name, this one string is the only edit.
    params: ['customer_name', 'service_type', 'network', 'Description', 'transaction_reference', 'transaction_date'],
  },
};

/**
 * Which template a service uses. NO ENTRY MEANS NO WHATSAPP RECEIPT.
 *
 * Cable TV, Electricity and Verification are deliberately absent: no
 * template has been approved for them, and attempting a send would fail
 * with 132001 on every purchase. They are covered by the PNG/PDF receipt
 * in the dashboard. Adding one later is a single line here plus an entry
 * in TEMPLATES above.
 *
 * Keys are lowercased service names as the controllers pass them.
 */
const SERVICE_TEMPLATES = {
  airtime: 'airtime',
  data: 'data',
};

/**
 * Pick the template kind for a receipt, or '' when the service has none.
 *
 * `cfg.serviceTemplates` lets an operator route an unlisted service onto an
 * existing approved template without a deploy — `{"cable":"data"}` sends
 * cable receipts through the data template. It cannot invent a template, so
 * an unknown target still resolves to no send.
 *
 * A missing face value on an AIRTIME receipt falls back to the data template
 * rather than failing. The airtime template hardcodes "Amount: ₦" ahead of
 * its variable, so a blank amount would either be rejected by Meta as an
 * empty parameter or render as a bare "Amount: ₦" — and the data template is
 * precisely the shape of "a receipt with no money figure". The customer still
 * gets a correct receipt; nothing is invented and nothing is leaked.
 */
export function pickTemplateKind(receipt, cfg = {}) {
  const service = String(receipt?.service || '').trim().toLowerCase();
  const override = cfg?.serviceTemplates?.[service];
  const kind = (override && TEMPLATES[override] ? override : SERVICE_TEMPLATES[service]) || '';
  if (kind === 'airtime' && !formatFaceValueBare(receipt?.faceValue)) return 'data';
  return kind;
}

/**
 * The face value with NO currency symbol.
 *
 * The airtime template already prints "Amount: ₦" ahead of the variable,
 * so sending "₦500" would render "Amount: ₦₦500". Built on formatFaceValue
 * so the rejection rules (0, negatives, NaN, Infinity -> '') stay in one
 * place; only the symbol differs.
 */
export function formatFaceValueBare(v) {
  return formatFaceValue(v).replace('₦', '');
}

/**
 * The network name for the receipt.
 *
 * Controllers pass it explicitly. The fallback exists because the network
 * used to live only INSIDE `description` ("MTN ₦500"), and a receipt that
 * says "Network: " is worse than one that guesses the first word right.
 */
export function networkOf(receipt) {
  const explicit = String(receipt?.network || '').trim();
  if (explicit) return explicit;
  const first = stripMoney(receipt?.description).trim().split(/\s+/)[0] || '';
  return first;
}

/**
 * What was delivered, for the data template's {{Description}}.
 *
 * Strips the network off the front when the description repeats it, so the
 * message reads "Network: MTN / Value: 1GB SME" and not
 * "Network: MTN / Value: MTN 1GB SME". stripMoney still runs: a plan price
 * is margin, not a face value, per the money rule at the top of this file.
 */
export function deliveredValue(receipt) {
  const explicit = String(receipt?.planName || '').trim();
  if (explicit) return stripMoney(explicit).trim();

  let text = stripMoney(receipt?.description).trim();
  const net = networkOf(receipt);
  if (net && text.toLowerCase().startsWith(net.toLowerCase())) {
    text = text.slice(net.length).trim();
  }
  return text || stripMoney(receipt?.description).trim();
}

/**
 * Render a face value for display, or '' if there isn't a usable one.
 *
 * Rejects 0, negatives and non-numbers rather than printing "N0" or
 * "NNaN" on a receipt the customer may well read. Whole denominations
 * print without decimals — "N100", not "N100.00" — because that is how
 * the buyer asked for it.
 */
export function formatFaceValue(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `₦${n.toLocaleString('en-NG', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The one detail string the TERMII receipt carries.
 *
 * Meta does not use this: its templates give the network, the amount and
 * the plan each a variable of their own, and a template variable cannot
 * contain a newline or a tab anyway. Termii sends one plain-text body, so
 * everything has to fit on a line — hence "MTN - Exact Amount: N500".
 *
 * Order matters: stripMoney runs first and removes the price airtime
 * callers bake into the description ("MTN N500" -> "MTN"), and only then
 * is the vetted face value appended. Doing it the other way round would
 * strip the figure straight back out again.
 */
export function buildDetail({ description, faceValue }) {
  const detail = stripMoney(description);
  const fv = formatFaceValue(faceValue);
  if (detail && fv) return `${detail} - Exact Amount: ${fv}`;
  return fv ? `Exact Amount: ${fv}` : detail;
}

/**
 * Build the human-readable receipt text shared by all providers.
 *
 * Takes no wallet amount and no balance. `faceValue` is the sole
 * permitted figure — see the money rule at the top of this file for why
 * that one is safe and the wallet debit is not.
 */
export function buildReceiptText({ name, service, description, ref, date, faceValue }) {
  const detail = buildDetail({ description, faceValue });
  return (
    '✅ *Noblesmegadata Receipt*\n\n'
    + `Hi ${name},\n`
    + `Your ${service} transaction was successful.\n\n`
    + (detail ? `*Details:* ${detail}\n` : '')
    + `*Ref:* ${ref}\n`
    + `*Date:* ${date}\n\n`
    + 'Thank you for choosing Noblesmegadata.'
  );
}

/**
 * The six template values, as [name, value] pairs in template order.
 *
 * Split out of the sender so it can be tested without a network call.
 * That matters more than it looks: buildReceiptText covers only the
 * TERMII path, so while this lived inline the Meta message — the one every
 * operator actually uses — had no test over its money handling at all.
 *
 * Every value is guaranteed non-empty. Meta's Cloud API rejects blank
 * parameters, which turns a cosmetic data problem into a failed send:
 * `name` is built by the callers as `${sFname} ${sLname}` and a profile
 * missing a surname yields a lone space. The fallbacks are deliberately
 * bland — a receipt reading "Hi there" is worth far more to the recipient
 * than no receipt at all.
 *
 * `amount` is the ONE permitted figure and it is sent BARE, because the
 * template supplies the naira sign itself. It can only ever be
 * receipt.faceValue; see the money rule at the top of this file for why
 * amountToPay, buyAmountFromProvider and profit must never appear.
 *
 * (Meta's exact rejection behaviour cannot be confirmed from the build
 * environment — outbound network is blocked — so the non-empty guarantee
 * is written as defence, not as a claim about their validator.)
 */
export function buildTemplateValues(receipt = {}, kind = 'data') {
  const tpl = TEMPLATES[kind] || TEMPLATES.data;
  const service = String(receipt.service || '').trim();
  const name = String(receipt.name || '').trim();
  const ref = String(receipt.ref || '').trim();
  const date = String(receipt.date || '').trim();

  const values = {
    customer_name: name || 'there',
    service_type: service || 'Transaction',
    network: networkOf(receipt) || service || 'Noblesmegadata',
    amount: formatFaceValueBare(receipt.faceValue),
    Description: deliveredValue(receipt) || service || 'Transaction',
    // A receipt with no reference is close to useless, but it is still a
    // successful-purchase notification and the transaction did happen.
    // Send it rather than letting a blank parameter sink the whole message.
    transaction_reference: ref || 'n/a',
    transaction_date: date || 'n/a',
  };

  return tpl.params.map((key) => [key, values[key]]);
}

/**
 * Render those pairs the way Meta wants them.
 *
 * A template is created as either NAMED or POSITIONAL and the two payloads
 * are not interchangeable — send positional parameters to a named template
 * and the whole message is rejected. The templates here were written with
 * `{{customer_name}}` style variables, which is what Meta's Template
 * Manager turns into named parameters, so 'named' is the default. The
 * sender retries in the other style once if Meta complains about
 * parameters, so a wrong guess costs one request rather than every receipt.
 */
export function renderTemplateParameters(pairs, style = 'named') {
  if (style === 'positional') {
    return pairs.map(([, text]) => ({ type: 'text', text }));
  }
  return pairs.map(([parameter_name, text]) => ({ type: 'text', parameter_name, text }));
}


/**
 * Meta's cap on a single template parameter.
 */
const PARAM_MAX = 1024;

/**
 * Codes meaning "these parameters were the wrong shape".
 *
 * 132000 is the count/format mismatch, which is what a NAMED payload sent
 * to a POSITIONAL template (or the reverse) produces. 100 is Graph's
 * generic "invalid parameter" and is included because Meta's named-parameter
 * validator is newer than 132000 and the exact code it returns cannot be
 * confirmed from the build environment (outbound network is blocked).
 *
 * Either one triggers exactly ONE retry in the other style, so including a
 * code too broadly costs a single extra request, never a loop.
 */
const PARAM_SHAPE_CODES = new Set([132000, 100]);

/**
 * The code meaning the recipient cannot receive WhatsApp messages at all.
 *
 * This is the closest thing to a "is this number on WhatsApp?" answer that
 * exists. Meta publishes NO endpoint to check registration before sending:
 * the old on-premise /v1/contacts lookup went away with on-premise itself
 * and was never part of the Cloud API. So the only authoritative answer is
 * to send and read this code back — which is why the caller treats it as a
 * FACT about the number and stops retrying, rather than as a transient
 * failure worth repeating on every future purchase.
 */
const UNREACHABLE_CODE = 131026;

/** An error from the Graph API, carrying Meta's own numeric code. */
export class MetaSendError extends Error {
  constructor(message, metaCode = 0, httpStatus = 0) {
    super(message);
    this.name = 'MetaSendError';
    this.metaCode = metaCode;
    this.httpStatus = httpStatus;
  }
}

/**
 * Did Meta reject this because the parameter shape was wrong?
 *
 * The code is the reliable signal. The prose check is a deliberately narrow
 * safety net: it needs BOTH the word "parameter" AND a rejection word, so an
 * unrelated failure that happens to mention parameters cannot trigger a
 * pointless retry.
 */
export function isParamShapeError(err) {
  if (!err) return false;
  if (PARAM_SHAPE_CODES.has(Number(err.metaCode))) return true;
  const msg = String(err.message || '');
  return /parameter/i.test(msg) && /(does not match|invalid|missing|unexpected|expected)/i.test(msg);
}

/**
 * Did Meta say this recipient is not reachable on WhatsApp?
 *
 * Kept separate from every other failure on purpose. A credential error, a
 * rate limit or an unapproved template are all worth retrying on the next
 * purchase; a number that is not on WhatsApp is not, and retrying it forever
 * means every future receipt for that customer is a wasted request and a
 * misleading error line in the log.
 */
export function isUnreachableError(err) {
  if (!err) return false;
  if (Number(err.metaCode) === UNREACHABLE_CODE) return true;
  const msg = String(err.message || '');
  return /not a valid whatsapp user|undeliverable|receiver is incapable/i.test(msg);
}

/**
 * One POST to the Graph messages endpoint, shared by every send.
 *
 * The credential guards live here rather than in each sender so a new
 * message type cannot be added without them — the missing-phoneNumberId
 * error is the first thing an operator hits, and it should read the same
 * whichever path they configured.
 */
async function postToGraph(cfg, payload) {
  if (!cfg.phoneNumberId) throw new Error('phoneNumberId missing from Extra config');
  if (!cfg.token) throw new Error('Access token missing — paste it into the Secret key field');

  const url = `https://graph.facebook.com/v25.0/${cfg.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...payload,
    }),
    // Receipts are a courtesy notification sent after the purchase has
    // already settled. Nothing depends on the reply, so keep the deadline
    // tight rather than letting a slow Meta API stall the request.
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = Number(data?.error?.code);
    throw new MetaSendError(
      data?.error?.message || `Meta API ${res.status}`,
      Number.isFinite(code) ? code : 0,
      res.status,
    );
  }
  return data;
}

/**
 * The exact JSON body Meta receives, minus the messaging_product wrapper
 * that postToGraph adds.
 *
 * Exported because this is the one artifact worth asserting against: every
 * decision that can fail a send (template name, language pair, parameter
 * style, the bare amount, the money rule) is visible in the returned object,
 * and none of it can be checked by calling the API from here.
 */
export function buildTemplatePayload(toPhone, receipt, kind, cfg = {}, style = 'named') {
  const tpl = TEMPLATES[kind] || TEMPLATES.data;
  const pairs = buildTemplateValues(receipt, kind)
    // Meta caps a parameter at 1024 characters. Only {{Description}} is
    // realistically long enough to reach it, and a clipped plan name still
    // beats a rejected receipt.
    .map(([k, v]) => [k, String(v).slice(0, PARAM_MAX)]);

  return {
    to: toPhone,
    type: 'template',
    template: {
      // Overridable because template names are the operator's to choose in
      // Meta's Template Manager. Renaming one there must not require a deploy.
      name: cfg.templates?.[kind] || tpl.name,
      // en_US, NOT en. Meta treats them as different language pairs and
      // rejects the wrong one with 132001 even when the template exists —
      // an error that reads as "template not found" and sends the operator
      // hunting for a template that is sitting right there, approved.
      language: { code: cfg.templateLang || 'en_US' },
      components: [
        {
          type: 'body',
          parameters: renderTemplateParameters(pairs, style),
        },
      ],
    },
  };
}

/**
 * Send via Meta WhatsApp Cloud API.
 *
 * @returns {Promise<{raw: object, template: string, style: string}>}
 */
async function sendViaMeta(cfg, toPhone, receipt) {
  const kind = pickTemplateKind(receipt, cfg);
  if (!kind) {
    // Not an error, and not a silent drop either. Cable/electricity/
    // verification have no approved template, so a send would fail with
    // 132001 on every single purchase. Skipping is the configured behaviour;
    // saying so in one place is how the next person avoids concluding the
    // feature broke.
    const err = new Error(
      `No approved WhatsApp template for service "${receipt?.service}" — skipped by design. `
      + 'Only airtime and data have one; those services still get the PNG/PDF receipt. '
      + 'To enable more, add an entry to TEMPLATES and SERVICE_TEMPLATES in '
      + 'services/whatsappService.js, or map it onto an existing template with '
      + '{"serviceTemplates":{"cable":"data"}} in the provider\'s Extra config.',
    );
    err.skipped = true;
    throw err;
  }

  // 'named' first: both templates were written with {{customer_name}}-style
  // variables, which is what Meta's Template Manager turns into named
  // parameters. An operator who knows theirs is positional can pin it and
  // skip the wasted first attempt.
  const first = cfg.templateParamStyle === 'positional' ? 'positional' : 'named';
  const second = first === 'named' ? 'positional' : 'named';

  try {
    const raw = await postToGraph(cfg, buildTemplatePayload(toPhone, receipt, kind, cfg, first));
    return { raw, template: kind, style: first };
  } catch (err) {
    if (!isParamShapeError(err)) throw err;

    // The one thing that cannot be determined from this side: whether the
    // APPROVED template declares named or positional variables. Meta's own
    // 132000 does not say which it wanted. Rather than make the operator
    // decode that, try the other shape once and tell them which one worked.
    logger.warn('WhatsApp template rejected the parameter shape — retrying in the other style', {
      ref: receipt?.ref,
      metaCode: err.metaCode,
      tried: first,
      retrying: second,
      hint: `If this succeeds, set {"templateParamStyle":"${second}"} in the WhatsApp `
        + 'provider\'s Extra config so every receipt stops paying for the failed attempt.',
    });

    const raw = await postToGraph(cfg, buildTemplatePayload(toPhone, receipt, kind, cfg, second));
    logger.info('WhatsApp template accepted the retry — pin this style to drop the extra request', {
      ref: receipt?.ref,
      style: second,
    });
    return { raw, template: kind, style: second };
  }
}

/**
 * Send via Termii (plain text WhatsApp message).
 */
async function sendViaTermii(cfg, toPhone, text) {
  if (!cfg.apiKey) throw new Error('API key missing — paste it into the API key field');
  if (!cfg.senderId) throw new Error('senderId missing from Extra config');

  const res = await fetch('https://api.ng.termii.com/api/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: toPhone,
      from: cfg.senderId,
      sms: text,
      type: 'plain',
      channel: 'whatsapp',
      api_key: cfg.apiKey,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Termii API ${res.status}`);
  return data;
}

/**
 * Normalize a Nigerian number to international format (2348012345678).
 */
export function normalizePhone(phone) {
  let p = String(phone ?? '').replace(/\D/g, '');
  if (!p) return '';
  if (p.startsWith('0')) p = '234' + p.slice(1);
  if (p.startsWith('234') === false && p.length === 10) p = '234' + p;
  return p;
}

// ------------------------------------------------------------
//  "Is this number on WhatsApp?"
// ------------------------------------------------------------
//  IT CANNOT BE ANSWERED BEFORE SENDING. Meta publishes no
//  registration-check endpoint on the Cloud API; the on-premise
//  /v1/contacts lookup that used to do this was retired along with
//  on-premise itself. Anything claiming otherwise is a third-party
//  scraper, and pointing customer phone numbers at one of those is a
//  data-protection problem, not a feature.
//
//  So validation here is two-layer and honest about which layer is
//  which:
//
//    1. BEFORE sending — is this even a possible mobile number? A
//       Nigerian MSISDN is 234 + 10 digits beginning 7, 8 or 9. This
//       catches the real defect (a landline, a truncated paste, a
//       digit-count typo in a profile) for free, with no request spent.
//
//    2. AFTER sending — Meta's 131026 is the authoritative answer, and
//       the ONLY one. The caller records it against the account so the
//       question is asked once per number rather than once per purchase.
//
//  A number that is validly formatted but not Nigerian is NOT rejected.
//  WhatsApp is not a Nigerian service and a reseller with a customer or
//  a second line abroad is ordinary; refusing to send would be this
//  code inventing a business rule nobody asked for. It warns and sends.
// ------------------------------------------------------------

/** Nigerian MSISDN: country code, then a mobile prefix, then 10 digits. */
const NG_MSISDN = /^234[789]\d{9}$/;

/**
 * The shortest and longest a real MSISDN can be, per ITU E.164: a national
 * number is at most 15 digits including the country code, and no country
 * assigns anything shorter than 8. Outside that range the value is not a
 * phone number at all, whatever else it might be.
 */
const MIN_MSISDN = 8;
const MAX_MSISDN = 15;

/**
 * Judge a normalized number before spending a request on it.
 *
 * @returns {{ok: boolean, level: 'valid'|'foreign'|'invalid', reason: string}}
 *   ok=false means do not send. level 'foreign' is ok=true with a warning.
 */
export function checkMsisdn(digits) {
  const p = String(digits ?? '');
  if (!p) return { ok: false, level: 'invalid', reason: 'No phone number on the account' };
  if (NG_MSISDN.test(p)) return { ok: true, level: 'valid', reason: '' };

  if (p.startsWith('234')) {
    // Already normalized to Nigeria, so the failure is specific and worth
    // naming: an operator reading "not a valid Nigerian mobile number" can
    // go and look at the profile, where the number is almost certainly a
    // landline (234 1 xxx xxxx) or short by a digit.
    const national = p.slice(3);
    return {
      ok: false,
      level: 'invalid',
      reason: national.length === 10
        ? `Not a Nigerian mobile number: national part starts with ${national[0] || '?'}, expected 7, 8 or 9`
        : `Not a valid Nigerian number: ${national.length} digits after 234, expected 10`,
    };
  }

  if (p.length < MIN_MSISDN || p.length > MAX_MSISDN) {
    return { ok: false, level: 'invalid', reason: `Not a phone number: ${p.length} digits` };
  }

  return { ok: true, level: 'foreign', reason: `Not a Nigerian number (starts ${p.slice(0, 3)}) — sending anyway` };
}

/**
 * Public entry point. `cfg` comes from the admin's Providers → WhatsApp row:
 *   { provider: <row name or extraConfig.provider>, ...credentials }
 *
 * Fails soft — never throws into the purchase flow. It DOES log, which the
 * previous version only promised in a comment: every outcome below returned
 * a plain object, and all four callers discarded it, so a rejected send left
 * no trace anywhere and the feature looked like it had simply never fired.
 *
 * @returns {Promise<{sent: boolean, provider?: string, reason?: string, error?: string}>}
 */
export async function sendWhatsAppReceipt(cfg, receipt) {
  const ref = receipt?.ref;
  try {
    if (!cfg || !cfg.provider) {
      return { sent: false, reason: 'WhatsApp receipts not configured' };
    }

    const named = resolveDriver(cfg.provider);
    if (named === 'off') {
      return { sent: false, reason: 'WhatsApp receipts disabled' };
    }

    // Name first, credential shape second. A descriptive row name is not
    // an error when the credentials say plainly which vendor they are for.
    const driver = named || inferDriverFromConfig(cfg);

    if (!driver) {
      // Still the most likely misconfiguration by a wide margin, so say
      // exactly what to change and where. "Unknown provider" on its own
      // sent the operator looking for a bug in the credentials.
      logger.warn('WhatsApp receipt not sent: cannot tell which WhatsApp provider to use', {
        ref,
        configured: String(cfg.provider),
        // Which half is missing changes the fix, so report both.
        hasMetaFields: Boolean(cfg.phoneNumberId),
        hasTermiiFields: Boolean(cfg.senderId),
        hint: Boolean(cfg.phoneNumberId) && Boolean(cfg.senderId)
          ? 'Extra config has BOTH phoneNumberId (Meta) and senderId (Termii). '
            + 'Remove the unused one, or set {"provider":"meta"} to be explicit.'
          : 'Admin → Providers → WhatsApp: name the row "Meta" or "Termii", '
            + 'or add {"provider":"meta"} to Extra config. Filling in '
            + 'phoneNumberId (Meta) or senderId (Termii) is also enough.',
      });
      return { sent: false, reason: `Unrecognised WhatsApp provider: ${cfg.provider}` };
    }

    if (!named) {
      // Worth a line: the row name and the actual behaviour differ, and an
      // operator debugging a wrong-vendor send needs to know we guessed.
      logger.info('WhatsApp driver inferred from credentials, not the row name', {
        ref, configured: String(cfg.provider), driver,
      });
    }

    const toPhone = normalizePhone(receipt?.phone);
    const check = checkMsisdn(toPhone);
    if (!check.ok) {
      // The number itself is never logged — it is personal data and the log
      // is the wrong place to accumulate it. The REASON is logged, because
      // that is the part an operator can act on, and it identifies the
      // defect without identifying the person.
      logger.warn('WhatsApp receipt not sent: phone number failed validation', {
        ref, reason: check.reason,
      });
      return { sent: false, reason: check.reason, invalidPhone: true };
    }
    if (check.level === 'foreign') {
      logger.info('WhatsApp receipt going to a non-Nigerian number', { ref, reason: check.reason });
    }

    if (driver === 'meta') {
      const { raw, template, style } = await sendViaMeta(cfg, toPhone, receipt);
      // Both fields are logged because neither can be inferred from anywhere
      // else: `template` shows which of the two approved bodies went out
      // (including the airtime→data fallback, i.e. "the face value was
      // unusable"), and `style` shows whether the named payload worked or the
      // positional retry saved it — the one thing worth pinning in config.
      logger.info('WhatsApp receipt sent', { ref, provider: 'meta', template, style });
      return { sent: true, provider: 'meta', template, style, raw };
    }

    const raw = await sendViaTermii(cfg, toPhone, buildReceiptText(receipt));
    logger.info('WhatsApp receipt sent', { ref, provider: 'termii' });
    return { sent: true, provider: 'termii', raw };
  } catch (err) {
    const provider = resolveDriver(cfg?.provider) || String(cfg?.provider ?? '');

    // A skipped service is a configuration outcome, not a failure. Logging it
    // at error level would put a red line in the log on every cable purchase
    // and train whoever reads it to ignore the file.
    if (err?.skipped) {
      logger.info('WhatsApp receipt skipped', { ref, provider, reason: err.message });
      return { sent: false, skipped: true, reason: err.message };
    }

    // Surfaced separately so the caller can record it against the account and
    // stop asking. Everything else here is worth retrying on the next
    // purchase; this one is a fact about the number.
    if (isUnreachableError(err)) {
      logger.warn('WhatsApp receipt undeliverable: recipient is not on WhatsApp', {
        ref, provider, metaCode: err.metaCode,
      });
      return { sent: false, unreachable: true, reason: 'Recipient is not reachable on WhatsApp' };
    }

    // Never block the transaction — but never swallow it either. `thrownAt`
    // needs the stack: without it the log records where the catch is (this
    // line, forever) instead of which of the calls above actually failed.
    logger.error('WhatsApp receipt send failed', {
      ref,
      provider,
      metaCode: err?.metaCode,
      error: err.message,
      stack: err.stack,
    });
    return { sent: false, error: err.message };
  }
}
