import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { networkLabel, formatNaira } from '../config';
import { useSiteSettings, supportChannels, socialLinks } from '../hooks/useSiteSettings';
import {
  IcPhone, IcData, IcBolt, IcTv, IcShield, IcWallet, IcCheck, IcDownload,
  IcClock, IcRefresh, IcCard, IcSupport, IcExternal, IcTag,
} from '../components/Icons';
import '../styles/Landing.css';

// ── Editable business facts ─────────────────────────────────
// Kept together on purpose: these are the numbers most likely to need
// updating, and hunting them out of JSX is how they go stale.
//
// App store links are not live yet. Rendering a button that goes nowhere
// is worse than rendering none, so the section below checks for these and
// shows a "coming soon" note instead of a dead link. Fill them in and the
// buttons appear automatically.
const APP_LINKS = {
  android: '',
  ios: '',
};

const SERVICES = [
  {
    icon: IcData,
    title: 'Data bundles',
    body: 'SME, Gifting and Corporate plans on MTN, Glo, T2 and Airtel — delivered in seconds, at reseller rates.',
  },
  {
    icon: IcPhone,
    title: 'Airtime top-up',
    body: 'Instant airtime on every Nigerian network, with a discount on every single recharge.',
  },
  {
    icon: IcBolt,
    title: 'Electricity bills',
    body: 'Prepaid tokens and postpaid payments for all 11 DisCos. Your token arrives with the receipt.',
  },
  {
    icon: IcTv,
    title: 'Cable TV',
    body: 'Renew DSTV, GOtv and Startimes subscriptions without leaving the house or joining a queue.',
  },
  {
    icon: IcShield,
    title: 'Identity verification',
    body: 'Verify NIN, BVN, drivers licence, passport and more — with a downloadable PDF slip for your records.',
  },
  {
    icon: IcWallet,
    title: 'Wallet funding',
    body: 'Get a dedicated bank account number. Transfer from any bank app and your wallet credits automatically.',
  },
];

// DB network names, run through networkLabel() so 9MOBILE renders as T2
// exactly the way it does everywhere else in the product.
//
// `tint` is the network's own public brand colour, carried as a CSS
// custom property so the cards read the way a Nigerian customer already
// recognises them — yellow is MTN before the word is even read. These are
// recognition cues on a 3px rule and a dot, NOT reproductions of anyone's
// logo, which is why an approximate hex is acceptable here and why the
// networks' marks are not used.
//
// T2 (the 9mobile rebrand) is deliberately left null: I do not know its
// official brand hex, and guessing would put a wrong colour next to a
// competitor's name on a commercial page. With null it falls back to the
// active theme's brand colour, which looks intentional. Set it once you
// have the real value.
const NETWORKS = [
  { name: 'MTN', tint: '#FFCB05' },
  { name: 'GLO', tint: '#5FB246' },
  { name: '9MOBILE', tint: null },
  { name: 'AIRTEL', tint: '#E40046' },
];


const TRUST_STATS = [
  { value: '30,000+', label: 'Transactions processed' },
  { value: String(SERVICES.length), label: 'Services in one wallet' },
  { value: String(NETWORKS.length), label: 'Networks supported' },
  { value: '24/7', label: 'Automated delivery' },
];

const STEPS = [
  {
    n: 1,
    title: 'Create your free account',
    body: 'Name, phone and email. No documents, no waiting for approval — you can transact the same minute.',
  },
  {
    n: 2,
    title: 'Fund your wallet',
    body: 'You get a dedicated account number. Transfer from any Nigerian bank app and the wallet credits automatically, day or night.',
  },
  {
    n: 3,
    title: 'Buy in seconds',
    body: 'Pick a service, enter the number, confirm with your PIN. Delivery is automatic and you get a receipt for every order.',
  },
];

const TIER_BENEFITS = [
  {
    name: 'User',
    tagline: 'Free forever',
    points: ['Standard rates on every plan', 'All services unlocked', 'Receipts on every transaction'],
  },
  {
    name: 'Agent',
    tagline: 'One-time upgrade',
    points: ['Lower prices on every data plan', 'Better airtime discount', 'Ideal if you resell to friends'],
    highlight: false,
  },
  {
    name: 'Vendor',
    tagline: 'Best rates',
    points: ['Our lowest price on every plan', 'Built for shops and busy resellers', 'Margin on every single sale'],
    highlight: true,
  },
];

