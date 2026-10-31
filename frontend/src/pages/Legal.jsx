import { Link } from 'react-router-dom';
import { PublicShell } from '../components/PublicShell';
import { useSiteSettings, supportChannels } from '../hooks/useSiteSettings';

// Note: the <link rel="canonical"> for /terms and /privacy is applied
// centrally by App.jsx on every route change, so these pages must NOT
// set it themselves — doing so would be a side effect during render and
// would fight the route-driven effect that already handles it.

// Mirrors backend/config/policy.js — see the versioning note above.
const POLICY_EFFECTIVE = '1 November 2026';

/** Retention windows — mirror services/retentionService.js defaults. */
const REDACT_DAYS = 90;
const PURGE_DAYS = 365;

// ------------------------------------------------------------
//  Shared bits
// ------------------------------------------------------------

function Effective() {
  return (
    <p className="lp-legal-meta">
      <strong>Effective {POLICY_EFFECTIVE}.</strong> We will post any change on
      this page and update this date. If a change materially affects your
      rights, we will tell you before it takes effect.
    </p>
  );
}

/**
 * Contact block built from configured support channels.
 *
 * Uses whatever the operator has actually set, and falls back to the
 * support page rather than printing an invented address. A legal
 * document that lists a dead contact route is a document that denies
 * people the rights it grants them.
 */
