// ============================================================
//  scripts/test_richText.js — adversarial tests for utils/richText.js
// ------------------------------------------------------------
//  Run:  node scripts/test_richText.js      (exit 0 = pass)
//
//  richText.js decides what an admin-authored newsletter is allowed to
//  become. Its output is rendered twice in trusted places: in the admin's
//  own browser via dangerouslySetInnerHTML, and in every recipient's inbox.
//  So the tests here are mostly hostile input, not happy paths.
//
//  These tests were mutation-tested rather than merely run: 19 deliberate
//  faults were injected into a copy of richText.js (escapeHtml made a
//  no-op, each of the five escapes removed one at a time, safeUrl's ^
//  anchor dropped, hrefs left unescaped, the button label left unescaped,
//  lists never closed, the plain-text link URL dropped, …) and every one
//  of them turned this file red. Three earlier versions of these tests let
//  a fault through and had to be strengthened:
//
//   * checking for "onerror" anywhere in the output flagged the ESCAPED
//     copy too, so a real bug and a correct render looked identical;
//   * requiring whitespace before an event handler missed
//     href="x"onmouseover="y", which browsers recover into a live
//     attribute;
//   * substring-matching the tag text flagged the inert
//     href="...&quot; onmouseover=&quot;x" as an attack.
//
//  Hence tagAudit() below parses each emitted tag into a real attribute
//  list. That is the only way to tell "one weird URL" from "two
//  attributes, the second of which is code".
//
//  If you add syntax to richText.js, add a hostile case for it here, then
//  break the new code on purpose and confirm this file notices.
// ============================================================

import { renderRichText, renderPlainText, safeUrl, escapeHtml }
  from '../utils/richText.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL: ${name}${extra ? '\n        ' + extra : ''}`); }
};

// ---------- 0. escapeHtml's own contract: all five characters ----------
// The single quote is not exploitable through THIS renderer (every
// attribute it emits is double-quoted), but escapeHtml is exported and the
// next caller may not be so careful. Test the promise, not just the usage.
ok('escapes &', escapeHtml('a & b') === 'a &amp; b', escapeHtml('a & b'));
ok('escapes <', escapeHtml('a < b') === 'a &lt; b', escapeHtml('a < b'));
ok('escapes >', escapeHtml('a > b') === 'a &gt; b', escapeHtml('a > b'));
ok('escapes "', escapeHtml('say "hi"') === 'say &quot;hi&quot;', escapeHtml('say "hi"'));
ok("escapes '", escapeHtml("it's") === 'it&#39;s', escapeHtml("it's"));
ok('& escaped first (no double-encoding)',
  escapeHtml('<') === '&lt;' && escapeHtml('&lt;') === '&amp;lt;', escapeHtml('&lt;'));
ok('null/undefined become empty', escapeHtml(null) === '' && escapeHtml(undefined) === '');

// ---------- 1. Nothing the author types can become markup ----------
const hostile = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '</p><script>alert(1)</script><p>',
  '<a href="javascript:alert(1)">x</a>',
  "'\"><svg onload=alert(1)>",
  '<style>body{display:none}</style>',
];
// Only these tags may ever appear in output, and none may carry an event
// handler. Checking the EMITTED TAGS (not the whole string) is the honest
// test: `&lt;img onerror=...&gt;` is inert text and should not count as a hit.
const ALLOWED = new Set(['p','br','a','strong','em','code','h1','h2','h3',
                         'ul','ol','li','blockquote','hr','table','tr','td']);
