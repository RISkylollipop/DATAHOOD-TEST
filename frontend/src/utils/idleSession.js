// ============================================================
//  idleSession.js — sign out after 15 minutes without a human
// ------------------------------------------------------------
//  The server already expires a session 15 minutes after the last
//  REQUEST (backend/utils/sessionToken.js). This watches the last
//  INTERACTION, which is not the same thing and is the reason both
//  halves exist:
//
//    - A screen that polls keeps the server's clock alive with
//      nobody present. AdminNewsletter.jsx polls a sending campaign
//      on a timer; that alone would hold a session open on an
//      unattended desk indefinitely.
//    - A client-only timer is worthless on its own, because anyone
//      holding the token can simply not run our JavaScript.
//
//  So: the server decides when a token is dead, and this decides
//  when the person is gone. Neither is a substitute for the other.
//
//  WHAT COUNTS AS ACTIVITY: pointer, keyboard, touch, scroll, and
//  a tab becoming visible again. Deliberately NOT network traffic
//  or timers — those are the very things a poll produces.
//
//  AND EVERY ONE OF THOSE EVENTS IS JUDGED BEFORE IT IS RECORDED.
//  An event arriving after the window has already elapsed is not
//  proof the user was here all along; it is the moment they came
//  back. Recording it first overwrites the absence and resurrects
//  a session that was already over.
// ============================================================

/** Same default as the backend's SESSION_IDLE_MINUTES. */
export const DEFAULT_IDLE_MS = 15 * 60 * 1000;

/**
 * Events that mean a person is there. 'visibilitychange' is included
 * because returning to a backgrounded tab is a deliberate act, and
 * browsers throttle timers in background tabs — without it, a user who
 * switches away for a moment can come back to a signed-out app whose
 * timer only just caught up.
 */
const ACTIVITY_EVENTS = [
  'mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll', 'wheel', 'visibilitychange',
];

/**
 * Where the last-activity stamp lives, so every open tab shares one
 * deadline. Without this, working in tab A while tab B sits idle lets
 * B sign the whole browser out — same storage, same token.
 */
const LAST_ACTIVITY_KEY = 'datahood_last_activity';