const WHY_US = [
  {
    icon: IcClock,
    title: 'Delivered in seconds',
    body: 'Orders go straight to the network. No manual processing, no waiting for someone to wake up.',
  },
  {
    icon: IcRefresh,
    title: 'Automatic refunds',
    
    body: 'If an order fails, the money goes back to your wallet automatically — no request, no waiting for us to open.',
  },
  {
    icon: IcCard,
    title: 'Your own account number',
    body: 'A dedicated virtual account in your name. Fund from any bank, any time, and it reflects immediately.',
  },
  // {
  //   icon: IcDownload,
  //   title: 'Shareable receipts',
  //   body: 'Every transaction produces a clean receipt you can save or send to your own customer.',
  // },
  {
    icon: IcShield,
    title: 'PIN on every purchase',
    body: 'A transaction PIN separate from your password, so nobody can spend your balance even if they reach your phone.',
  },
  {
    icon: IcSupport,
    title: 'Real human support',
    body: 'Reach us on WhatsApp with your transaction reference and talk to someone who can actually check it.',
  },
];

// ── Testimonials ────────────────────────────────────────────
// EMPTY ON PURPOSE. Do not fill this with written-for-you copy.
//
// This array previously held three invented quotes attributed to named
// people in named cities ("Aisha B., Vendor, Ilorin" and two others),
// complete with specific factual claims about how long they had been
// customers. Nobody said them. Publishing them would be a misleading
// representation to consumers under the FCCPA 2018, and it would be
// dishonest to the buyer regardless of what the law says.
//
// The section below renders NOTHING while this is empty, so the page is
// complete and shippable as-is. Add entries only when you have a real
// message from a real customer who is happy to be quoted — their own
// words, and initials at minimum so the person is identifiable to
// themselves. A screenshot of the WhatsApp message in your records is
// enough provenance.
const TESTIMONIALS = [];

const FAQS = [
  {
    q: 'How fast is delivery?',
    a: 'Airtime and data are delivered in seconds. Orders go straight to the network automatically, so nothing waits for a human to process it. Electricity tokens arrive with the receipt.',
  },
  {
    q: 'What happens if a transaction fails?',
    a: 'Your wallet is refunded automatically. Failed orders are reversed by the system and the transaction shows as refunded in your history, with the balance restored. In the rare case a reversal does not land, send us the transaction reference and we will return it.',
  },
  {
    q: 'How do I fund my wallet?',
    a: 'You are issued a dedicated bank account number in your own name. Transfer to it from any Nigerian bank app and your wallet credits automatically. There is nothing to upload and no receipt to send us.',
  },
  {
    q: 'Do I need to pay to register?',
    a: 'No. Creating an account is completely free and you get full access to every service at User rates. Upgrading to Agent or Vendor is optional and only worth it if you buy often enough to benefit from the lower prices.',
  },
  {
    q: 'What is the difference between User, Agent and Vendor?',
    a: 'They are pricing tiers. Every tier can use every service; Agents and Vendors simply pay less per data plan. Vendor is our cheapest rate and is intended for people reselling regularly. You can see the exact price for all three tiers on the pricing page before deciding.',
  },
  {
    q: 'Which identity documents can I verify?',
    a: 'NIN, BVN, drivers licence, international passport and vehicle records, among others. Each verification produces a downloadable PDF slip you can keep or hand to whoever requested it.',
  },
  {
    q: 'Is my money safe?',
    a: 'Every purchase requires a transaction PIN that is separate from your login password, so someone holding your unlocked phone still cannot spend your balance. Wallet movements are recorded individually, and you can see the balance before and after each transaction in your history.',
  },
  {
    q: 'Can I use Datahood to run my own business?',
    a: 'Yes — the platform is built for it. The Agent and Vendor tiers exist so you can buy below the standard rate and sell on at your own price. Receipts are designed to be shared with your customer without exposing what you paid.',
  },
];

