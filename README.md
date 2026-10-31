# DATAHOOD / KwaraPolyData

VTU (Virtual Top-Up) and identity-verification platform for
**kwarapolydata.com.ng**, migrated from a legacy PHP application to a
**Node.js + Express** API and a **React** single-page app.

Customers buy airtime, mobile data, electricity tokens and cable TV
subscriptions from a prepaid wallet, and run identity checks (NIN, BVN,
passport, driver's licence, voter's card, phone) that produce a downloadable
verified slip. Money enters the wallet through bank transfer to a reserved
virtual account, and leaves it through purchases that are fulfilled by
upstream provider APIs.

The legacy platform is treated as the source of truth for business
behaviour. Pricing tiers, transaction status codes, refund rules and the
exact request/response contracts used to talk to fulfilment providers were
preserved deliberately, because real customer balances and thirty thousand
historical transactions depend on them meaning the same thing they always
did.

---

## Stack

| Layer | Choice |
|---|---|
| API | Node.js 20.19+, Express 4, ES modules |
| ORM | Sequelize 6 over MySQL 8 (`mysql2`) |
| Auth | JWT (`jsonwebtoken`), bcrypt password + PIN hashing |
| Frontend | React 18, React Router 6, Vite 8 |
| Email | Resend HTTP API |
| Docs/testing | Postman collection in `backend/postman/` |

There is no TypeScript, no state-management library and no CSS framework in
the app itself. The `fetch` wrapper in `frontend/src/api/` attaches the JWT
and normalises errors; theming is plain CSS variables driven by `data-theme`
and `data-mode` on `<html>`.

---

## Layout

```
DATAHOOD PROJECT/
├── backend/
│   ├── server.js              Express bootstrap; every route mounts under /api
│   ├── config/                DB connection (Sequelize + TLS)
│   ├── models/                15 Sequelize models
│   ├── routes/                14 route modules
│   ├── controllers/           request handlers
│   ├── services/              email, OTP, payment, provider, verification,
│   │                          WhatsApp, health monitor
│   ├── middleware/            auth, rate limiting, idempotency
│   ├── utils/                 walletOps, crypto, logger, receipts, PIN
│   ├── sql/                   14 migration scripts (not in the repo)
│   ├── scripts/migrate.js     migration runner
│   └── postman/               API collection + environment template
└── frontend/
    ├── index.html             Vite entry
    ├── vite.config.js         build config, dev proxy, env inlining
    └── src/                   all .jsx — pages, components, context, hooks
```

`frontend/src-backup-before-jsx/` holds the pre-Vite `.js` originals. It is
retained on purpose as the reference for rebuilding the remaining legacy PHP
surface, not as a stale copy to delete.

---

## Requirements

**Node.js 20.19+ or 22.12+.** Vite 8 uses Rolldown and will not install on
Node 18. Check with `node -v` before anything else — a version error here
surfaces later as confusing native-binding failures.

MySQL 8. The project currently points at a managed instance; any MySQL 8
with InnoDB works.

---

## Setup

### 1. Backend

```bash
cd backend
cp .env.example .env      # then fill it in — see the table below
npm install
npm run db:migrate        # creates/updates every table
npm run dev               # nodemon, http://localhost:5000
```

`npm run db:migrate` applies everything in `sql/` in dependency order — not
alphabetically, because columns must exist before the seeds that populate
them, and the collation fix has to run last. It is safe to re-run: MySQL 8
has no `ADD COLUMN IF NOT EXISTS`, so re-applying raises errors 1050, 1060
and 1061, which the runner reports as "already applied" rather than
failures.

> **`backend/sql/` is not published in this repository.** The migration
> scripts describe the table layout, seeded pricing tiers and business rules
> of a live payments platform, so they are kept out of version control
> alongside the database dumps and `.env` files. They exist on disk and the
> command above works normally for anyone with the working directory — but a
> fresh `git clone` will not contain them, and cannot build the schema
> without them. **Back that folder up outside the project: git is not the
> safety net for it.**

```bash
node scripts/migrate.js --list                  # show order, run nothing
node scripts/migrate.js otp_codes_table.sql     # one file
```

Run it from `backend/`. It loads `.env` relative to the working directory,
so running it from the repo root fails to connect.

Restart the API afterwards — the connection pool caches table metadata, and
a stale pool against a changed schema produces "all the rows are gone"
symptoms that are really just a schema mismatch.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev               # http://localhost:3000
```

No `.env` is needed for local development. The Vite dev server proxies
`/api` to `http://localhost:5000`, so the browser stays same-origin and CORS
never enters the picture.

---

## Environment variables

`backend/.env` — never committed. See `backend/.env.example` for the full
list with placeholder values.