/** Read the shared stamp. Returns 0 when absent or unreadable. */
export function readLastActivity(storage) {
  try {
    const n = Number(storage.getItem(LAST_ACTIVITY_KEY));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Has the session been idle long enough to end?
 *
 * Pure, and exported so the decision can be tested without a DOM, a
 * clock, or a browser.
 *
 * @param {number} lastActivity  epoch ms of the last real interaction
 * @param {number} now           epoch ms now
 * @param {number} idleMs        the window
 */
export function isIdleExpired(lastActivity, now, idleMs) {
  if (!Number.isFinite(lastActivity) || lastActivity <= 0) return false;
  if (!Number.isFinite(now) || !Number.isFinite(idleMs) || idleMs <= 0) return false;
  // A stamp in the FUTURE (the clock moved backwards — an NTP correction, or
  // another tab on a machine whose time was wrong) reads as not-yet-idle,
  // which is the safe answer: signing someone out over a clock correction is
  // a logout they cannot explain, and the server's own expiry still bounds
  // the session. That falls out of the subtraction below — a negative
  // difference never reaches a positive window — so there is no explicit
  // guard for it. One would be unreachable, and unreachable guards read like
  // protection while providing none.
  return now - lastActivity >= idleMs;
}

/**
 * How long after a stamp the next one is suppressed.
 *
 * `mousemove` fires hundreds of times a second and every single one of them
 * used to write to localStorage. A one-second floor is invisible against a
 * 15-minute window and removes that write storm — and, now that each event
 * also READS the shared stamp to judge it, the read storm too.
 */
const STAMP_THROTTLE_MS = 1000;

/**
 * Start watching. Returns a stop() to unwind every listener and timer.
 *
 * @param {object}   opts
 * @param {Function} opts.onExpire   called once, with 'idle' | 'expired'
 * @param {number}   [opts.idleMs]   window; defaults to 15 minutes
 * @param {number}   [opts.checkMs]  how often to test; defaults to 30s
 * @param {Function} [opts.isSessionDead]  true when the stored token is past
 *   its expiry. INJECTED rather than imported so this file keeps no
 *   dependencies and stays testable without a browser or an API client.
 */
export function startIdleWatch({
  onExpire,
  idleMs = DEFAULT_IDLE_MS,
  checkMs = 30 * 1000,
  isSessionDead,
} = {}) {
  if (typeof window === 'undefined' || typeof onExpire !== 'function') {
    return () => {};
  }

  const storage = window.localStorage;
  let stopped = false;
  // Kept in memory, not read back from storage, because its only job is to
  // rate-limit OUR writes. Another tab's stamp must not suppress ours.
  let lastStampAt = 0;

  const stamp = () => {
    lastStampAt = Date.now();
    try { storage.setItem(LAST_ACTIVITY_KEY, String(lastStampAt)); } catch { /* private mode */ }
  };

  /**
   * Why this session is over, or '' if it is not. Two separate deaths:
   *
   *  'idle'    — no interaction for the whole window. What this file watches.
   *  'expired' — the token itself is past its expiry. Possible WITH fresh
   *              interaction, because the server slides a session forward on
   *              REQUESTS (backend/utils/sessionToken.js) and reading a long
   *              page while moving the mouse makes none. Interaction is not
   *              traffic, so a live stamp is no promise of a live token.
   *
   * The distinction is not cosmetic: the login screens print the reason, and
   * telling someone who was working the whole time that they were inactive
   * is a false explanation for a real logout.
   */
  const endedReason = () => {
    if (isIdleExpired(readLastActivity(storage), Date.now(), idleMs)) return 'idle';
    try {
      if (typeof isSessionDead === 'function' && isSessionDead()) return 'expired';
    } catch {
      // A broken predicate must never sign anyone out on its own.
      return '';
    }
    return '';
  };

  /** End the session if it is over. Returns whether it did. */
  const expireIfDue = () => {
    if (stopped) return false;
    const reason = endedReason();
    if (!reason) return false;
    stop();
    onExpire(reason);
    return true;
  };

  const onActivity = (e) => {
    const isVisibility = !!e && e.type === 'visibilitychange';
    // A tab going HIDDEN is not activity — only its return is. Stamping on
    // both would refresh the deadline at the moment the user walks away.
    if (isVisibility && document.visibilityState !== 'visible') return;

    // The throttle cannot swallow a session-ending event, so there is no
    // exemption for visibilitychange here. Reaching this line means WE stamped
    // less than a second ago, and a stamp that new means the session is not
    // idle by any window worth having. (A token that died inside that same
    // second is caught by the tick below, within its usual 30s.) An exemption
    // was written here first, and a mutation test proved nothing could tell
    // the difference — which makes it decoration that reads like protection.
    if (Date.now() - lastStampAt < STAMP_THROTTLE_MS) return;

    // THE ORDER OF THESE TWO LINES IS THE ENTIRE POINT.
    //
    // Judge the stamp BEFORE overwriting it. Stamping first destroys the only
    // record of the absence, and that is how a session survived one: sleep the
    // laptop at 09:49 with the tab open, wake it at 12:31, and the first
    // mousemove wrote "active just now" — so the 30-second tick below then
    // read a perfectly fresh stamp and stayed silent, on a token that had been
    // dead for two and a half hours. The logout still happened, as five
    // parallel 401s from the dashboard's opening requests.
    //
    // The mount path at the bottom of this file was already fixed for exactly
    // this reason; a tab left OPEN never reaches that path, and kept the bug.
    if (expireIfDue()) return;
    stamp();
  };

  // Opening the app is activity ONLY if we have no record of when the user
  // was last here. This used to stamp unconditionally, and that erased the
  // very history the watchdog exists to read: close the laptop at 19:11,
  // reopen at 20:40, and the fresh stamp said "active just now" — so the
  // watchdog never fired, the app rendered a signed-in dashboard around a
  // token that died 74 minutes earlier, and the first request came back 401.
  // The logout still happened; it just arrived as a failed page load instead
  // of an explained sign-out.
  //
  // A stamp in the FUTURE is a clock that moved backwards, not a visit from
  // tomorrow. isIdleExpired treats it as not-idle, so left alone it would
  // suspend the timeout until the clock caught up; re-stamping to now costs
  // the user at most one extra window and gets the deadline moving again.
  const existing = readLastActivity(storage);
  if (!existing || existing > Date.now()) stamp();

  ACTIVITY_EVENTS.forEach((evt) => {
    // passive: these listeners never preventDefault, and saying so keeps
    // scroll off the main thread's critical path.
    window.addEventListener(evt, onActivity, { passive: true });
  });

  const tick = () => { expireIfDue(); };
  const timer = window.setInterval(tick, checkMs);

  // Test the preserved stamp NOW rather than up to checkMs later. A user
  // returning to a long-dead session should meet the login screen, not spend
  // 30 seconds clicking around an app whose every request will 401.
  // Must follow the setInterval above: tick() -> stop() reads `timer`, which
  // is in its temporal dead zone until that line runs.
  tick();

  function stop() {
    if (stopped) return;
    stopped = true;
    window.clearInterval(timer);
    ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, onActivity));
  }

  return stop;
}

/** Clear the shared stamp, so the next sign-in starts a fresh window. */
export function clearIdleStamp() {
  try { window.localStorage.removeItem(LAST_ACTIVITY_KEY); } catch { /* ignore */ }
}

const LOGOUT_REASON_KEY = 'datahood_logout_reason';

/**
 * Read and consume the reason the last session ended, if any.
 *
 * One-shot on purpose: a login screen should explain a timeout once, not on
 * every visit for the rest of the tab's life. Returns '' when the user simply
 * navigated to the login page, which is the common case.
 */
export function takeLogoutReason() {
  try {
    const r = sessionStorage.getItem(LOGOUT_REASON_KEY) || '';
    if (r) sessionStorage.removeItem(LOGOUT_REASON_KEY);
    return r;
  } catch {
    return '';
  }
}
