// ============================================================
//  Site Settings Controller — the single `sitesettings` row (sId = 1)
// ------------------------------------------------------------
//  Scope, deliberately narrow: the fields a customer SEES. Site identity,
//  the contact channels, the social links, and the manual-funding bank
//  details. Every one of them is a string that gets rendered somewhere and
//  nothing here participates in a calculation.
//
//  What is intentionally NOT editable here, so a later reader does not
//  mistake the omission for an oversight:
//
//    referal*bonus, wallettowalletcharges, electricitycharges,
//    airtimemin/airtimemax, agentupgrade/vendorupgrade
//
//  Those are money levers. A typo in `phone` is embarrassing; a typo in
//  `referalwalletbonus` pays every referrer the wrong amount on every
//  transaction until someone notices. They belong on their own screen with
//  their own confirmation step, not in a form whose muscle memory is
//  "fix the WhatsApp number and hit save".
//
//    logindesign, homedesign
//
//  Legacy theme selectors. The old admin's website-style.php offered five
//  numbered login layouts and five numbered home layouts, picked from a
//  scrolling strip of screenshots. The React frontend has exactly one of
//  each, so those numbers now select nothing. Exposing a control that
//  changes nothing is worse than exposing none, and the honest fix is to
//  build alternate layouts before offering to choose between them.
//
//  `sitecolor` IS editable — see below. It was in this exclusion list too,
//  on the same reasoning, but that reasoning was wrong: the column was
//  already being served by GET /settings/public, so the value was reaching
//  the browser and simply going unread. A stored brand colour that nothing
//  applies is not a missing feature, it is a broken one.
// ============================================================

import { SiteSettings } from '../models/index.js';
import * as logger from '../utils/logger.js';
import { handleSchemaDrift } from '../utils/dbErrors.js';

// ------------------------------------------------------------
//  Field definitions
// ------------------------------------------------------------
//  `max` MUST match the column width in models/SiteSettings.js. MySQL in
//  its default non-strict mode truncates an over-long value and returns
//  success, which is exactly how the legacy admin lost Facebook links for
//  years: the form said "Facebook Link", the column was VARCHAR(10), and
//  every save quietly stored "https://fa". Validating here turns that into
//  a visible error; the post-save diff below catches the cases this misses.
const FIELDS = {
  // ---- identity ----
  sitename: { max: 20, label: 'Site name' },
  siteurl: { max: 100, label: 'Site URL', kind: 'url' },
  apidocumentation: { max: 100, label: 'API documentation URL', kind: 'url' },

  // ---- contact ----
  phone: { max: 30, label: 'Phone', kind: 'phone' },
  email: { max: 120, label: 'Email', kind: 'email' },
  whatsapp: { max: 30, label: 'WhatsApp number', kind: 'phone' },
  whatsappgroup: { max: 255, label: 'WhatsApp group link', kind: 'link' },
  supporthours: { max: 120, label: 'Support hours' },

  // ---- social ----
  //  These accept a bare handle OR a full URL, because that is what
  //  useSiteSettings.asUrl() already normalises on the way out. Forcing
  //  "https://" here would reject a value the frontend handles correctly
  //  and that the operator reasonably typed.
  facebook: { max: 200, label: 'Facebook', kind: 'link' },
  twitter: { max: 200, label: 'X (Twitter)', kind: 'link' },
  instagram: { max: 200, label: 'Instagram', kind: 'link' },
  telegram: { max: 200, label: 'Telegram', kind: 'link' },

  // ---- manual funding ----
  accountname: { max: 50, label: 'Account name' },
  accountno: { max: 15, label: 'Account number', kind: 'digits' },
  bankname: { max: 20, label: 'Bank name' },

  // ---- appearance ----
  //  The default brand theme for anyone who has not picked one: every
  //  first-time visitor, the signed-out pages, and the login screen.
  //  Stored as a theme id, not the legacy hex. The old column held
  //  '#0000e6' and the old admin rendered <input type="color">, but a free
  //  hex cannot drive this frontend — the palette is four audited
  //  light/dark pairs in frontend/src/config.jsx, and an arbitrary colour
  //  would land unreadable text on half of them. A picker that can only
  //  produce valid combinations is the version that stays accessible.
  sitecolor: { max: 10, label: 'Default theme', kind: 'theme' },
};

const KEYS = Object.keys(FIELDS);

// Must stay in step with THEMES in frontend/src/config.jsx. Duplicated
// rather than imported because the backend has no build step reaching into
// the frontend tree; the test asserts the two lists match.
export const THEME_IDS = ['emerald', 'indigo', 'sunset', 'ocean'];