/**
 * Newsletter signup — the public end of the admin composer.
 *
 * Deliberately asks for an email and nothing else. Every extra field on a
 * form like this costs sign-ups, and the only thing actually needed to
 * mail someone is their address.
 *
 * The success message says "check your inbox", never "you're subscribed",
 * because nothing is subscribed yet: the server sends a confirmation link
 * and only the click on that link puts the address on the list. That is
 * what stops this open form from being used to sign strangers up, and it
 * is the consent record the business relies on later.
 *
 * The server answers identically whether the address is new, already
 * pending or already confirmed, so this form cannot be used to find out
 * who is a customer. The UI must therefore not try to be cleverer than
 * the response it gets — there is nothing more to tell.
 */
function NewsletterSignup() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState('idle');
  const [msg, setMsg] = useState('');

  const submit = (e) => {
    e.preventDefault();
    if (state === 'sending') return;
    setState('sending');
    api.post('/newsletter/subscribe', { email, source: 'landing' })
      .then((r) => { setState('done'); setMsg(r.msg); })
      .catch((err) => { setState('error'); setMsg(err.message); });
  };

  if (state === 'done') {
    return (
      <p className="lp-news-done" role="status">
        <IcCheck aria-hidden="true" /> {msg}
      </p>
    );
  }

  return (
    <form className="lp-news-form" onSubmit={submit} noValidate>
      <label className="lp-sr-only" htmlFor="lp-news-email">Your email address</label>
      <input
        id="lp-news-email"
        className="input"
        type="email"
        name="email"
        required
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(ev) => { setEmail(ev.target.value); if (state === 'error') setState('idle'); }}
        aria-describedby="lp-news-note"
      />
      <button type="submit" className="btn" disabled={state === 'sending' || !email.trim()}>
        {state === 'sending' ? 'Sending…' : 'Keep me posted'}
      </button>
      {state === 'error' && <p className="lp-news-err" role="alert">{msg}</p>}
    </form>
  );
}

function FaqItem({ item, open, onToggle, id }) {
  return (
    <div className={`lp-faq-item${open ? ' is-open' : ''}`}>
      {/* A real <button>, not a div with onClick: it must be reachable by
          keyboard and announced as expandable by a screen reader. */}
      <button
        type="button"
        className="lp-faq-q"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        id={`${id}-btn`}
        onClick={onToggle}
      >
        <span>{item.q}</span>
        <span className="lp-faq-chevron" aria-hidden="true" />
      </button>
      {/* Kept in the DOM when closed (hidden via the `hidden` attribute)
          so the answer text is still indexed by crawlers that do run JS,
          and so it matches the FAQPage JSON-LD in index.html. */}
      <div
        className="lp-faq-a"
        id={`${id}-panel`}
        role="region"
        aria-labelledby={`${id}-btn`}
        hidden={!open}
      >
        <p>{item.a}</p>
      </div>
    </div>
  );
}