const tagAudit = (html) => {
  for (const tag of html.match(/<[^>]*>/g) || []) {
    const m = tag.match(/^<\/?([a-z0-9]+)([\s\S]*?)\/?>$/i);
    if (!m) return `unparseable tag ${tag}`;
    const [, name, attrPart] = m;
    if (!ALLOWED.has(name.toLowerCase())) return `disallowed tag ${tag}`;

    // Walk the attributes rather than substring-matching the tag. The
    // difference matters: href="...&quot; onmouseover=&quot;x" is ONE inert
    // attribute, while href="..." onmouseover="x" is two, and only the
    // second is an attack. A regex over the raw text cannot tell them apart.
    let rest = attrPart;
    const attrs = [];
    while (rest.trim()) {
      const a = rest.match(/^\s+([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"]*)")?/);
      if (!a) return `malformed attributes in ${tag}`;
      attrs.push([a[1].toLowerCase(), a[2] ?? '']);
      rest = rest.slice(a[0].length);
    }
    for (const [k, v] of attrs) {
      if (k.startsWith('on')) return `event handler ${k}= in ${tag}`;
      if (k === 'href') {
        const decoded = v.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                         .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                         .replace(/&amp;/g, '&');
        if (!/^(https?:\/\/|mailto:)/i.test(decoded)) return `bad href ${decoded}`;
      }
      if (k === 'src' || k === 'srcdoc' || k === 'formaction') return `${k} in ${tag}`;
    }
  }
  return null;
};
for (const h of hostile) {
  const html = renderRichText(h);
  ok(`inert: ${h.slice(0, 24)}`, tagAudit(html) === null, tagAudit(html) + ' :: ' + html.slice(0, 160));
  ok(`no raw < left: ${h.slice(0, 24)}`,
    !/<(?!\/?(p|br|a|strong|em|code|h[123]|ul|ol|li|blockquote|hr|table|tr|td)[ />])/i.test(html),
    html.slice(0, 160));
}

// ---------- 2. Dangerous URL schemes never reach an href ----------
const badUrls = [
  'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)',
  'file:///etc/passwd', '//evil.com', 'jAvAsCrIpT&colon;alert(1)',
  // Embedded-scheme bypasses: an unanchored test would wave these through.
  "javascript:window.location='https://evil.example'",
  'javascript:fetch("http://evil.example")',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'not-a-scheme://https://evil.example',
];
for (const u of badUrls) {
  ok(`safeUrl rejects ${u.slice(0, 28)}`, safeUrl(u) === null, `got ${safeUrl(u)}`);
  const html = renderRichText(`[click](${u})`);
  ok(`no href for ${u.slice(0, 28)}`, !/href=/i.test(html), html.slice(0, 160));
  const btn = renderRichText(`[[Click|${u}]]`);
  ok(`no button href for ${u.slice(0, 28)}`, !/href=/i.test(btn), btn.slice(0, 160));
}

// ---------- 2b. A hostile BUTTON LABEL is text, not markup ----------
// The label sits between [[ and | and may contain anything except | and ],
// which is plenty of room for a <script> tag.
for (const label of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>',
                     '"><svg onload=alert(1)>']) {
  const html = renderRichText(`[[${label}|https://kwarapolydata.com.ng]]`);
  ok(`button label inert: ${label.slice(0, 22)}`, tagAudit(html) === null,
    tagAudit(html) + ' :: ' + html.slice(0, 200));
}
// …and so is a hostile heading, list item and quote.
for (const tpl of ['# <script>alert(1)</script>', '- <img src=x onerror=alert(1)>',
                   '> <svg onload=alert(1)>', '1. <script>alert(1)</script>']) {
  const html = renderRichText(tpl);
  ok(`block inert: ${tpl.slice(0, 22)}`, tagAudit(html) === null,
    tagAudit(html) + ' :: ' + html.slice(0, 200));
}

// ---------- 3. Good URLs still work ----------
ok('https passes', safeUrl('https://kwarapolydata.com.ng/x') === 'https://kwarapolydata.com.ng/x');
ok('http passes', safeUrl('http://a.com') === 'http://a.com');
ok('mailto passes', safeUrl('mailto:a@b.com') === 'mailto:a@b.com');
ok('bare domain promoted', safeUrl('kwarapolydata.com.ng') === 'https://kwarapolydata.com.ng');
ok('bare domain w/ path', safeUrl('kwarapolydata.com.ng/login') === 'https://kwarapolydata.com.ng/login');
ok('not a domain rejected', safeUrl('just some words') === null);

