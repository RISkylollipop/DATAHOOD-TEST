// ============================================================
//  Vite config — replaces react-scripts (CRA)
// ------------------------------------------------------------
//  All 44 files in src/ are .jsx — the rename is DONE, not pending.
//  Vite's transformer will not parse JSX inside a .js file; it fails
//  with "JSX syntax is disabled and should be enabled via the parser
//  options". You can force it with a loader override, but that config
//  differs between Vite 7 (esbuild) and Vite 8 (Oxc/Rolldown) and has
//  known conflicts with Vite 8's bundled dev mode. Renaming is the
//  supported path on every version, so there is deliberately no
//  loader/esbuild/oxc block below.
//
//  Every file was renamed, not just the JSX-bearing ones: detecting
//  JSX by grep undercounts. Guards.js held its only JSX inline on a
//  return statement (`return <Navigate ... />`) and was missed. JSX is
//  a superset of JS, so the handful of plain modules compile
//  identically as .jsx and there is no classification step to get
//  wrong.
//
//  Extensionless imports still resolve: '.jsx' is in Vite's
//  default resolve.extensions, so `import App from './App'` finds
//  App.jsx untouched. No import statements need editing.
//
//  ENV VARS — WHY process.env IS SHIMMED RATHER THAN REWRITTEN
//  CRA inlined process.env.*; Vite exposes import.meta.env.VITE_*.
//  Rewriting the source would mean the files no longer build under
//  CRA, making this a one-way door mid-migration. There are only
//  three reads in the whole app (REACT_APP_API_URL, NODE_ENV,
//  PUBLIC_URL), so `define` below inlines them exactly the way CRA
//  did. No src/ file needed an env edit for this migration.
//
//  Set VITE_API_URL in .env. REACT_APP_API_URL is still read as a
//  fallback so a deploy environment that already carries it keeps
//  working — the migration must not silently blank the API URL,
//  which is the exact failure that broke mobile login once already.
//
//  react-scripts is removed from package.json, so CRA no longer runs.
//  This project is NOT a git repository, so there is no `git revert`
//  to fall back on: the pre-rename originals are copied verbatim to
//  frontend/src-backup-before-jsx/. That directory is the only undo
//  for this migration — delete it once the build is confirmed, and
//  not before.
// ============================================================

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // '' = load every var, not just the VITE_-prefixed ones, so a
  // deploy environment still carrying REACT_APP_API_URL is honoured.
  const env = loadEnv(mode, process.cwd(), '');

  // Every backend route is mounted under '/api' (server.js), so an API
  // base without that suffix 404s on every call. `ngrok http 5000` prints
  // a bare origin, so normalise rather than rely on remembering: strip a
  // trailing slash, then add '/api' if it isn't already there.
  const withApiPath = (u) => {
    const base = String(u || '').replace(/\/+$/, '');
    if (!base) return '';
    return /\/api$/.test(base) ? base : `${base}/api`;
  };

  // MOBILE TESTING — tunnel port 3000, NOT 5000.
  //
  // Point ngrok at the Vite dev server and the phone loads the app and
  // calls '/api' on that same origin; the proxy below forwards it to
  // Express on :5000. So there is deliberately NO hardcoded tunnel URL
  // here: config.js already falls back to a relative '/api' on any
  // non-localhost host, which is correct no matter what subdomain ngrok
  // hands out this time. Free ngrok randomises the subdomain on every
  // restart, so a literal here goes stale and reintroduces the original
  // "wrong host baked into the bundle" failure. It also only allows one
  // tunnel at a time, so tunnelling 3000 and 5000 together isn't an option.
  //
  // Set VITE_DEV_API_TARGET only for the other shape — tunnelling :5000
  // directly, or a backend on another machine. Then the tunnel host must
  // also be in the backend's CLIENT_ORIGINS, because it becomes cross-origin.
  const devFallback = withApiPath(env.VITE_DEV_API_TARGET || '');

  const configured = env.VITE_API_URL || env.REACT_APP_API_URL || '';
  const apiUrl = configured || (mode === 'production' ? '' : devFallback);

  // ----------------------------------------------------------
  //  A PRODUCTION BUILD MUST NOT CARRY A LOOPBACK API URL.
  // ----------------------------------------------------------
  //  This guard used to fire on an EMPTY apiUrl instead, on the reasoning
  //  that a production build with no API URL is always wrong. That stopped
  //  being true when the deploy kit moved to a single origin: nginx now
  //  serves the SPA and proxies the API under /api on the same host, so
  //  config.jsx's same-origin fallback is the correct answer and
  //  deploy/deploy.sh deliberately sets no VITE_API_URL at all.
  //
  //  The two together meant `bash deploy.sh` could not finish: the build
  //  threw on line one of the frontend step, every time, on a server that
  //  was configured exactly as its own README said to configure it. A
  //  guard that blocks the supported deploy is worse than no guard —
  //  the way past it is to invent a value, and the value people invent
  //  under time pressure is the one that works on their laptop.
  //
  //  So the check now names the actual hazard. The original outage was
  //  never "no URL", it was a LOCALHOST url baked into a bundle: correct
  //  on the build machine, broken on every phone, silent in both cases.
  //  That is what must be impossible to ship, and it stays a hard error.
  //
  //  Empty is allowed and means same-origin. deploy.sh greps the built
  //  assets for localhost:5000 as well — belt and braces, since that one
  //  also catches a stale value arriving from the shell environment
  //  rather than from this config.
  if (mode === 'production' && /localhost|127\.0\.0\.1|\[::1\]/i.test(apiUrl)) {
    throw new Error(
      `VITE_API_URL points at a loopback address (${apiUrl}), so this production\n` +
      'build would work on this machine and fail on every phone — that exact\n' +
      'build shipped once and broke all mobile logins silently.\n\n' +
      'Either set it to the real API origin:\n' +
      '  VITE_API_URL=https://kwarapolydata.com.ng/api\n' +
      'or unset it entirely for a single-origin deploy, where nginx proxies\n' +
      '/api on the same host and config.jsx resolves it relatively.'
    );
  }

  return {
    plugins: [react()],

    // Inlined at build time, exactly as CRA did. JSON.stringify is
    // required — these are raw text substitutions, so an unquoted
    // value would be spliced in as an identifier and throw.
    define: {
      'process.env.REACT_APP_API_URL': JSON.stringify(apiUrl),
      'process.env.NODE_ENV': JSON.stringify(mode),
      'process.env.PUBLIC_URL': JSON.stringify(''),
    },

    server: {
      port: 3000,

      // Bind all interfaces, not just loopback. Lets a phone on the same
      // wifi reach http://<your-pc-ip>:3000 directly — often quicker than
      // a tunnel for a look at mobile layout, though ngrok is still needed
      // for anything requiring HTTPS.
      host: true,

      // Vite refuses requests whose Host header it doesn't recognise and
      // answers "Blocked request. This host is not allowed." A tunnel
      // arrives as <random>.ngrok-free.dev, so without this every ngrok
      // session fails before a single line of app code runs. Leading dot
      // = match any subdomain, which is what makes this survive ngrok
      // handing out a new name each restart.
      allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app', '.ngrok.io'],

      // HMR's websocket goes back over the tunnel on 443, not the local
      // port, so without this the client retries forever against :3000
      // and the console fills with connection errors. Only applied when
      // tunnelling, since it would break plain local dev.
      ...(env.VITE_DEV_TUNNEL
        ? { hmr: { protocol: 'wss', clientPort: 443 } }
        : {}),

      // Lets the dev server call the Express backend at a same-origin
      // /api path, so dev matches production and CORS stays out of the
      // way. Only used by `npm run dev`.
      proxy: {
        // NOTE the asymmetry with devFallback above: this target is an
        // ORIGIN, not an API base. Vite forwards the matched path as-is,
        // so '/api/auth/login' already carries the prefix — a target
        // ending in '/api' would proxy to '/api/api/auth/login'. Hence
        // the trailing '/api' is stripped rather than added.
        //
        // A `||` chain of string literals would also be a no-op here: a
        // non-empty string is truthy, so the first always wins and any
        // alternative is dead code. Point dev at a tunnel with:
        //   VITE_DEV_API_TARGET=https://<subdomain>.ngrok-free.dev
        '/api': {
          target: String(env.VITE_DEV_API_TARGET || 'http://localhost:5000')
            .replace(/\/+$/, '')
            .replace(/\/api$/, ''),
          changeOrigin: true,
        },
      },
    },

    // CRA emitted to build/. Kept identical so any deploy script,
    // static-host config or CI step that points at frontend/build
    // keeps working without being touched.
    build: {
      outDir: 'build',
      sourcemap: false,
      // This app is the dashboard; the landing page's Core Web Vitals
      // budget depends on not shipping the whole admin panel to a
      // first-time visitor. A warning here is a signal to split.
      chunkSizeWarningLimit: 600,
    },
  };
});
