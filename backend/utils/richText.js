// ============================================================
//  utils/richText.js — the tiny markup the newsletter composer accepts
// ------------------------------------------------------------
//  A deliberately small Markdown subset, rendered to email-safe HTML and
//  to a plain-text twin.
//
//  Why not just let the admin paste HTML?
//
//   * The composer's preview is rendered in the admin's own browser with
//     dangerouslySetInnerHTML. Accepting raw HTML there turns the compose
//     box into a stored-XSS sink inside the admin panel — the highest-value
//     session on the platform. Escaping everything first and emitting only
//     tags this file chose means the preview can never execute anything.
//   * Email clients silently drop most of what a person would paste from a
//     word processor. A narrow input that always renders the same way beats
//     a wide one that renders differently in Gmail, Outlook and Apple Mail.
//
//  Why not a Markdown library? The project rule is not to add dependencies
//  that are not needed, and every general-purpose Markdown renderer allows
//  inline HTML by default — the exact thing being avoided.
//
//  Everything here is a pure function of its input, so it can be tested
//  without a database, a mail server or a browser.
// ============================================================

/**
 * Escape the five characters that can break out of HTML text or an
 * attribute. Runs FIRST, on the raw source, so nothing the author typed can
 * become markup; the renderers below then insert their own tags into
 * already-safe text.
 */
export function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Allow a URL into an href, or reject it.
 *
 * Only http, https and mailto. `javascript:` is the obvious one, but `data:`
 * matters too — a data URL can carry a whole HTML document, and some clients
 * will render it. Anything unrecognised returns null and the link is
 * rendered as plain text rather than silently dropped, so the author can see
 * that it did not become a link.
 */
export function safeUrl(raw) {
  const url = String(raw ?? '').trim();
  if (!url) return null;
  if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
  // A bare domain is what people actually type. Promote it rather than
  // rejecting it — but only when it really looks like a host, so a typo
  // like "javascript:alert(1)" cannot slip through as "https://javascript…".
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/|$)/i.test(url)) return `https://${url}`;
  return null;
}

// ---- inline: **bold**, *italic*, `code`, [text](url) ----
//
// Applied to text that has ALREADY been escaped, which is why the patterns
// look for `&quot;` rather than `"` in places. Order matters: links first,
// so a URL containing an asterisk is not chewed up by the emphasis pass.
function inline(escaped) {
  let out = escaped;

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text, url) => {
    // The URL arrives escaped, so &amp; must go back to & before it is used.
    const href = safeUrl(url.replace(/&amp;/g, '&'));
    if (!href) return `${text} (${url})`;
    return `<a href="${escapeHtml(href)}" style="color:#1d4ed8;text-decoration:underline">${text}</a>`;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/`([^`\n]+)`/g, '<code style="background:#f1f5f9;padding:2px 5px;border-radius:4px">$1</code>');

  return out;
}

/**
 * Render the markup to HTML fragments (no document wrapper — that is the
 * email template's job).
 *
 * Block syntax:
 *   # / ## / ###   headings
 *   - or *         bullet list
 *   1.             numbered list
 *   >              quote
 *   ---            horizontal rule
 *   [[Label|url]]  call-to-action button, alone on its line
 *   blank line     paragraph break
 */
export function renderRichText(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  let paragraph = [];

  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  const closeParagraph = () => {
    if (paragraph.length) {
      out.push(`<p style="margin:0 0 16px;line-height:1.65">${inline(paragraph.join('<br/>'))}</p>`);
      paragraph = [];
    }
  };
  const closeAll = () => { closeParagraph(); closeList(); };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const escaped = escapeHtml(line.trim());

    if (!line.trim()) { closeAll(); continue; }

    // Button — checked before links so [[…]] is not read as a nested [ ].
    const button = line.trim().match(/^\[\[([^|\]]+)\|([^\]]+)\]\]$/);
    if (button) {
      closeAll();
      const href = safeUrl(button[2]);
      const label = escapeHtml(button[1].trim());
      if (href) {
        out.push(
          '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px">'
          + `<tr><td style="background:#1d4ed8;border-radius:8px"><a href="${escapeHtml(href)}"`
          + ' style="display:inline-block;padding:12px 26px;color:#ffffff;text-decoration:none;'
          + `font-weight:700;font-size:15px">${label}</a></td></tr></table>`,
        );
      } else {
        out.push(`<p style="margin:0 0 16px">${label}</p>`);
      }
      continue;
    }

    const heading = escaped.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeAll();
      const level = heading[1].length;
      const size = [24, 19, 16][level - 1];
      out.push(
        `<h${level} style="margin:26px 0 10px;font-size:${size}px;line-height:1.3;color:#0f172a">`
        + `${inline(heading[2])}</h${level}>`,
      );
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeAll();
      out.push('<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>');
      continue;
    }

    const quote = escaped.match(/^&gt;\s?(.*)$/);
    if (quote) {
      closeAll();
      out.push(
        '<blockquote style="margin:0 0 16px;padding:10px 16px;border-left:3px solid #1d4ed8;'
        + `background:#f8fafc;color:#334155">${inline(quote[1])}</blockquote>`,
      );
      continue;
    }

    const bullet = escaped.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      closeParagraph();
      if (list !== 'ul') { closeList(); out.push('<ul style="margin:0 0 16px;padding-left:22px">'); list = 'ul'; }
      out.push(`<li style="margin:0 0 7px;line-height:1.6">${inline(bullet[1])}</li>`);
      continue;
    }

    const numbered = escaped.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      closeParagraph();
      if (list !== 'ol') { closeList(); out.push('<ol style="margin:0 0 16px;padding-left:22px">'); list = 'ol'; }
      out.push(`<li style="margin:0 0 7px;line-height:1.6">${inline(numbered[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(escaped);
  }

  closeAll();
  return out.join('\n');
}

/**
 * The plain-text twin.
 *
 * Not optional and not an afterthought: a message sent as HTML only scores
 * worse with spam filters, and a text part is what a screen reader or a
 * watch notification actually reads. Generated from the same source rather
 * than by stripping tags out of the HTML, so the two can never drift.
 */
export function renderPlainText(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  return lines
    .map((raw) => {
      const line = raw.trim();
      const button = line.match(/^\[\[([^|\]]+)\|([^\]]+)\]\]$/);
      if (button) {
        const href = safeUrl(button[2]);
        return href ? `${button[1].trim()}: ${href}` : button[1].trim();
      }
      return line
        .replace(/^(#{1,3})\s+/, '')
        .replace(/^(-{3,}|\*{3,})$/, '--------------------')
        .replace(/^&gt;\s?/, '> ')
        .replace(/^[-*]\s+/, '  - ')
        // Keep both halves of a link: the words AND where they go. A text
        // part that says "click here" with no URL is useless.
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Rough word count, for the "about a 2 minute read" hint in the composer. */
export function wordCount(source) {
  const words = String(source ?? '').trim().match(/\S+/g);
  return words ? words.length : 0;
}
