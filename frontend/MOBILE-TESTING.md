# Testing on a real phone (ngrok)

Current setup: Express runs on your PC (`NODE_ENV=development`, port 5000),
MySQL is remote on Aiven, and there is **no deployed backend yet**. This is
how to exercise the app from a phone until you buy hosting.

## Tunnel port 3000, not 5000

Point ngrok at the **Vite dev server**, not Express:

```bash
ngrok http 3000
```

The phone loads the app from the tunnel and calls `/api` on that same
origin; Vite proxies it to Express on :5000. One tunnel, no CORS, and
nothing to reconfigure when the URL changes.

Tunnelling :5000 instead would mean two tunnels — which free ngrok does not
allow — plus a CORS entry and an API base that goes stale.

## Run it

Two terminals:

```bash
# 1 — backend  (npm start also works; dev adds nodemon reload)
cd backend && npm run dev

# 2 — frontend
cd frontend && npm run dev
```

Then `ngrok http 3000`, and open the `https://….ngrok-free.dev` URL on the
phone. First visit shows an ngrok interstitial; click through it.

For hot reload over the tunnel, set `VITE_DEV_TUNNEL=1` in `frontend/.env`
— it repoints HMR's websocket at 443. Without it the app still works, the
console just fills with failed reconnects.

### Faster alternative, no tunnel

Both devices on the same wifi: find your PC's LAN IP (`ipconfig`) and open
`http://192.168.x.x:3000` on the phone. `server.host: true` is already set.
Works for layout and flows, but it's plain HTTP — no service worker, no
push, no WebAuthn, since those need a secure context.

## Why the subdomain is not hardcoded

Free ngrok issues a **new random subdomain on every restart**. A URL written
into the config works until the tunnel drops and then fails exactly like the
original mobile-login outage. `config.js` falls back to a relative `/api` on
any non-localhost host, which is right regardless of subdomain — so nothing
needs editing between sessions.

## Gotchas

- **"Blocked request. This host is not allowed."** — Vite host check.
  Already handled via `server.allowedHosts` (`.ngrok-free.dev` and friends).
  If ngrok moves to a new domain suffix, add it there.
- **Login works on desktop, fails on the phone** — the old bug: a bundle
  containing `localhost:5000`. On a phone `localhost` is the phone. Only
  affects `npm run build` output; `npm run dev` is unaffected.
- **Transactions hit REAL providers.** `.env` carries live Monnify and
  Premiumsub credentials, and the Premiumsub IP whitelist is keyed to your
  current IP — a tunnel does not change your server's outbound IP, so
  fulfilment still works. Test with the smallest possible amounts.
- **Webhooks won't arrive.** Monnify/PaymentPoint callbacks are configured
  to a public URL that doesn't exist yet, so wallet funding by transfer
  will not confirm automatically while tunnelling. Card/manual flows and
  purchases from an existing balance are unaffected.

## Going live later

Nothing in this file applies to production. See `.env.production` — the
build intentionally fails until `VITE_API_URL` names a real backend host.
