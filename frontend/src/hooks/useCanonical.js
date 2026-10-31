/* Keeps <link rel="canonical"> honest on a single-page app.
 *
 * WHY THIS EXISTS
 * index.html ships ONE canonical tag, and that same document is served for
 * every URL. Pinned to '/', it told crawlers that /pricing, /support,
 * /terms and /privacy were duplicates of the home page — at the same time
 * as public/sitemap.xml asked for all four to be indexed. Contradictory
 * signals, and the canonical is the stronger one, so the sub-pages would
 * have been dropped from the index while appearing perfectly healthy to us.
 *
 * SCOPE
 * Public, indexable routes only. Authenticated routes are Disallow'd in
 * robots.txt and must not appear here — emitting a canonical for /app or
 * /admin advertises URLs we deliberately keep out of an index.
 *
 * ORIGIN, not window.location.origin: the app is also reachable over
 * localhost in dev and (if it is ever proxied) a preview host. A canonical
 * must be absolute AND point at the real public site, so the production
 * origin is hardcoded. A canonical of http://localhost:5173/pricing is
 * worse than none at all.
 */

const ORIGIN = 'https://kwarapolydata.com.ng';

/* Only these paths get a canonical. Anything not listed is treated as
   non-indexable and the tag is removed rather than left stale — a leftover
   canonical from the previously-viewed route is an active lie. */
const INDEXABLE = new Set(['/', '/pricing', '/support', '/terms', '/privacy']);

/* Trailing slashes are stripped so '/pricing/' and '/pricing' collapse to
   one canonical, which is the entire point of the tag. '/' is preserved. */
function normalise(pathname) {
  if (!pathname || pathname === '/') return '/';
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export function applyCanonical(pathname) {
  if (typeof document === 'undefined') return;

  const path = normalise(pathname);
  let tag = document.querySelector('link[rel="canonical"]');

  if (!INDEXABLE.has(path)) {
    // Authenticated or unknown route: no canonical at all.
    if (tag) tag.remove();
    return;
  }

  if (!tag) {
    tag = document.createElement('link');
    tag.setAttribute('rel', 'canonical');
    document.head.appendChild(tag);
  }
  tag.setAttribute('href', path === '/' ? `${ORIGIN}/` : `${ORIGIN}${path}`);
}

export default applyCanonical;