export default function Landing() {
  const { settings } = useSiteSettings();
  const [openFaq, setOpenFaq] = useState(0);
  const [teaser, setTeaser] = useState(null);
  const [year] = useState(() => new Date().getFullYear());

  // Cheapest plan per network, purely as a teaser for the real pricing
  // page. Deliberately fired AFTER first paint and allowed to fail
  // silently — the section falls back to a plain link to /pricing, so a
  // slow or empty catalogue never leaves a hole in the page.
  useEffect(() => {
    let alive = true;
    api.get('/catalog/pricing')
      .then((res) => {
        if (!alive || res?.status !== 'success') return;
        const nets = res.data?.networks || [];
        const rows = nets
          .map((n) => {
            const prices = n.plans.map((p) => Number(p.user || 0)).filter((v) => v > 0);
            if (!prices.length) return null;
            return { label: n.label, from: Math.min(...prices) };
          })
          .filter(Boolean)
          .slice(0, 4);
        setTeaser(rows.length ? rows : null);
      })
      .catch(() => { /* teaser is optional — never break the page over it */ });
    return () => { alive = false; };
  }, []);

  const channels = supportChannels(settings);
  const socials = socialLinks(settings);
  const hasApps = Boolean(APP_LINKS.android || APP_LINKS.ios);

  return (
    <div className="lp">
      {/* WCAG 2.4.1 — lets a keyboard user jump the nav on every page load. */}
      <a href="#lp-main" className="lp-skip">Skip to main content</a>

      {/* ── 1. Header ─────────────────────────────────────── */}
      <header className="lp-header">
        <div className="lp-container lp-header-inner">
          <Link to="/" className="lp-brand" aria-label="Datahood home">
            <img src="/logo-mark.png" alt="" width={32} height={32} className="brand-mark" />
            <span>Datahood</span>
          </Link>
          <nav className="lp-nav" aria-label="Primary">
            <a href="#services">Services</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </nav>
          <div className="lp-header-cta">
            <Link to="/login" className="btn btn-ghost btn-sm">Sign in</Link>
            <Link to="/register" className="btn btn-sm">Get started</Link>
          </div>
        </div>
      </header>

      <main id="lp-main">
        {/* ── 2. Hero ─────────────────────────────────────── */}
        <section className="lp-hero" aria-labelledby="lp-hero-h">
          <div className="lp-container lp-hero-inner">
            <p className="lp-eyebrow">Nigeria&apos;s everyday top-up wallet</p>
            <h1 id="lp-hero-h">
              Buy airtime and data,<br />pay bills, verify IDs —<br />
              <span className="lp-hero-accent">all in one wallet.</span>
            </h1>
            <p className="lp-hero-sub">
              Instant delivery on MTN, Glo, T2 and Airtel. Automatic refunds when an
              order fails. A dedicated bank account number so funding your wallet
              takes one transfer.
            </p>
            <div className="lp-hero-actions">
              <Link to="/register" className="btn">Create your free account</Link>
              <Link to="/pricing" className="btn btn-ghost">See our prices</Link>
            </div>
            <ul className="lp-hero-chips">
              <li><IcCheck size={15} /> Free to join</li>
              <li><IcCheck size={15} /> No documents needed</li>
              <li><IcCheck size={15} /> Delivered in seconds</li>
            </ul>
          </div>
        </section>

        {/* ── 3. Trust stats ──────────────────────────────── */}
        <section className="lp-stats" aria-label="my Website by the numbers">
          <div className="lp-container lp-stats-grid">
            {TRUST_STATS.map((s) => (
              <div key={s.label}>
                <div className="lp-stat-v">{s.value}</div>
                <div className="lp-stat-k">{s.label}</div>
              </div>
            ))}
          </div>
        </section>

        {/* ── 4. Services ─────────────────────────────────── */}
        <section id="services" className="lp-section" aria-labelledby="lp-services-h">
          <div className="lp-container">
            <header className="lp-section-head">
              <h2 id="lp-services-h">Everything you top up, in one place</h2>
              <p>Six services, one wallet, one balance. No juggling apps or hunting for a vendor.</p>
            </header>
            <div className="lp-cards">
              {SERVICES.map(({ icon: Icon, title, body }) => (
                <article key={title} className="lp-card">
                  <div className="lp-card-ic" aria-hidden="true"><Icon size={22} /></div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ── 5. Networks ─────────────────────────────────── */}
        <section className="lp-section lp-section-tint" aria-labelledby="lp-net-h">
          <div className="lp-container">
            <header className="lp-section-head">
              <h2 id="lp-net-h">Every Nigerian network</h2>
              <p>Whatever your customer uses, you can sell it from the same balance.</p>
            </header>
            <ul className="lp-networks">
              {NETWORKS.map((n) => (
                <li
                  key={n.name}
                  className="lp-network"
                  /* Falls back to the theme brand colour when tint is
                     null — see NETWORKS for why T2 has none. */
                  style={n.tint ? { '--net-tint': n.tint } : undefined}
                >
                  <span className="lp-network-dot" aria-hidden="true" />
                  {networkLabel(n.name)}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── 6. How it works ─────────────────────────────── */}
        <section id="how" className="lp-section" aria-labelledby="lp-how-h">
          <div className="lp-container">
            <header className="lp-section-head">
              <h2 id="lp-how-h">Up and running in three steps</h2>
              <p>From signing up to your first sale takes about two minutes.</p>
            </header>
            <ol className="lp-steps">
              {STEPS.map((s) => (
                <li key={s.n} className="lp-step">
                  <div className="lp-step-n" aria-hidden="true">{s.n}</div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── 7. Pricing teaser ───────────────────────────── */}
        <section id="pricing" className="lp-section lp-section-tint" aria-labelledby="lp-price-h">
          <div className="lp-container">
            <header className="lp-section-head">
              <h2 id="lp-price-h">Honest prices, published up front</h2>
              <p>
                No hidden markup and no &quot;message me for price&quot;. Every plan, every tier,
                on one page — before you sign up.
              </p>
            </header>
            {/* Renders only when the teaser actually loaded. The link below
                is always present, so the section is useful either way. */}
            {teaser && (
              <ul className="lp-price-teaser">
                {teaser.map((t) => (
                  <li key={t.label}>
                    <span className="lp-price-net">{t.label}</span>
                    <span className="lp-price-from">
                      from <strong>{formatNaira(t.from)}</strong>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="lp-center">
              <Link to="/pricing" className="btn">
                <IcTag size={16} /> View the full price list
              </Link>
            </div>
          </div>
        </section>

        {/* ── 8. Tiers ────────────────────────────────────── */}
        <section className="lp-section" aria-labelledby="lp-tiers-h">
          <div className="lp-container">
            <header className="lp-section-head">
              <h2 id="lp-tiers-h">Priced for resellers, not just buyers</h2>
              <p>
                Start free. Upgrade once, permanently, when the lower rates start paying
                for themselves.
              </p>
            </header>
            <div className="lp-tiers">
              {TIER_BENEFITS.map((t) => (
                <article key={t.name} className={`lp-tier${t.highlight ? ' is-highlight' : ''}`}>
                  {t.highlight && <span className="lp-tier-flag">Best rates</span>}
                  <h3>{t.name}</h3>
                  <p className="lp-tier-tag">{t.tagline}</p>
                  <ul>
                    {t.points.map((p) => (
                      <li key={p}><IcCheck size={15} /> {p}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
            <div className="lp-center">
              <Link to="/pricing" className="btn btn-ghost">Compare tier pricing</Link>
            </div>
          </div>
        </section>

        {/* ── 9. Identity verification ────────────────────── */}
        <section className="lp-section lp-section-tint" aria-labelledby="lp-verify-h">
          <div className="lp-container lp-split">
            <div>
              <h2 id="lp-verify-h">Identity verification, with a slip to prove it</h2>
              <p>
                Verify a NIN, BVN, drivers licence, international passport or vehicle
                record in seconds. Every successful check produces a downloadable PDF
                slip you can keep on file or hand straight to whoever asked for it.
              </p>
              <ul className="lp-ticks">
                <li><IcCheck size={16} /> Results in seconds, not days</li>
                <li><IcCheck size={16} /> Downloadable PDF slip every time</li>
                <li><IcCheck size={16} /> Charged from the same wallet balance</li>
              </ul>
            </div>
            <div className="lp-panel" aria-hidden="true">
              <div className="lp-panel-ic"><IcShield size={30} /></div>
              <div className="lp-panel-rows">
                <div className="lp-panel-row"><span>NIN</span><span className="lp-ok">Verified</span></div>
                <div className="lp-panel-row"><span>BVN</span><span className="lp-ok">Verified</span></div>
                <div className="lp-panel-row"><span>Drivers licence</span><span className="lp-ok">Verified</span></div>
                <div className="lp-panel-row"><span>Passport</span><span className="lp-ok">Verified</span></div>
              </div>
            </div>
          </div>
        </section>

        {/* ── 10. Wallet funding ──────────────────────────── */}
        <section className="lp-section" aria-labelledby="lp-wallet-h">
          <div className="lp-container lp-split lp-split-rev">
            <div className="lp-panel" aria-hidden="true">
              <div className="lp-acct">
                <div className="lp-acct-bank">Your dedicated account</div>
                <div className="lp-acct-no">0•• ••• ••••</div>
                <div className="lp-acct-name">Datahood / YOUR NAME</div>
              </div>
              <div className="lp-acct-note">Credits automatically, 24/7</div>
            </div>
            <div>
              <h2 id="lp-wallet-h">Fund your wallet with one transfer</h2>
              <p>
                You are issued a dedicated bank account number in your own name. Send
                money to it from any Nigerian bank app and your wallet credits by
                itself — no screenshots, no waiting for anyone to confirm your payment.
              </p>
              <ul className="lp-ticks">
                <li><IcCheck size={16} /> Works at any hour, including weekends</li>
                <li><IcCheck size={16} /> No proof of payment to upload</li>
                <li><IcCheck size={16} /> Balance updates the moment it lands</li>
              </ul>
            </div>
          </div>
        </section>

        {/* ── 11. Receipts ────────────────────────────────── */}
        <section className="lp-section lp-section-tint" aria-labelledby="lp-receipt-h">
          <div className="lp-container lp-narrow lp-center-text">
            <h2 id="lp-receipt-h">Receipts you can send to your own customer</h2>
            <p>
              Every transaction produces a clean, branded receipt as an image or a PDF.
              It shows the service, the reference and the status — and deliberately
              never shows what you paid, so you can forward it to your buyer without
              revealing your margin.
            </p>
          </div>
        </section>

        {/* ── 12. Why us ──────────────────────────────────── */}
        <section className="lp-section" aria-labelledby="lp-why-h">
          <div className="lp-container">
            <header className="lp-section-head">
              <h2 id="lp-why-h">Why people stay</h2>
              <p>The things that matter when real money is moving through an app every day.</p>
            </header>
            <div className="lp-cards">
              {WHY_US.map(({ icon: Icon, title, body }) => (
                <article key={title} className="lp-card">
                  <div className="lp-card-ic" aria-hidden="true"><Icon size={22} /></div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ── 13. Testimonials ──────────────────────────────
            Rendered only when there are real quotes to show. An empty
            "What our customers say" heading over blank space reads as a
            broken page; no section at all reads as a page that simply
            does not have that section yet. See TESTIMONIALS above for
            why it currently ships empty. */}
        {TESTIMONIALS.length > 0 && (
          <section className="lp-section lp-section-tint" aria-labelledby="lp-tm-h">
            <div className="lp-container">
              <header className="lp-section-head">
                <h2 id="lp-tm-h">What our customers say</h2>
              </header>
              <div className="lp-quotes">
                {TESTIMONIALS.map((t) => (
                  <figure key={t.name} className="lp-quote">
                    <blockquote><p>{t.quote}</p></blockquote>
                    <figcaption>
                      <span className="lp-quote-name">{t.name}</span>
                      <span className="lp-quote-role">{t.role}</span>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ── 14. Mobile app ──────────────────────────────── */}
        <section className="lp-section" aria-labelledby="lp-app-h">
          <div className="lp-container lp-narrow lp-center-text">
            <h2 id="lp-app-h">Works on your phone, today</h2>
            <p>
              Datahood runs in your browser and installs to your home screen like an
              app — no download required, and it stays out of your storage.
            </p>
            {hasApps ? (
              <div className="lp-app-btns">
                {APP_LINKS.android && (
                  <a className="btn" href={APP_LINKS.android} rel="noopener noreferrer" target="_blank">
                    Get it on Android <IcExternal size={14} />
                  </a>
                )}
                {APP_LINKS.ios && (
                  <a className="btn" href={APP_LINKS.ios} rel="noopener noreferrer" target="_blank">
                    Download on iOS <IcExternal size={14} />
                  </a>
                )}
              </div>
            ) : (
              <p className="lp-muted-note">Native Android and iOS apps are on the way.</p>
            )}
          </div>
        </section>

        {/* ── 15. FAQ ─────────────────────────────────────── */}
        <section id="faq" className="lp-section lp-section-tint" aria-labelledby="lp-faq-h">
          <div className="lp-container lp-narrow">
            <header className="lp-section-head">
              <h2 id="lp-faq-h">Questions people ask before signing up</h2>
            </header>
            <div className="lp-faq">
              {FAQS.map((f, i) => (
                <FaqItem
                  key={f.q}
                  id={`faq-${i}`}
                  item={f}
                  open={openFaq === i}
                  onToggle={() => setOpenFaq(openFaq === i ? -1 : i)}
                />
              ))}
            </div>
          </div>
        </section>

        {/* ── 16. Support ─────────────────────────────────── */}
        <section className="lp-section" aria-labelledby="lp-support-h">
          <div className="lp-container lp-narrow lp-center-text">
            <h2 id="lp-support-h">Talk to a real person</h2>
            <p>
              Got a question before you sign up, or a transaction you want checked?
              Reach us directly — no ticket number required.
            </p>
            {/* Only channels the admin has actually configured appear here.
                An empty WhatsApp button is worse than none: it looks like
                support exists and then goes nowhere. */}
            {channels.length > 0 ? (
              <div className="lp-channels">
                {channels.map((c) => (
                  <a
                    key={c.key}
                    className="lp-channel"
                    href={c.href}
                    {...(c.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                  >
                    <span className="lp-channel-k">{c.label}</span>
                    <span className="lp-channel-v">{c.value}</span>
                  </a>
                ))}
              </div>
            ) : (
              <p><Link to="/support" className="btn btn-ghost">Contact support</Link></p>
            )}
          </div>
        </section>

        {/* ── 17. Newsletter ──────────────────────────────── */}
        <section className="lp-section lp-section-tint" aria-labelledby="lp-news-h">
          <div className="lp-container lp-narrow lp-center-text">
            <h2 id="lp-news-h">Know before everyone else</h2>
            <p>
              New plans, price drops and service notices — sent when there is
              something worth reading, not on a schedule.
            </p>
            <NewsletterSignup />
            {/* The consent line sits under the form, not in a checkbox. A
                pre-ticked box is not consent and an unticked one is a second
                thing to click; a plain sentence saying exactly what happens
                next is both honest and what NDPR expects to see recorded. */}
            <p className="lp-news-note small muted" id="lp-news-note">
              We send a confirmation link first — you are only added if you
              click it. One click unsubscribes you from any email we send, and
              we never share or sell your address. See our{' '}
              <Link to="/privacy">privacy policy</Link>.
            </p>
          </div>
        </section>

        {/* ── 18. Final CTA ───────────────────────────────── */}
        <section className="lp-cta" aria-labelledby="lp-cta-h">
          <div className="lp-container lp-center-text">
            <h2 id="lp-cta-h">Start selling in the next five minutes</h2>
            <p>
              Creating an account is free, takes a minute, and needs no documents.
              You only pay for what you buy.
            </p>
            <div className="lp-hero-actions lp-center">
              <Link to="/register" className="btn btn-lg">Create your free account</Link>
              <Link to="/login" className="btn btn-ghost btn-lg">I already have one</Link>
            </div>
          </div>
        </section>
      </main>

      {/* ── 19. Footer ──────────────────────────────────── */}
      <footer className="lp-footer">
        <div className="lp-container">
          <div className="lp-footer-top">
            <div className="lp-footer-brand">
              <Link to="/" className="lp-brand" aria-label="Datahood home">
                <img src="/logo-mark.png" alt="" width={30} height={30} className="brand-mark" />
                <span>Datahood</span>
              </Link>
              <p>
                Airtime, data, bills and identity verification for Nigeria — from one
                wallet, delivered automatically.
              </p>
            </div>

            <nav className="lp-footer-col" aria-labelledby="lp-f-services">
              <h3 id="lp-f-services">Services</h3>
              <a href="#services">Data bundles</a>
              <a href="#services">Airtime</a>
              <a href="#services">Electricity</a>
              <a href="#services">Cable TV</a>
              
            </nav>

            <nav className="lp-footer-col" aria-labelledby="lp-f-company">
              <h3 id="lp-f-company">Company</h3>
              <Link to="/pricing">Pricing</Link>
              <a href="#faq">FAQ</a>
              <Link to="/support">Support</Link>
              <Link to="/terms">Terms of service</Link>
              <Link to="/privacy">Privacy policy</Link>
            </nav>

            <nav className="lp-footer-col" aria-labelledby="lp-f-account">
              <h3 id="lp-f-account">Account</h3>
              <Link to="/register">Create account</Link>
              <Link to="/login">Sign in</Link>
              <Link to="/forgot-password">Reset password</Link>
            </nav>
          </div>

          {socials.length > 0 && (
            <div className="lp-socials">
              {socials.map((s) => (
                <a key={s.key} href={s.href} target="_blank" rel="noopener noreferrer">{s.label}</a>
              ))}
            </div>
          )}

          <div className="lp-footer-bottom">
            <span>&copy; {year} Datahood. All rights reserved.</span>
            <span className="lp-footer-legal">
              <Link to="/terms">Terms</Link>
              <Link to="/privacy">Privacy</Link>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