function ContactBlock() {
  const { settings } = useSiteSettings();
  const channels = supportChannels(settings).filter((c) => c.key === 'email' || c.key === 'whatsapp' || c.key === 'phone');

  return (
    <>
      <p>
        For anything in this document — a question, a complaint, or a request
        about your data — reach us at:
      </p>
      {channels.length > 0 ? (
        <ul>
          {channels.map((c) => (
            <li key={c.key}>
              {c.label}:{' '}
              <a href={c.href} {...(c.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                {c.value}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <p>
        You can also use the <Link to="/support">support page</Link>, which always
        shows our current channels.
      </p>
      <p>
        If you are not satisfied with how we handle a data protection concern,
        you have the right to complain to the Nigeria Data Protection Commission
        (NDPC) at{' '}
        <a href="https://ndpc.gov.ng" target="_blank" rel="noopener noreferrer">ndpc.gov.ng</a>.
      </p>
    </>
  );
}

// ============================================================
//  TERMS OF SERVICE
// ============================================================

export function Terms() {
  return (
    <PublicShell title="Terms of Service">
      <Effective />

      <p>
        These terms are the agreement between you and Noblesmegadata ("we", "us")
        covering your use of our website and services. By creating an account
        you accept them. Please read them — particularly section 6, which
        explains when a transaction can fail and what we do about it, and
        section 9, which limits what we are responsible for.
      </p>

      <h2>1. Who can use Noblesmegadata</h2>
      <p>
        You must be at least 18 years old and legally able to enter a contract.
        You must register with your own accurate details. Accounts registered
        with someone else's identity, or with details we cannot verify, may be
        suspended.
      </p>
      <p>
        One person, one account. If you operate as a reseller or agent, your
        account is still yours — you remain responsible for everything done
        through it.
      </p>

      <h2>2. Your account and security</h2>
      <p>
        You are responsible for keeping your password and transaction PIN
        secret. We will never ask you for either, by phone, WhatsApp, email or
        any other channel. Anyone asking you for them is not us.
      </p>
      <p>
        Transactions confirmed with your correct PIN are treated as authorised
        by you. Tell us immediately if you believe someone else has access to
        your account, and change your password — doing so signs out every other
        device.
      </p>

      <h2>3. What we provide</h2>
      <p>
        Noblesmegadata lets you buy airtime and mobile data, pay electricity and cable
        television bills, and run identity verification checks, funded from a
        wallet balance you top up in advance.
      </p>
      <p>
        We are a reseller. The airtime, data and bill payments are delivered by
        the mobile networks and billers themselves through our fulfilment
        partners, and identity checks are answered by a licensed verification
        provider. We do not control their systems or their uptime.
      </p>

      <h2>4. Your wallet</h2>
      <p>
        Your wallet holds a prepaid balance. It is not a bank account, it earns
        no interest, and we are not a deposit-taking institution. Money enters
        it when a payment you make through our payment partner is confirmed.
      </p>
      <p>
        Referral earnings are credited to a separate referral balance. Referral
        bonuses are a promotional benefit — we may change or end the referral
        programme at any time, though we will not remove bonuses you have
        already earned.
      </p>
      <p>
        We may hold, reverse or refuse a transaction where we reasonably suspect
        fraud, a duplicated or erroneous credit, or a breach of these terms. If
        we do, we will tell you why.
      </p>

      <h2>5. Pricing</h2>
      <p>
        Prices are shown before you confirm any purchase, and the amount shown
        at confirmation is the amount deducted. Prices can change without notice
        — networks providers adjust their rates — but a change never applies retroactively
        to a transaction you have already completed.
      </p>

      <h2>6. When a transaction fails</h2>
      <p>
        This is the part worth reading carefully, because it is the situation
        people actually encounter.
      </p>
      <p>
        A purchase can fail after your wallet has been debited: the network may
        reject it, or a provider may time out. When that happens the debit is
        reversed automatically and the amount returns to your wallet. Your
        transaction history shows the balance before and after each transaction,
        so you can see the reversal.
      </p>
      <p>
        A transaction may also sit in a pending state while we wait for a
        network to confirm delivery. Pending is not failure — please wait before
        retrying, because a retry can result in two successful deliveries and
        two debits.
      </p>
      <p>
        If a transaction fails and the amount does not return within 24 hours,
        contact us with the transaction reference and we will resolve it. Where
        a debit is confirmed to have been taken without the service being
        delivered, we refund it to your wallet.
      </p>
      <p>
        We cannot reverse a delivery that succeeded. If you send airtime or data
        to the wrong number, the value has reached that number and we have no
        way to retrieve it — <b>check the number before confirming</b>.
      </p>

      <h2>7. Identity verification checks</h2>
      <p>
        Identity verification is a paid lookup against official databases,
        answered by our verification provider. Two conditions apply, and both
        matter legally.
      </p>
      <p>
        First, you must have a lawful basis to run a check on another person.
        Looking up someone's NIN or BVN out of curiosity, to monitor them, or
        without their knowledge and consent is unlawful under the Nigeria Data
        Protection Act, and doing it through us is a breach of these terms. By
        running a check <b>you confirm you have that basis</b>. <b>Accounts used for
        unlawful lookups are closed, and we cooperate with lawful requests from
        the authorities.</b>
      </p>
      <p>
        Second, a check is charged when the lookup is performed, whether or not
        the record is found. A "no record found" answer is a result, not a
        failure — we were charged for the query and so are you. Failed
        checks, where the provider never returned an answer at all, are
        reversed as in section 6.
      </p>
      <p>
        We keep verification results for a limited time and then delete them —
        see the Privacy Policy. Download any slip you need soon after running
        the check.
      </p>

      <h2>8. Things you must not do</h2>
      <p>
        Do not use Noblesmegadata for fraud, money laundering, or any illegal purpose.
        Do not attempt to gain unauthorised access to our systems, probe them for
        vulnerabilities, scrape them, or interfere with other users' accounts.
        Do not resell identity verification checks to people who lack a lawful
        basis to run them. Do not use automated tools against our API beyond the
        limits we set.
      </p>
      <p>
        We may suspend or close an account that breaches these terms. Where we
        do, any legitimate remaining wallet balance is returned to you.
      </p>

      <h2>9. Availability and our responsibility</h2>
      <p>
        We work to keep the service running, but we do not guarantee
        uninterrupted availability. Networks go down, providers have outages,
        and maintenance happens.
      </p>
      <p>
        Where we are responsible for a loss, our liability is limited to the
        value of the transaction concerned. We are not liable for indirect or
        consequential losses — for example, business you lost because a purchase
        was delayed. Nothing here limits liability that cannot be limited by
        Nigerian law, including liability for our own fraud.
      </p>

      <h2>10. Closing your account</h2>
      <p>
        You can close your account at any time from{' '}
        <strong>Profile &amp; Settings → Security → Close my account</strong>.
        Withdraw or spend your wallet balance first — we will not close an
        account that still holds your money, because we would then be holding
        funds we can no longer return to you.
      </p>
      <p>
        What closing an account actually deletes, and what we are required to
        keep, is set out plainly in the <Link to="/privacy">Privacy Policy</Link>.
      </p>

      <h2>11. Changes to these terms</h2>
      <p>
        We may update these terms. The effective date at the top changes when we
        do, and material changes are announced before they take effect.
        Continuing to use the service after that means you accept the updated
        terms.
      </p>

      <h2>12. Governing law</h2>
      <p>
        These terms are governed by the laws of the Federal Republic of Nigeria,
        and the Nigerian courts have jurisdiction over any dispute. We would
        much rather resolve a problem directly — please contact us first.
      </p>

      <h2>13. Contact</h2>
      <ContactBlock />
    </PublicShell>
  );
}

// ============================================================
//  PRIVACY POLICY
// ============================================================

export function Privacy() {
  return (
    <PublicShell title="Privacy Policy">
      <Effective />

      <p>
        This policy explains what personal data Noblesmegadata collects, why, who we
        share it with, how long we keep it, and what you can do about it. It is
        written to match what our systems actually do. We are the data
        controller for the information described here, and we handle it in line
        with the Nigeria Data Protection Act 2023.
      </p>

      <h2>1. What we collect</h2>

      <h3>Information you give us</h3>
      <p>
        When you register: your first and last name, email address, phone
        number, and state of residence. When you set up your account: a
        password and a 4-digit transaction PIN, both of which we store only as
        one-way hashes — we cannot read either of them back, and neither can
        our support team.
      </p>
      <p>
        If someone referred you, we record the referrer's phone number so the
        referral bonus can be paid.
      </p>

      <h3>Information created by using the service</h3>
      <p>
        Your wallet balance and referral balance; a ledger of every credit and
        debit showing the amount and the balance before and after; and your
        transaction history — the reference, what was bought, the amount, the
        status, the date, and the beneficiary detail you entered, such as the
        phone number, meter number or smartcard number being topped up.
      </p>
      <p>
        Bank account details you provide for payouts, and the details of any
        virtual account we reserve for you so that bank transfers credit your
        wallet automatically.
      </p>

      <h3>Identity verification data</h3>
      <p>
        This is the most sensitive category we handle, so we are specific about
        it. When you run a check we record the type of check, the ID number
        queried, and the result returned by the provider — which for NIN, BVN,
        passport and driver's licence checks includes the person's full name,
        date of birth, gender, address and photograph.
      </p>
      <p>
        The ID number and the name returned are <strong>encrypted at rest</strong>
        {' '}using AES-256-GCM, not stored as readable text.
      </p>
      <p>
        Often the person checked is not you. We know that, and it is why these
        records have the shortest retention period on the platform (section 5)
        and why running a check without a lawful basis breaches our terms.
      </p>

      <h3>Technical and security information</h3>
      <p>
        The IP address you registered from, recorded as part of your consent;
        the IP address a one-time code was requested from; device fingerprints
        and any devices you mark as trusted; registered fingerprint or
        security-key credentials, stored as public keys that cannot be used to
        reproduce your fingerprint; and a push notification token if you enable
        notifications.
      </p>
      <h3>Your own BVN or NIN, if you open a funding account</h3>
      <p>
        If you choose to generate a dedicated bank account for funding your
        wallet, we ask for your BVN or NIN, together with the first name, last
        name and phone number registered against it. This is a legal
        requirement placed on the licensed bank that issues the account, not a
        preference of ours: under CBN rules an account cannot be opened in your
        name without a verified identity, so a funding account cannot be
        created without it.
      </p>
      <p>
        We pass these details straight to the payment provider that opens the
        account and we <strong>do not store your BVN or NIN</strong> — not
        encrypted, not partially, not in our logs. All we keep is a record that
        an identity was accepted, the date, and whether it was a BVN or a NIN.
        You can see those three facts for yourself in your data export, and you
        will find no ID number in it, because there is none to give. If you
        never generate a funding account, we never ask for it, and you can fund
        your wallet by other means instead.
      </p>
      <p>
        We also do not store card numbers — card details are entered on our
        payment partner's page and never reach our servers.
      </p>

      <h2>2. Why we use it, and our lawful basis</h2>
      <p>
        To provide the service you asked for — delivering purchases, keeping
        your wallet accurate, showing your history, sending receipts. That is
        performance of our contract with you.
      </p>
      <p>
        To keep accounts secure and prevent fraud — one-time codes, PIN lockouts,
        duplicate-purchase protection, device records. That is our legitimate
        interest, and yours.
      </p>
      <p>
        To meet legal and financial record-keeping obligations, and to respond to
        lawful requests from regulators or law enforcement.
      </p>
      <p>
        To send you marketing email, only if you have subscribed. That is
        consent, and you can withdraw it at any time using the unsubscribe link
        in any such email. We do not need your consent to send transactional
        messages like receipts or password resets, and unsubscribing does not
        stop those.
      </p>

      <h2>3. Who we share it with</h2>
      <p>
        We do not sell your personal data. We never have and we will not. We
        share it only with the partners needed to deliver what you asked for:
      </p>
      <ul>
        <li>
          <strong>Payment partner</strong> — to reserve your virtual account and
          confirm your wallet funding. They receive your name, phone number and
          email address, and they keep their own record of it under their own
          retention rules, which we do not control.
        </li>
        <li>
          <strong>Fulfilment partners</strong> — the mobile networks and billers,
          via our VTU partner. They receive the beneficiary number being topped
          up, which is what makes delivery possible.
        </li>
        <li>
          <strong>Identity verification provider</strong> — receives the ID
          number you are checking, and returns the record.
        </li>
        <li>
          <strong>Email provider</strong> — delivers receipts, one-time codes and
          any newsletter you subscribed to, and therefore handles your email
          address.
        </li>
      </ul>
      <p>
        We also disclose data where the law requires it. Where a partner
        processes data outside Nigeria, we rely on the transfer safeguards
        permitted under the Nigeria Data Protection Act.
      </p>

      <h2>4. How we protect it</h2>
      <p>
        The site is served over HTTPS, so traffic between your device and us is
        encrypted in transit. Passwords and PINs are stored as bcrypt hashes,
        never in readable form. Identity numbers and verification names are
        encrypted at rest with AES-256-GCM. Access to production data is
        restricted to the staff who need it.
      </p>
      <p>
        Sensitive actions — changing your password, downloading your data,
        closing your account — require your password again, even when you are
        already signed in, so a borrowed unlocked phone is not enough. Changing
        your password signs out every other device.
      </p>
      <p>
        No system is perfectly secure. If a breach affects your personal data,
        we will notify you and the NDPC as the law requires.
      </p>

      <h2>5. How long we keep it</h2>
      <p>
        <strong>Identity verification records.</strong> After{' '}
        <strong>{REDACT_DAYS} days</strong> we delete the result details — the
        photograph, date of birth, address and full provider response. After{' '}
        <strong>{PURGE_DAYS} days</strong> we delete the ID number and name as
        well, leaving only a record that a check was run and charged for. The
        person whose identity was checked usually never had an account with us
        and never agreed to anything, so the only meaningful protection we can
        offer them is not to keep their data. This deletion is automatic and
        runs daily. Download any slip you need soon after running the check.
      </p>
      <p>
        <strong>One-time codes</strong> are deleted within days of being issued.
      </p>
      <p>
        <strong>Transaction and wallet records</strong> are kept for as long as
        financial record-keeping requires, including after you close your
        account — but stripped of what identifies you, as described next.
      </p>
      <p>
        <strong>Your account details</strong> are kept while your account is open
        and erased when you close it.
      </p>

      <h2>6. Your rights</h2>
      <p>
        Under the Nigeria Data Protection Act you have the right to access your
        data, correct it, have it erased, object to how we use it, and complain
        to the regulator. Two of these are built into the app so you do not have
        to ask anyone:
      </p>
      <p>
        <strong>Get a copy of your data.</strong> Go to{' '}
        <strong>Profile &amp; Settings → Security → Download my data</strong>.
        You will get a file containing your profile, consent record, wallet and
        transaction history, virtual accounts, verification history and
        newsletter status. It excludes your password and PIN hashes and your API
        key — those are credentials, not readable data, and echoing them back
        would create a risk rather than serve a right.
      </p>
      <p>
        <strong>Close your account and erase your details.</strong> Go to{' '}
        <strong>Profile &amp; Settings → Security → Close my account</strong>.
        This is the section where we would rather be blunt than reassuring:
      </p>
      <p>
        Erasure permanently deletes your identity verification history, your
        one-time codes, your virtual account records and your newsletter
        subscription, and blanks your name, email, phone number, bank details
        and security credentials from your account. Every device you are signed
        in on is signed out.
      </p>
      <p>
        We <strong>keep</strong> your transaction and wallet ledger rows, because
        they are financial records that have to reconcile. What we keep is a
        shell: the amounts, dates and references remain, and we strip the
        beneficiary phone and meter numbers out of the descriptions so third
        parties are not left identifiable in them. Your name is not attached to
        any of it. We would rather tell you exactly this than claim a total
        deletion we cannot honestly perform.
      </p>
      <p>
        To correct your details, or to exercise any right not built into the
        app, contact us using the details in section 9. We respond within 30
        days.
      </p>

      <h2>7. Your consent record</h2>
      <p>
        When you registered, we recorded the date, the IP address you registered
        from, and which version of these documents you agreed to. We keep that
        so that if the policy changes later, we can still show what you actually
        agreed to at the time rather than what the current version says. It
        appears in your data export.
      </p>
      <p>
        Accounts created before {POLICY_EFFECTIVE} predate this record, so no
        consent evidence exists for them. We have deliberately not back-filled
        it — inventing a consent record would defeat its entire purpose.
      </p>

      <h2>8. Cookies and local storage</h2>
      <p>
        We use your browser's local storage to keep you signed in and to
        remember your theme and display preferences. We do not use advertising
        or cross-site tracking cookies, and we do not run third-party ad
        trackers. Clearing your browser storage signs you out.
      </p>

      <h2>9. Contact</h2>
      <ContactBlock />

      <h2>10. Changes to this policy</h2>
      <p>
        We will post any change here and update the effective date. If a change
        materially affects how we use your data, we will tell you before it
        takes effect rather than relying on you re-reading this page.
      </p>
    </PublicShell>
  );
}