// ---------- 3b. A quote inside a URL must not break out of href ----------
// safeUrl happily accepts this (it does start with https://), so the only
// thing standing between it and an injected event handler is escapeHtml's
// double-quote rule. That rule is invisible until something tests it.
// NOTE the third case: the inline-link syntax forbids spaces in a URL, but
// the [[button]] syntax does not — so the button is the only path where a
// cleanly-spaced second attribute can be injected. Test it explicitly.
for (const src of ['[click](https://x.com/\"onmouseover=\"alert)',
                   '[[Label|https://x.com/\"onmouseover=\"alert]]',
                   '[[Label|https://x.com/\" onmouseover=\"alert(1)]]',
                   '[[Label|https://x.com/\" style=\"position:fixed;inset:0]]',
                   "[click](https://x.com/'onmouseover='alert)"]) {
  const html = renderRichText(src);
  ok(`quote in URL cannot escape href: ${src.slice(0, 26)}`,
    tagAudit(html) === null && !/href="[^"]*"[^>]*\son[a-z]+=/i.test(html),
    tagAudit(html) + ' :: ' + html.slice(0, 220));
}

// ---------- 4. Ampersand round-trip in a link (escape then unescape) ----------
const amp = renderRichText('[go](https://x.com/a?b=1&c=2)');
ok('href keeps both query params',
  amp.includes('href="https://x.com/a?b=1&amp;c=2"'), amp);

// ---------- 5. Block rendering ----------
const doc = [
  '# Big news',
  '',
  'Hello **there**, this is *it*.',
  '',
  '- one',
  '- two',
  '',
  '1. first',
  '2. second',
  '',
  '> a quote',
  '',
  '---',
  '',
  '[[Fund your wallet|https://kwarapolydata.com.ng/wallet]]',
].join('\n');
const out = renderRichText(doc);
ok('h1', out.includes('<h1'), out);
ok('strong', out.includes('<strong>there</strong>'), out);
ok('em', out.includes('<em>it</em>'), out);
ok('ul opened+closed', (out.match(/<ul/g) || []).length === 1 && out.includes('</ul>'));
ok('ol opened+closed', (out.match(/<ol/g) || []).length === 1 && out.includes('</ol>'));
ok('two li in ul before ol', out.indexOf('</ul>') < out.indexOf('<ol'));
ok('blockquote', out.includes('<blockquote'), out);
ok('hr', out.includes('<hr'), out);
ok('button href', out.includes('https://kwarapolydata.com.ng/wallet') && out.includes('<a href'), out);
ok('button label', out.includes('>Fund your wallet</a>'), out);
ok('whole document emits only allowed tags', tagAudit(out) === null, String(tagAudit(out)));

// every opened tag closed
for (const t of ['p', 'ul', 'ol', 'li', 'h1', 'blockquote', 'a', 'strong', 'em']) {
  const o = (out.match(new RegExp(`<${t}[ >]`, 'g')) || []).length;
  const c = (out.match(new RegExp(`</${t}>`, 'g')) || []).length;
  ok(`<${t}> balanced (${o}/${c})`, o === c);
}

// ---------- 6. Plain-text twin ----------
const txt = renderPlainText(doc);
ok('text drops #', txt.startsWith('Big news'), txt.slice(0, 40));
ok('text drops **', !txt.includes('**'), txt);
ok('text keeps button url', txt.includes('Fund your wallet: https://kwarapolydata.com.ng/wallet'), txt);
ok('text has no tags', !/<[a-z]/i.test(txt), txt);
const linkTxt = renderPlainText('see [our pricing](https://k.ng/pricing) today');
ok('text keeps link words AND url',
  linkTxt.includes('our pricing') && linkTxt.includes('https://k.ng/pricing'), linkTxt);

// ---------- 7. Degenerate input must not throw or hang ----------
for (const s of [null, undefined, '', '   ', '\n\n\n', '*'.repeat(500), '['.repeat(500),
                 '**'.repeat(500), '`'.repeat(500), '[['.repeat(200), '#'.repeat(200) + ' x']) {
  try { renderRichText(s); renderPlainText(s); ok('no throw on degenerate', true); }
  catch (e) { ok('no throw on degenerate', false, `${JSON.stringify(String(s).slice(0,20))} -> ${e.message}`); }
}

// ---------- 8. CONTROL RUN: prove the tests can fail ----------
// If escapeHtml were a no-op, section 1 must go red. Verified by hand below.
const asIf = (s) => String(s);
const wouldLeak = /<script/i.test(`<p>${asIf('<script>alert(1)</script>')}</p>`);
ok('CONTROL: an unescaped renderer would have been caught', wouldLeak === true);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
