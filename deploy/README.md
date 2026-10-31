# Hosting DATAHOOD — what this app actually needs, and what it costs

Written from the code, not from a hosting brochure. Four properties of this
codebase rule out most of the cheap options people are usually pointed at, so
they come first — if a host cannot do these four things, the price does not
matter.

## The four hard constraints

**1. One always-on process. Not serverless, not scale-to-zero.**
`services/retentionService.js` runs the NDPA retention purge on an in-process
`setInterval` (24h). On any platform that sleeps an idle app or spins up a
fresh worker per request, that timer silently never fires. It is legal
compliance machinery, and its failure mode is *silence* — nothing errors, the
purge just stops happening. This rules out Vercel/Netlify functions, Cloudflare
Workers, and the free tiers of Render/Railway that idle out.

**2. Exactly one instance, until two things are fixed.**
`middleware/rateLimit.js` declares **14** limiters and none of them passes a
`store:` option, so every one uses express-rate-limit's default in-memory
store. Run two copies and every limit doubles — the login guard becomes 16
attempts per 15 minutes instead of 8, and the counters do not survive a
restart. Two copies also means two concurrent retention sweeps over the same
rows. Horizontal scaling needs a shared store (Redis) *before* the second
instance exists, not after.

**3. A static outbound IP.**
Your fulfilment providers whitelist server IPs — Premiumsub returns an HTML
"Access denied" page to unknown addresses, which surfaces in the app as a JSON
parse error rather than anything that says "IP". Platforms that rotate egress
IPs (most PaaS free/hobby tiers) will break purchases intermittently and
inexplicably. A VPS gives you one fixed IPv4 forever.

**4. A writable, persistent disk.**
`utils/logger.js` is the only thing in the backend that touches the filesystem,
and it appends one file per level per day. On an ephemeral filesystem you lose
your logs on every restart — which is precisely when you need them.

## Recommendation

**A single small VPS running nginx + Node + MySQL together.** It satisfies all
four constraints at the lowest price available, and it fixes a fifth problem
you have already been bitten by.

That fifth problem: your database is currently at
`…c.aivencloud.com` — a *remote* managed MySQL reached over the public
internet, with `pool.min: 0`. An idle app drops its connections and re-dials
across an ocean on the next request. That is the environment that produced the
spurious-logout bug: a connection failure surfaced as `401` and signed users
out. The retry logic added to `config/database.js` treats the symptom. Moving
MySQL onto the same box as the app makes the connection a loopback socket and
retires the entire class of failure.

Worth checking urgently: [Aiven's free MySQL tier](https://aiven.io/docs/products/mysql/concepts/mysql-free-tier)
is capped at **1 GB of storage** and is **powered off automatically after a
period of inactivity**. If that is the plan you are on, it is not merely a
latency issue — it is a database that switches itself off, and it would explain
connection failures that appear at random after quiet periods.

### Cost

| | Spec | Price |
|---|---|---|
| **Hetzner CX-class** (recommended) | 2 vCPU / 4 GB / 40 GB NVMe, 20 TB traffic | ~€4.50–5.50/mo |
| Contabo | 4 vCPU / 8 GB, more RAM per naira | ~$4.50–6.60/mo |
| RackNerd | 2 GB plan, promo pricing | ~$2.70–3.49/mo |
| Lagos-based (Lineserve, Hostraha, Melbicom) | varies | higher, billed in ₦ |

Hetzner raised prices in June 2026 and the CX line was renamed, so confirm the
current number on hetzner.com before you commit — reported figures disagree.

Two honest caveats on the cheap European options:

- **They bill in EUR/USD and need a card that works internationally.** This is
  the single most common reason a Nigerian deployment ends up on a local host
  instead. If your card is refused, that decides it — go local.
- **No African region.** Lagos → Frankfurt is roughly 60–100 ms. Fine for this
  app (one API call per user action, not twenty), but a Lagos data centre would
  be single-digit ms and keeps data in-country, which is the cleaner NDPA
  story given the compliance work already done. Pay for that if the budget
  allows; do not pay for it at the cost of skipping backups.

**Contabo and RackNerd are cheaper per GB of RAM but oversell aggressively.**
For a wallet application where a stalled request can strand a transaction
mid-flight, the extra ~$2/month for Hetzner's consistency is the best money in
this entire budget.

## What is in this folder

| File | Purpose |
|---|---|
| `setup-server.sh` | One-time provisioning of a fresh Ubuntu 24.04 box. Idempotent. |
| `nginx.conf` | Serves the React build, proxies `/api` to Node. |
| `datahood-api.service` | systemd unit — restart on crash, start on boot. |
| `deploy.sh` | Build, migrate, restart, health-check. Re-run for every update. |
| `backup-db.sh` | Nightly `mysqldump`, for when the database is on this box. |

### Why nginx in front, rather than letting Node serve everything

`server.js` has no `express.static` — it never serves the React build. So
something must. Putting nginx there means the site and the API share **one
origin**: the page is `https://your-domain` and the API is
`https://your-domain/api`.

That is not just tidiness. `frontend/src/config.jsx` falls back to a
same-origin `/api` when no `VITE_API_URL` is set — so on this layout that
variable never needs to exist. A missing build-time API URL once baked
`localhost` into the production bundle and broke every login on mobile. A
relative path cannot have that bug. It also means the browser never makes a
cross-origin request, so CORS stops being the thing standing between your users
and a blank screen.

### Order of operations

```bash
# on the server, as root
bash setup-server.sh datahood your-domain.com.ng
# → point DNS at the box, then:
certbot --nginx -d your-domain.com.ng -d www.your-domain.com.ng
# → fill in /etc/datahood/api.env  (0600, root-only)
bash deploy.sh datahood
```

Then, and this is the step people skip: **give your providers the server's
IPv4 to whitelist**, and point the Monnify/Paystack webhook at
`https://your-domain.com.ng/api/payment/webhook`.

### Secrets

`/etc/datahood/api.env` is `0600` and owned by root. systemd reads it *before*
dropping to the unprivileged app user, so the application itself never has
permission to read its own secrets file. Generate `JWT_SECRET` and
`APP_ENCRYPTION_KEY` fresh **on the server** — do not carry the development
values across.

Related and overdue: the two `.sql` dumps in the repository root contain a live
Monnify key and customer PII. They are gitignored, so this is an on-disk
exposure rather than a published one, but that key should be rotated and the
dumps moved off the working tree regardless of which host you choose.

## If you outgrow one box

In order, and only when something actually hurts:

1. Move MySQL to its own VPS (keep it on a private network, never public 3306).
2. Swap the rate-limiter store to Redis — **required** before a second app
   instance.
3. Move the retention job out of `setInterval` and into a systemd timer, so it
   is owned by the OS rather than by whichever process happens to be running.

Only then does a second app instance make sense.