| Variable | Purpose |
|---|---|
| `PORT`, `NODE_ENV` | server basics |
| `CLIENT_ORIGINS` | comma-separated CORS allowlist |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | MySQL connection |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | token signing |
| `APP_ENCRYPTION_KEY` | AES-256-GCM key for provider secrets at rest |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_FROM_NAME` | transactional email |
| `ADMIN_ALERT_EMAIL` | operational alerts |
| `VAPID_*` | web push |
| `WEBAUTHN_*` | passkey login |
| `MONNIFY_*`, `PAYSTACK_SECRET_KEY` | wallet funding gateways |
| `WHATSAPP_*`, `TERMII_*` | notifications |

`frontend/.env.production` is required only for production builds:

```
VITE_API_URL=https://api.example.com/api
```

**The production build deliberately fails when this is unset.** That guard
exists because a build once shipped with no env file, silently inlined a
`localhost` fallback, and broke login on every phone while working perfectly
on the machine that built it. `localhost` is device-relative; a bundle
carrying it is unreachable from anywhere else. A build-time error is loud
and impossible to deploy past.

Verify what actually got inlined before uploading:

```bash
grep -o "https\?://[a-zA-Z0-9.:-]*/api" build/assets/*.js | sort -u
```

Everything in a frontend env file is inlined into a public browser bundle,
so it can only ever hold non-secret values like a hostname.

---

## API

Every route is mounted under `/api`, so an API base without that suffix
404s on every call. Rate limiting is applied at the same mount point.

| Area | Covers |
|---|---|
| `auth` | register, login, OTP, password reset |
| `profile`, `users` | profile, PIN, themes, admin user management |
| `airtime`, `data`, `bills` | purchases (bills covers electricity + cable) |
| `wallet`, `payment` | balance, ledger, virtual accounts, gateway webhooks |
| `verify` | identity checks and saved records |
| `catalog`, `plans`, `sales` | networks, plan management, reporting |
| `providers`, `blacklist` | admin provider config, blocked numbers |

Import `backend/KwaraPolyData.postman_collection.json` plus the environment
template — see `backend/postman/README.md`. The collection holds no
credentials by design; tokens live in a git-ignored environment.

---

## How money is handled

These are the invariants worth knowing before changing anything in the
purchase path.

**Wallet balances are never mutated directly.** All debits, credits and
refunds go through `utils/walletOps.js`, which performs the arithmetic
atomically. Writing to the balance column from a controller bypasses the
audit trail and races with concurrent requests.

**Purchases are idempotent.** `middleware/idempotency.js` inserts a key as a
lock before fulfilment, so a double-tapped button or a retried request
cannot debit twice.

**Transaction status codes are inherited from the legacy platform:** `0`
successful, `1` refunded, `2` failed, `5` processing.

**Refund policy is preserved from the original system:** airtime,
electricity and verification are refunded on failure; data and cable are
not. A refunded transaction shows equal before/after balances — unequal
balances on a failed transaction mean the debit was never returned and needs
manual attention.

**Provider credentials are encrypted at rest** with AES-256-GCM. Only a
masked hint is returned to any client, and keys are re-encrypted solely when
a new value is supplied, so a blank field means "keep existing" rather than
"erase".

**Provider and internal diagnostics never reach the user.** Failures are
mapped to safe copy through `utils/publicErrors.js`.

---

## Security

Do not commit: `.env` files, database dumps, schema migrations, or a filled
Postman environment. `.gitignore` blocks all four, each verified with
`git check-ignore`.

The `.sql` dumps in the project root contain live customer PII — names,
emails, phone numbers, bank account numbers and legacy password hashes —
alongside a production payment-gateway key. They are git-ignored and must
stay that way. Re-check before adding any remote.

Passwords and transaction PINs are bcrypt-hashed and never stored or logged
in plaintext. Logging is file-only; nothing sensitive goes to the console.
All database access is through Sequelize with bound parameters, never string
concatenation.

`SECURITY-AUDIT.md` records what has been reviewed and what remains open.

---

## Further reading

| Document | Contents |
|---|---|
| `DEPLOYMENT.md` | production deployment, split frontend/API origins |
| `SECURITY-AUDIT.md` | findings and remediation status |
| `ACTION-REQUIRED.md` | outstanding operational tasks |
| `backend/README.md` | backend setup and route detail |
| `backend/postman/README.md` | API collection and environment setup |
| `frontend/MOBILE-TESTING.md` | testing on a real phone over ngrok |
| `frontend/MIGRATION-VITE.md` | the CRA-to-Vite migration record |

---

Author: **Dhammy**. Licence: MIT.
