// ============================================================
//  /newsletter/confirm  and  /newsletter/unsubscribe
// ------------------------------------------------------------
//  The two pages reached by clicking a link inside an email. Both are
//  public: the token in the URL is the only credential, and the person
//  arriving here is by definition not signed in — they are in their mail
//  app, possibly on a phone, possibly months after they subscribed.
//
//  Two decisions worth stating, because both look like bugs otherwise:
//
//   1. CONFIRM ACTS ON LOAD. UNSUBSCRIBE ASKS FIRST.
//      Confirming is what the recipient came here to do, so making them
//      click a second button is friction for no gain. Unsubscribing is
//      destructive and mail clients pre-fetch links — Gmail and some
//      corporate scanners follow URLs in the background to check them.
//      An unsubscribe that fired on page load would silently drop people
//      off the list who never clicked anything.
//
//      (The one-click unsubscribe in the mail client header is different:
//      that is an RFC 8058 POST straight to the API, which is an explicit
//      user action, not a scanner's GET.)
//
//   2. NEITHER PAGE EVER SHOWS AN ERROR FOR A SPENT TOKEN.
//      "Already unsubscribed" and "no such token" are the same answer on
//      purpose — see the controller. A red failure screen for someone who
//      clicked twice is how you turn a resolved request into a spam report.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { PublicShell } from '../components/PublicShell';
import { Loader } from '../components/Loader';

export default function NewsletterAction({ mode }) {
  const isConfirm = mode === 'confirm';
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  const [state, setState] = useState(isConfirm ? 'working' : 'idle');
  const [msg, setMsg] = useState('');

  const run = useCallback(() => {
    if (!token) {
      setState('bad');
      setMsg('That link is missing its code. Please use the link exactly as it appears in the email.');
      return;
    }
    setState('working');
    api.post(`/newsletter/${isConfirm ? 'confirm' : 'unsubscribe'}`, { token })
      .then((r) => { setState('done'); setMsg(r.msg); })
      .catch((err) => { setState('bad'); setMsg(err.message); });
  }, [token, isConfirm]);

  // Confirm fires immediately; unsubscribe waits for the button. See note 1.
  useEffect(() => { if (isConfirm) run(); }, [isConfirm, run]);

  const title = isConfirm ? 'Confirming your subscription' : 'Unsubscribe';

  return (
    <PublicShell title={state === 'done' && isConfirm ? 'You are subscribed' : title}>
      {state === 'working' && <Loader />}

      {state === 'idle' && !isConfirm && (
        <>
          <p>
            Click below and we will stop sending you our newsletter. It takes
            effect immediately.
          </p>
          <p className="muted small">
            This only affects marketing emails. Receipts, password resets and
            other messages about your own account are not affected — those are
            part of the service, not a mailing list.
          </p>
          <p>
            <button type="button" className="btn" onClick={run}>
              Unsubscribe me
            </button>
          </p>
        </>
      )}

      {state === 'done' && (
        <>
          <p>{msg}</p>
          {isConfirm ? (
            <p>
              You will hear from us when there is something worth reading — new
              plans, price drops and service notices. Nothing else.
            </p>
          ) : (
            <p>
              Changed your mind? You can subscribe again from the bottom of{' '}
              <Link to="/">our home page</Link> at any time.
            </p>
          )}
        </>
      )}

      {state === 'bad' && (
        <>
          <p>{msg}</p>
          <p className="muted small">
            Confirmation links expire after 48 hours. If yours has run out, just
            enter your email again on <Link to="/">the home page</Link> and we
            will send a fresh one. If you were trying to unsubscribe and this
            did not work, email us and we will remove you by hand — please
            do not mark the message as spam.
          </p>
          <p><Link to="/support" className="btn btn-soft btn-sm">Contact support</Link></p>
        </>
      )}
    </PublicShell>
  );
}
