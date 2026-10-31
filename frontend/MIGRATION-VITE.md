# CRA → Vite migration: the one step you have to run

Everything else is done and committed. This file exists because the
migration needs a bulk file rename, which I could not perform from here
(the sandbox VM has been down for this entire session, so nothing below
has been executed or build-tested — it is written from reading the tree).

## Why a rename is needed

Vite's transformer will not parse JSX inside a `.js` file. It fails with:

```
JSX syntax is disabled and should be enabled via the parser options
```

You can force it with a loader override, but that config differs between
Vite 7 (esbuild) and Vite 8 (Oxc/Rolldown), and has known conflicts with
Vite 8's bundled dev mode. Renaming is the supported path on every version
and needs no config, so `vite.config.js` deliberately has no loader block.

**Extensionless imports do not need editing.** `.jsx` is in Vite's default
`resolve.extensions`, so `import App from './App'` finds `App.jsx` by
itself. No import statement in the codebase changes.

## Run this

This project is **not a git repository yet**, so there is no `git mv` and no
undo. Take a copy first — it is the whole safety net:

```powershell
cd "C:\Dev\DATAHOOD PROJECT\frontend"
Copy-Item -Path src -Destination src-backup-before-jsx -Recurse
```

Then rename:

```powershell
cd "C:\Dev\DATAHOOD PROJECT\frontend"
$files = @(Get-ChildItem -Path src -Recurse -Filter *.js -File)
$files | ForEach-Object {
  Rename-Item -LiteralPath $_.FullName -NewName ($_.Name -replace '\.js$', '.jsx')
}
```

The `@( )` around `Get-ChildItem` matters: it forces the full list to be
collected *before* any renaming starts. Piping directly would enumerate
lazily and can re-visit files it has already renamed.

Verify — expect 0 and 44:

```powershell
(Get-ChildItem -Path src -Recurse -Filter *.js  -File).Count
(Get-ChildItem -Path src -Recurse -Filter *.jsx -File).Count
```

Delete `src-backup-before-jsx` once `npm run dev` works. Do not leave it
inside `src/` — Vite would try to build it, and you would have two copies
of every component.

> Worth doing soon: `git init`. The root `.gitignore` is already written and
> already excludes the customer-PII `.sql` dumps, so the protection is in
> place the moment a repo exists — but right now nothing here is recoverable.

### Rename all 44, not a filtered subset

Do not try to rename "only the files with JSX". I tried to produce that
list by grep and it silently missed `components/Guards.js`, whose only JSX
is inline on a `return` line:

```js
if (!isAuthed) return <Navigate to="/login" ... />;
```

One missed file is a build error. JSX is a superset of JS, so renaming a
plain module to `.jsx` is harmless — `config.js`, `api/client.js`,
`utils/receiptImage.js` and `hooks/usePurchaseRef.js` contain no JSX and
compile identically either way. Renaming everything removes the
classification risk entirely.

`vite.config.js` at the frontend root stays `.js` — it is Node-side config,
never JSX.

## Then

```bash
cd frontend
rm -rf node_modules package-lock.json   # react-scripts is gone from package.json
npm install
npm run dev
```

**Node 20.19+ is required.** Vite 8 will not install on Node 18, which
DEPLOYMENT.md Part 1 still lists as acceptable. Check with `node -v`.

Once `npm run dev` serves the app, delete `frontend/public/index.html` —
the replacement lives at `frontend/index.html`. If both exist, the stale
one gets copied into the build output and can overwrite the real entry.
(I could not delete it myself; file deletion was declined earlier.)

## What changed, and what deliberately did not

| Area | Before (CRA) | After (Vite) |
|---|---|---|
| Entry HTML | `public/index.html`, `%PUBLIC_URL%` | `index.html` at root, plain `/` paths |
| Bundle tag | injected | explicit `<script type="module" src="/src/index.jsx">` |
| Dev server | `npm start` :3000 | `npm run dev` :3000, `/api` proxied to :5000 |
| Output dir | `build/` | `build/` — kept identical so deploy scripts still work |
| Env var | `REACT_APP_API_URL` | `VITE_API_URL` (old name still honoured) |

**No `src/` file needed an env edit.** There were only three `process.env`
reads in the whole app (`REACT_APP_API_URL`, `NODE_ENV`, `PUBLIC_URL`), and
`vite.config.js` inlines all three via `define` exactly as CRA did. Source
stays bundler-agnostic, so the rename is the only source-level change.

## After the first production build, verify

```bash
grep -o "https\?://[a-zA-Z0-9.:-]*/api" build/assets/*.js | sort -u
```

Expect only `https://api.kwarapolydata.com.ng/api`. If `localhost` appears,
`.env.production` was not picked up — rebuild, do not upload. That exact
mistake is what broke mobile login: the shipped bundle contained
`http://localhost:5000/api`, and on a phone `localhost` is the phone.
