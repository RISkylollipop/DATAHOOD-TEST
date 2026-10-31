// ============================================================
//  Admin → Site Settings
// ------------------------------------------------------------
//  Edits the single `sitesettings` row that GET /settings/public hands to
//  every visitor. Four groups, in the order someone setting the site up
//  would work through them: identity, contact, social, manual funding.
//
//  Two things this screen owes the operator that a plain form would not:
//
//   1. A live preview of what the customer will actually see. The columns
//      accept a bare handle or a full URL and the frontend normalises on
//      the way out, so "kwarapoly" and "https://t.me/kwarapoly" are both
//      correct — but only the preview makes that believable.
//   2. Cache invalidation. useSiteSettings caches at module scope for the
//      whole page load, so without invalidateSiteSettings() the footer and
//      the Support page keep showing the old number until a hard reload,
//      and the save looks like it silently failed.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { Loader } from '../../components/Loader';
import {
  invalidateSiteSettings,
  supportChannels,
  socialLinks,
  formatLocalPhone,
} from '../../hooks/useSiteSettings';
import { IcGlobe, IcSupport, IcShare, IcCard, IcRefresh, IcExternal, IcPalette } from '../../components/Icons';
import { THEMES } from '../../config';

// Mirrors FIELDS in backend/controllers/siteSettingsController.js. The
// maxLength values are the real column widths — stopping the operator at
// the limit is kinder than letting the server reject the whole form.
const GROUPS = [
  {
    key: 'identity',
    title: 'Site identity',
    icon: IcGlobe,
    blurb: 'Used in page titles, emails and the API docs link.',
    fields: [
      { name: 'sitename', label: 'Site name', max: 20, placeholder: 'DATAHOOD' },
      { name: 'siteurl', label: 'Site URL', max: 100, placeholder: 'https://domainname.com.ng', type: 'url' },
      { name: 'apidocumentation', label: 'API documentation URL', max: 100, placeholder: 'https://…', type: 'url' },
    ],
  },
  {
    key: 'contact',
    title: 'Contact channels',
    icon: IcSupport,
    blurb: 'Anything left blank is hidden from the site rather than shown as a dead link.',
    fields: [
      { name: 'whatsapp', label: 'WhatsApp number', max: 30, placeholder: '08031234567', inputMode: 'tel' },
      { name: 'phone', label: 'Phone number', max: 30, placeholder: '08031234567', inputMode: 'tel' },
      { name: 'email', label: 'Support email', max: 120, placeholder: 'support@domainname.com.ng', type: 'email' },
      { name: 'whatsappgroup', label: 'WhatsApp group link', max: 255, placeholder: 'https://chat.whatsapp.com/…' },
      {
        name: 'supporthours',
        label: 'Support hours',
        max: 120,
        placeholder: 'Mon–Sat, 8am–9pm WAT',
        help: 'Leave blank to make no availability claim at all — that is the honest default if someone is not actually watching.',
      },
    ],
  },
  {
    key: 'social',
    title: 'Social links',
    icon: IcShare,
    blurb: 'A handle or a full link — both work.',
    fields: [
      { name: 'facebook', label: 'Facebook', max: 200, placeholder: 'domainname' },
      { name: 'twitter', label: 'X (Twitter)', max: 200, placeholder: 'domainname' },
      { name: 'instagram', label: 'Instagram', max: 200, placeholder: 'domainname' },
      { name: 'telegram', label: 'Telegram', max: 200, placeholder: 'domainname' },
    ],
  },
  {
    key: 'bank',
    title: 'Manual funding account',
    icon: IcCard,
    blurb: 'Shown to customers who fund by transfer instead of a payment gateway.',
    fields: [
      { name: 'accountname', label: 'Account name', max: 50, placeholder: 'SITENAME VENTURES' },
      { name: 'accountno', label: 'Account number', max: 15, placeholder: '0123456789', inputMode: 'numeric' },
      { name: 'bankname', label: 'Bank name', max: 20, placeholder: 'Access Bank / Opay' },
    ],
  },
  {
    key: 'appearance',
    title: 'Appearance',
    icon: IcPalette,
    blurb: 'The starting theme for anyone who has not chosen their own — new visitors, '
      + 'the signed-out pages and the login screen. Signed-in users can still override it '
      + 'from their profile, and this never changes a choice someone has already made.',
    fields: [
      { name: 'sitecolor', label: 'Default theme', max: 10, control: 'theme' },
    ],
  },
];

