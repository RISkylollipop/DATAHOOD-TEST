# Postman

`../KwaraPolyData.postman_collection.json` is the request collection. It is
tracked in git and deliberately contains **no credentials** — the only
variable defined on the collection itself is `baseUrl`.

Everything else (`token`, `adminToken`, `blacklistId`, `providerId`,
`transref`, `vId`) lives in a Postman **environment**, which is git-ignored.

## Why the split

Postman writes captured values back into whatever scope they were declared
in. When variables lived on the collection, running the login request wrote
a real JWT into `KwaraPolyData.postman_collection.json` — a tracked file —
and the next `git add -A` would have committed it. Moving them to an
environment means the file Postman mutates is one git never sees.

`token` and `adminToken` are declared `type: secret`, so Postman masks them
in the UI and leaves them out of shared exports.

## Setup

1. Import `../KwaraPolyData.postman_collection.json`.
2. Import `KwaraPolyData.postman_environment.example.json`.
3. Select "KwaraPolyData — local" in the environment dropdown, top right.
   The collection breaks with `{{baseUrl}}` unresolved if you skip this.
4. Run **Auth → Login**, then paste the returned JWT into `token`. Admin
   endpoints need an admin account's token in `adminToken`.

Point `baseUrl` at whatever the API is actually answering on. Locally that
is `http://localhost:5000/api`. Note the `/api` suffix — every route is
mounted under it, so dropping it 404s every request.

## Do not commit a filled environment

`.gitignore` blocks `postman/*.postman_environment.json` while allowing the
`.example`. If you add a second environment (staging, production), name it
`*.postman_environment.json` so the existing rule covers it. Verify with:

    git check-ignore -v backend/postman/<your-file>.json

Tokens are short-lived, but the collection also exercises real wallet debits
and live provider calls — treat a leaked admin token as an incident, not an
inconvenience.