// Permissive on purpose. This is a display string, not an auth identifier —
// the strict-RFC games are not worth rejecting a valid address over.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[0-9+\-\s()]{7,30}$/;
const DIGITS_RE = /^[0-9]{5,15}$/;
// A handle or a URL. No spaces, no angle brackets, and — the one that
// matters — no `javascript:` or `data:` scheme, since these values become
// href attributes on a public page.
const LINK_RE = /^[^\s<>"']+$/;
const BAD_SCHEME_RE = /^\s*(javascript|data|vbscript|file)\s*:/i;

/**
 * Validate one submitted value.
 * @returns {{ok: true, value: string} | {ok: false, msg: string}}
 */
function clean(key, raw) {
  const def = FIELDS[key];
  const value = String(raw ?? '').trim();

  // Blank is always allowed and always means "we do not offer this". The
  // frontend hides a channel whose column is empty, which is the honest
  // rendering — better than a button that goes nowhere.
  if (!value) return { ok: true, value: '' };

  if (value.length > def.max) {
    return {
      ok: false,
      msg: `${def.label} is too long — ${value.length} characters, but the field holds ${def.max}.`,
    };
  }

  if (def.kind === 'email' && !EMAIL_RE.test(value)) {
    return { ok: false, msg: `${def.label} does not look like an email address.` };
  }
  if (def.kind === 'phone' && !PHONE_RE.test(value)) {
    return { ok: false, msg: `${def.label} should be digits, optionally with + ( ) - or spaces.` };
  }
  if (def.kind === 'digits' && !DIGITS_RE.test(value)) {
    return { ok: false, msg: `${def.label} should be 5–15 digits with nothing else.` };
  }
  if (def.kind === 'theme' && !THEME_IDS.includes(value)) {
    // An allow-list, not a pattern. This value is written into a
    // data-theme attribute on <html>, and the set of themes that actually
    // have stylesheets is fixed and small — so anything outside it would
    // render the app with no brand colours at all.
    return {
      ok: false,
      msg: `${def.label} must be one of: ${THEME_IDS.join(', ')}.`,
    };
  }
  if (def.kind === 'url' || def.kind === 'link') {
    if (BAD_SCHEME_RE.test(value)) {
      // Not paranoia about this operator: these strings are rendered as
      // href on pages seen by every customer, so the scheme is part of the
      // page's security surface no matter who typed it.
      return { ok: false, msg: `${def.label} must be a normal web address.` };
    }
    if (!LINK_RE.test(value)) {
      return { ok: false, msg: `${def.label} cannot contain spaces or quotes.` };
    }
  }
  if (def.kind === 'url' && !/^https?:\/\//i.test(value)) {
    // Stricter than `link`: a bare handle means something for Telegram,
    // nothing for "your site's address".
    return { ok: false, msg: `${def.label} must start with http:// or https://` };
  }

  return { ok: true, value };
}

/** Shape the row for the admin form — only the fields the form owns. */
function present(row) {
  const out = {};
  for (const key of KEYS) out[key] = row?.[key] ?? '';
  return out;
}

// ------------------------------------------------------------
//  GET /api/admin/settings
// ------------------------------------------------------------
export async function getSettings(req, res) {
  try {
    const row = await SiteSettings.findByPk(1);
    // A missing row is not an error — it is a fresh install. Return the
    // blank shape so the form renders and the first save creates it.
    return res.json({ status: 'success', data: present(row) });
  } catch (err) {
    if (handleSchemaDrift(res, err, { where: 'getSettings', audience: 'admin' })) return undefined;
    logger.error('getSettings failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load site settings.' });
  }
}

// ------------------------------------------------------------
//  PUT /api/admin/settings
// ------------------------------------------------------------
//  Partial update: only the keys present in the body are touched, so a
//  future screen that edits one section cannot blank the others by
//  omission. An explicit empty string still clears a field — that is how
//  you remove a channel.
export async function updateSettings(req, res) {
  try {
    const body = req.body || {};
    const patch = {};
    const errors = [];

    for (const key of KEYS) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const result = clean(key, body[key]);
      if (!result.ok) errors.push(result.msg);
      else patch[key] = result.value;
    }

    // Report every problem at once. Fixing one field, saving, and being
    // told about the next one is a miserable way to fill in a form.
    if (errors.length) {
      return res.status(422).json({ status: 'fail', msg: errors.join(' ') });
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ status: 'fail', msg: 'Nothing to update.' });
    }

    let row = await SiteSettings.findByPk(1);
    if (!row) row = await SiteSettings.create({ sId: 1, ...patch });
    else await row.update(patch);

    // ---- silent-truncation guard ----
    // The length checks above trust models/SiteSettings.js to match the
    // live table. When a migration has not been run, it does not: the
    // social columns are VARCHAR(10) in the database until
    // site_settings_social_widths.sql is applied, and MySQL's default
    // non-strict mode stores the first 10 characters and reports success.
    //
    // So do not trust the write — read it back and compare. This catches
    // the known case and any future one, and turns "the link I saved keeps
    // coming back wrong" into a sentence naming the migration.
    const saved = await SiteSettings.findByPk(1);
    const truncated = Object.keys(patch).filter(
      (k) => String(saved?.[k] ?? '') !== String(patch[k]),
    );
    if (truncated.length) {
      const names = truncated.map((k) => FIELDS[k].label).join(', ');
      logger.error('Site settings write did not round-trip', {
        sysId: req.admin?.sysId,
        fields: truncated,
        hint: 'Column is likely narrower than the model declares — run backend/scripts/migrate.js',
      });
      return res.status(409).json({
        status: 'fail',
        msg: `Saved, but the database shortened these: ${names}. `
          + 'The columns are narrower than this form expects — run the pending '
          + 'database migration on the server, then save again.',
        data: present(saved),
      });
    }

    // Field names only. The values are not secret, but phone and email are
    // personal data and the log is the wrong place to accumulate it.
    logger.info('Site settings updated', {
      sysId: req.admin?.sysId,
      fields: Object.keys(patch),
    });

    return res.json({
      status: 'success',
      msg: 'Site settings saved.',
      data: present(saved),
    });
  } catch (err) {
    if (handleSchemaDrift(res, err, { where: 'updateSettings', audience: 'admin' })) return undefined;
    logger.error('updateSettings failed', { sysId: req.admin?.sysId, error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not save site settings.' });
  }
}