const ALL_FIELDS = GROUPS.flatMap((g) => g.fields.map((f) => f.name));

const blankForm = () => Object.fromEntries(ALL_FIELDS.map((k) => [k, '']));

// ------------------------------------------------------------
//  ThemePicker — radio group over the four real themes
// ------------------------------------------------------------
//  Radios rather than a <select> because the choice is visual: the swatch
//  has to sit next to the name, and a native select cannot show one.
//  Still a real radio group underneath, so keyboard and screen-reader
//  behaviour is the browser's rather than something reimplemented here.
//
//  The legacy column held a hex ('#0000e6'), so a site that has never
//  saved this screen arrives with a value matching no theme. That is
//  surfaced as "not set" rather than silently pre-selecting Emerald —
//  the operator should see that the default is unset and choose one.
function ThemePicker({ id, value, onChange }) {
  const known = THEMES.some((t) => t.id === value);
  return (
    <div id={id} role="radiogroup" aria-label="Default theme">
      <div className="row wrap" style={{ gap: 8 }}>
        {THEMES.map((t) => {
          const active = value === t.id;
          return (
            <label
              key={t.id}
              className={`btn btn-sm ${active ? '' : 'btn-soft'}`}
              style={{ cursor: 'pointer', gap: 8 }}
            >
              <input
                type="radio"
                name="sitecolor-theme"
                value={t.id}
                checked={active}
                onChange={() => onChange(t.id)}
                style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
              />
              <span
                aria-hidden="true"
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: t.color,
                  border: '1px solid rgba(0,0,0,.25)',
                  display: 'inline-block',
                  flex: '0 0 auto',
                }}
              />
              {t.name}
            </label>
          );
        })}
      </div>
      {!known && (
        <p className="muted small mt-1">
          {value
            ? `Currently “${value}”, which is the old colour format and matches no theme — the site falls back to Emerald until you pick one.`
            : 'Not set — the site falls back to Emerald.'}
        </p>
      )}
    </div>
  );
}

