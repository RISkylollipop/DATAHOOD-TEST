import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Loader } from '../components/Loader';
import { PinModal } from '../components/PinModal';
import { useBalanceMask, MaskedAmount, MaskToggle } from '../components/MaskedBalance';
import { formatNaira, gatewayLabel } from '../config';
import { IcWallet, IcCopy, IcCard, IcPlus } from '../components/Icons';
import { SupportLink } from '../components/SupportLink';


export default function Wallet() {
  const { user, updateUser } = useAuth();
  const toast = useToast();
  const { hidden, toggle } = useBalanceMask();
  const [wallet, setWallet] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  // Gateways the user does NOT hold yet, straight from the server.
  const [available, setAvailable] = useState([]);
  const [gateway, setGateway] = useState('');
  // The identity the gateway checks against NIBSS/NIMC. Name and phone
  // default to the profile as a convenience but stay EDITABLE: people
  // register here as "Tunde" when the bank holds "Babatunde", or sign up
  // on a second SIM, and an exact-match failure reads as a flat rejection.
  const [kyc, setKyc] = useState({
    idType: 'bvn', idNumber: '', firstName: '', lastName: '', phone: '',
  });
  const setKycField = (k) => (e) => setKyc((s) => ({ ...s, [k]: e.target.value }));
  const [addOpen, setAddOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [transferring, setTransferring] = useState(false);

  const load = () => {
    Promise.all([api.get('/wallet'), api.get('/settings/public'), api.get('/payment/accounts')])
      .then(([w, s, a]) => {
        setWallet(w.data);
        setSettings(s.data);
        if (w.data) updateUser({ wallet: w.data.mainBalance, refWallet: w.data.referralBalance });
        // Load existing reserved accounts so the user sees them on page load
        // instead of an empty "Generate account" form they can never satisfy.
        setAccounts(a.data?.accounts || []);
        const avail = a.data?.available || [];
        setAvailable(avail);
        // Preselect the gateway the admin marked as recommended.
        setGateway((g) => (avail.some((x) => x.gateway === g) ? g : (avail.find((x) => x.recommended) || avail[0])?.gateway || ''));
      })
      .catch(() => toast.error('Could not load wallet'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Prefill the KYC name/phone from the profile once the user is known.
  // Only fills BLANK fields, so it can never overwrite a correction the
  // user has already typed.
  useEffect(() => {
    if (!user) return;
    setKyc((s) => ({
      ...s,
      firstName: s.firstName || user.firstName || user.sFname || '',
      lastName: s.lastName || user.lastName || user.sLname || '',
      phone: s.phone || user.phone || user.sPhone || '',
    }));
  }, [user]);

  const copy = (text) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success('Copied', text),
      () => toast.error('Could not copy'),
    );
  };

  const selectedGw = available.find((g) => g.gateway === gateway);

  // Accounts grouped by gateway: one gateway may return several partner
  // banks, and a user may hold several gateways at once.
  const groups = accounts.reduce((acc, a) => {
    const key = a.gateway || '';
    (acc[key] = acc[key] || []).push(a);
    return acc;
  }, {});

  const generate = async () => {
    if (!gateway) return toast.error('Choose a gateway first.');
    if (selectedGw?.needsBvn) {
      // Match the backend rules (utils/kycIdentity.js) so a request that
      // is guaranteed to be rejected never leaves the browser.
      if (kyc.idType !== 'bvn' && kyc.idType !== 'nin') {
        return toast.error('Choose BVN or NIN.');
      }
      if (!/^\d{11}$/.test(kyc.idNumber)) {
        return toast.error(`Enter the 11-digit ${kyc.idType.toUpperCase()} registered on the account.`);
      }
      if (!kyc.firstName.trim() || !kyc.lastName.trim()) {
        return toast.error('Enter the first and last name on your bank record.');
      }
      if (!/^0[789]\d{9}$/.test(kyc.phone.replace(/\D/g, ''))) {
        return toast.error('Enter the phone number registered on your bank record.');
      }
    }
    setGenerating(true);
    try {
      await api.post('/payment/create-account', { gateway, ...kyc });
      // Re-read rather than trusting the create response: the server owns
      // which gateways remain available, and it just changed.
      setAddOpen(false);
      load();
      toast.success('Virtual account ready', 'Fund it to top up instantly.');
    } catch (err) {
      toast.error('Could not create account', err.message);
      // 409 means we offered a gateway the user already holds — our list
      // was stale, so refresh it instead of leaving the same dead button.
      if (err.status === 409) { setAddOpen(false); load(); }
    } finally {
      setGenerating(false);
      // The ID NUMBER is cleared on every path, success or failure — it
      // used to be cleared only on success, so a BVN typed into a failed
      // attempt stayed in component state for the rest of the session.
      // Name and phone deliberately survive: they are already in the
      // profile, and wiping them left the form blank when a user went on
      // to add a second gateway (the prefill only re-runs when `user`
      // changes, which it does not here).
      setKyc((s) => ({ ...s, idNumber: '' }));
    }
  };

  const transferBonus = async (pin) => {
    setTransferring(true);
    try {
      const res = await api.post('/wallet/transfer-bonus', { pin });
      setPinOpen(false);
      toast.success('Bonus transferred', formatNaira(res.data?.transferred));
      setWallet((w) => ({
        ...w,
        mainBalance: res.data?.newBalance ?? w.mainBalance,
        referralBalance: 0,
      }));
      if (res.data?.newBalance != null) updateUser({ wallet: res.data.newBalance, refWallet: 0 });
    } catch (err) {
      toast.error('Transfer failed', err.message);
    } finally {
      setTransferring(false);
    }
  };

  if (loading) return <Loader full />;

  return (
    <>
      <h1 className="page-title">Fund Wallet</h1>
      <p className="page-sub">Top up your wallet and manage your balances.</p>

      <div className="grid grid-3 mb-2">
        <div className="balance-card">
          <div className="row between" style={{ alignItems: 'center' }}>
            <div className="label">Main balance</div>
            <MaskToggle hidden={hidden} onToggle={toggle} light />
          </div>
          <div className="amt"><MaskedAmount value={wallet?.mainBalance} hidden={hidden} render={formatNaira} /></div>
          <div className="small mt-1" style={{ opacity: 0.85 }}>Tier: {wallet?.tier || 'User'}</div>
        </div>
        <div className="card stat">
          <span className="k">Bonus balance</span>
          <span className="v"><MaskedAmount value={wallet?.referralBalance} hidden={hidden} render={formatNaira} /></span>
          <span className="small muted">Earned from referrals</span>
        </div>
        <div className="card stat">
          <span className="k">Currency</span>
          <span className="v">{wallet?.currency || 'NGN'}</span>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card card-pad-lg">
          <h3 className="row" style={{ gap: 8, alignItems: 'center' }}><IcCard size={20} /> Automated funding</h3>
          <p className="muted small">Generate a dedicated virtual account. Transfers to it credit your wallet automatically.</p>

          {accounts.length > 0 && (
            <div className="mt-2">
              <p className="small muted" style={{ marginTop: 0 }}>
                Transfer to any of these accounts from your bank app — your wallet is credited automatically.
              </p>
              {Object.entries(groups).map(([key, list]) => (
                <div key={key || 'legacy'} className="mb-2">
                  <div className="row between" style={{ alignItems: 'center' }}>
                    <div className="small strong">{gatewayLabel(key)}</div>
                    <span className="small muted">{list.length} account{list.length > 1 ? 's' : ''}</span>
                  </div>
                  {list.map((a, i) => (
                    <div key={`${key}-${i}`} className="card mb-1" style={{ background: 'var(--brand-soft)' }}>
                      <div className="small muted">{a.bankName}</div>
                      <div className="row between">
                        <div className="strong" style={{ fontSize: 22, letterSpacing: 1 }}>{a.accountNumber}</div>
                        <button className="btn btn-ghost btn-sm" onClick={() => copy(a.accountNumber)}><IcCopy size={16} /></button>
                      </div>
                      <div className="small">{a.accountName}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* A user may hold one account set per gateway, so this stays
              available after the first one. The server decides what is
              still on offer; an empty list means they hold them all. */}
          {available.length > 0 && (
            accounts.length > 0 && !addOpen ? (
              <button className="btn btn-soft btn-block mt-1" onClick={() => setAddOpen(true)}>
                <IcPlus size={18} /> Add another funding account
              </button>
            ) : (
              <div className="mt-2">
                <div className="field">
                  <label className="label">Payment gateway</label>
                  <select className="select" value={gateway} onChange={(e) => setGateway(e.target.value)}>
                    {available.map((g) => (
                      <option key={g.gateway} value={g.gateway}>
                        {gatewayLabel(g.gateway)}{g.recommended ? ' (recommended)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                {selectedGw?.needsBvn && (
                  <>
                    <div className="field">
                      <label className="label" htmlFor="kyc-idtype">Verify with</label>
                      <select id="kyc-idtype" className="select" value={kyc.idType}
                        onChange={setKycField('idType')}>
                        <option value="bvn">BVN</option>
                        <option value="nin">NIN</option>
                      </select>
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="kyc-idnumber">
                        {kyc.idType.toUpperCase()}
                        <span className="muted small"> (required by {gatewayLabel(gateway)})</span>
                      </label>
                      <input id="kyc-idnumber" className="input" value={kyc.idNumber}
                        onChange={(e) => setKyc((s) => ({ ...s, idNumber: e.target.value.replace(/\D/g, '').slice(0, 11) }))}
                        placeholder={`11-digit ${kyc.idType.toUpperCase()}`}
                        inputMode="numeric" maxLength={11} autoComplete="off" />
                    </div>
                    {/* Name and phone AS REGISTERED on the ID, not as signed up
                        here. The bank checks them for an exact match, so these
                        are editable and the label has to say why. */}
                    <div className="row" style={{ gap: 8 }}>
                      <div className="field" style={{ flex: 1 }}>
                        <label className="label" htmlFor="kyc-first">First name</label>
                        <input id="kyc-first" className="input" value={kyc.firstName}
                          onChange={setKycField('firstName')} placeholder="As on your bank record"
                          autoComplete="off" maxLength={50} />
                      </div>
                      <div className="field" style={{ flex: 1 }}>
                        <label className="label" htmlFor="kyc-last">Last name</label>
                        <input id="kyc-last" className="input" value={kyc.lastName}
                          onChange={setKycField('lastName')} placeholder="As on your bank record"
                          autoComplete="off" maxLength={50} />
                      </div>
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="kyc-phone">
                        Phone used for your {kyc.idType.toUpperCase()}
                      </label>
                      <input id="kyc-phone" className="input" value={kyc.phone}
                        onChange={(e) => setKyc((s) => ({ ...s, phone: e.target.value.replace(/\D/g, '').slice(0, 11) }))}
                        placeholder="e.g. 08012345678" inputMode="numeric" maxLength={11}
                        autoComplete="off" />
                    </div>
                    {/* Users are handing over a bank identifier, so say plainly
                        what happens to it. Accurate as written: the number is
                        forwarded to the gateway and never written to our DB. */}
                    <p className="small muted mt-1">
                      Your details must match your bank record exactly, or the bank will reject the
                      account. Sent to {gatewayLabel(gateway)} to open it — we never store
                      your {kyc.idType.toUpperCase()}.
                    </p>
                  </>
                )}
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn mt-1" style={{ flex: 1 }} onClick={generate} disabled={generating || !gateway}>
                    {generating ? <span className="spinner" /> : <><IcPlus size={18} /> Generate account</>}
                  </button>
                  {accounts.length > 0 && (
                    <button className="btn btn-ghost mt-1" onClick={() => { setAddOpen(false); setKyc((s) => ({ ...s, idNumber: '' })); }}>Cancel</button>
                  )}
                </div>
              </div>
            )
          )}

          {accounts.length === 0 && available.length === 0 && (
            <p className="small muted mt-2">
              Automated funding is not available right now. Use the manual bank transfer beside this card,
              or <SupportLink />.
            </p>
          )}
        </div>

        <div className="card card-pad-lg">
          <h3 className="row" style={{ gap: 8, alignItems: 'center' }}><IcWallet size={20} /> Transfer bonus to wallet</h3>
          <p className="muted small">Move your entire referral bonus into your main spendable balance.</p>
          <div className="card mt-2" style={{ background: 'var(--surface-2)' }}>
            <div className="small muted">Available bonus</div>
            <div className="strong text-brand" style={{ fontSize: 22 }}>{formatNaira(wallet?.referralBalance)}</div>
          </div>
          <button className="btn btn-block mt-2" onClick={() => setPinOpen(true)}
            disabled={transferring || !(wallet?.referralBalance > 0)}>
            {transferring ? <span className="spinner" /> : 'Transfer to main balance'}
          </button>

          {settings?.accountno && (
            <div className="mt-2" style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              <h4 className="mt-0">Manual bank transfer</h4>
              <p className="muted small">Send to the account below, then <SupportLink>send us your receipt</SupportLink>.</p>
              <div className="kv">
                <div className="kv-row"><span className="muted small">Bank</span><span className="strong small">{settings.bankname}</span></div>
                <div className="kv-row"><span className="muted small">Account no.</span>
                  <span className="strong small">{settings.accountno}
                    <button className="btn btn-ghost btn-sm" onClick={() => copy(settings.accountno)}><IcCopy size={14} /></button>
                  </span>
                </div>
                <div className="kv-row"><span className="muted small">Account name</span><span className="strong small">{settings.accountname}</span></div>
              </div>
            </div>
          )}
        </div>
      </div>

      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} onConfirm={transferBonus}
        action="move your bonus balance" amount={formatNaira(wallet?.referralBalance)}
        target="your main wallet" busy={transferring} />
    </>
  );
}