export default function AdminSiteSettings() {
  const toast = useToast();

  const [form, setForm] = useState(blankForm);
  // The last saved state, kept so the Save button can be disabled when
  // nothing has changed and so Discard has something to go back to.
  const [saved, setSaved] = useState(blankForm);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/admin/settings')
      .then((r) => {
        const next = { ...blankForm(), ...(r.data || {}) };
        // Normalise null → '' so a controlled input never flips to
        // uncontrolled, which React warns about and which loses the caret.
        for (const k of ALL_FIELDS) next[k] = next[k] == null ? '' : String(next[k]);
        setForm(next);
        setSaved(next);
      })
      .catch((err) => toast.error('Could not load site settings', err.message))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(
    () => ALL_FIELDS.some((k) => (form[k] || '') !== (saved[k] || '')),
    [form, saved],
  );

  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      // Send only what changed. The endpoint is a partial update, so this
      // keeps an unrelated field from being rewritten with a stale value if
      // two people have the screen open.
      const patch = {};
      for (const k of ALL_FIELDS) {
        if ((form[k] || '') !== (saved[k] || '')) patch[k] = form[k].trim();
      }
      const r = await api.put('/admin/settings', patch);
      const next = { ...blankForm(), ...(r.data || {}) };
      for (const k of ALL_FIELDS) next[k] = next[k] == null ? '' : String(next[k]);
      setForm(next);
      setSaved(next);
      // Without this the rest of the app keeps serving the cached row.
      invalidateSiteSettings();
      toast.success('Saved', r.msg);
    } catch (err) {
      // A 409 here is the truncation guard: the row was written but the
      // database shortened something. The message names the fields and the
      // fix, so pass it through rather than flattening it to "failed".
      toast.error('Site settings not fully saved', err.message);
      load();
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loader />;

  // Preview is computed from the CURRENT form, not the saved row, so the
  // operator can see what a value will do before committing to it.
  const channels = supportChannels(form);
  const socials = socialLinks(form);

  return (
    <>
      <div className="row between wrap mb-2">
        <div>
          <div className="page-title">Site Settings</div>
          <div className="page-sub">
            Contact channels, social links and branding shown across the site.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-soft btn-sm" onClick={load} disabled={busy}>
            <IcRefresh size={15} /> Reload
          </button>
        </div>
      </div>

      <form onSubmit={submit}>
        {GROUPS.map((group) => {
          const Icon = group.icon;
          return (
            <div className="card card-pad-lg mb-2" key={group.key}>
              <div className="row" style={{ gap: 10 }}>
                <Icon size={20} />
                <div className="strong">{group.title}</div>
              </div>
              <p className="muted small mt-1">{group.blurb}</p>

              <div className="grid grid-2 mt-1">
                {group.fields.map((f) => (
                  <div className="field" key={f.name}>
                    <label className="label" htmlFor={`ss-${f.name}`}>{f.label}</label>
                    {f.control === 'theme' ? (
                      <ThemePicker
                        id={`ss-${f.name}`}
                        value={form[f.name]}
                        onChange={(v) => setForm((prev) => ({ ...prev, [f.name]: v }))}
                      />
                    ) : (
                      <input
                        id={`ss-${f.name}`}
                        className="input"
                        value={form[f.name]}
                        onChange={set(f.name)}
                        maxLength={f.max}
                        placeholder={f.placeholder}
                        inputMode={f.inputMode}
                        type={f.type === 'email' ? 'email' : 'text'}
                        autoComplete="off"
                      />
                    )}
                    {f.help && <p className="muted small mt-0">{f.help}</p>}
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {/* ---------- preview ---------- */}
        <div className="card card-pad-lg mb-2">
          <div className="strong">What customers will see</div>
          <p className="muted small mt-1">
            Built with the same code the Support page and footer use, so this is the
            real result — not an approximation.
          </p>

          {channels.length === 0 && socials.length === 0 ? (
            <p className="muted small">
              Nothing is configured yet, so the site currently offers no way to reach you.
            </p>
          ) : null}

          {channels.length > 0 && (
            <div className="mt-1">
              <div className="small strong mb-1">Support channels</div>
              <ul className="feat-list">
                {channels.map((c) => (
                  <li key={c.key} className="row between wrap" style={{ gap: 8, padding: '6px 0' }}>
                    <span className="small">
                      <strong>{c.label}</strong> · {c.value}
                    </span>
                    <a
                      className="small muted"
                      href={c.href}
                      target={c.external ? '_blank' : undefined}
                      rel={c.external ? 'noreferrer noopener' : undefined}
                    >
                      {c.href} {c.external ? <IcExternal size={12} /> : null}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {socials.length > 0 && (
            <div className="mt-1">
              <div className="small strong mb-1">Social</div>
              <ul className="feat-list">
                {socials.map((s) => (
                  <li key={s.key} className="row between wrap" style={{ gap: 8, padding: '6px 0' }}>
                    <span className="small"><strong>{s.label}</strong></span>
                    <a className="small muted" href={s.href} target="_blank" rel="noreferrer noopener">
                      {s.href} <IcExternal size={12} />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {form.phone && (
            <p className="muted small mt-1">
              Phone renders as <strong>{formatLocalPhone(form.phone)}</strong>.
            </p>
          )}
        </div>

        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn" disabled={busy || !dirty}>
            {busy ? <span className="spinner" /> : 'Save changes'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setForm(saved)}
            disabled={busy || !dirty}
          >
            Discard changes
          </button>
          {!dirty && <span className="muted small">No unsaved changes.</span>}
        </div>
      </form>
    </>
  );
}
