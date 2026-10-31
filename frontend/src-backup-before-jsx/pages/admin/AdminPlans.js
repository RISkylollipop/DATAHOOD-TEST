import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { Loader, Empty } from '../../components/Loader';
import { Modal } from '../../components/Modal';
import { formatNaira, networkLabel } from '../../config';
import { IcPlus, IcLayers, IcTrash } from '../../components/Icons';

// ============================================================
//  Admin · Plans — manage data / cable / electricity offerings.
//  Mirrors what the legacy PHP admin could do (add / edit / delete)
//  and ADDS the enable/disable toggles the old panel never had:
//    - Data:  per-network SME / Gifting / Corporate on/off
//    - Data:  per-plan on/off (dataplans.status) — pause one bundle
//             without deleting it, so its pricing history survives
//    - Cable: per-provider (GOTV/DSTV/Startimes) on/off
//    - Electricity: per-DisCo on/off
//  Delete is still available, but it is for plans added in error —
//  use the per-plan toggle when a provider merely pauses a bundle.
// ============================================================

const TABS = [
  { id: 'data', label: 'Data plans' },
  { id: 'cable', label: 'Cable plans' },
  { id: 'electricity', label: 'Electricity' },
];

// Rows shown per page. Paged in the browser, not the API: the list endpoints
// return every plan in one response, so slicing here costs no extra requests.
const PAGE_SIZE = 10;

// Small on/off pill button used for the network-type / provider toggles.
function TogglePill({ on, label, onClick, busy }) {
  return (
    <button
      className={`btn btn-sm ${on ? 'badge-success' : 'btn-soft'}`}
      style={{ borderRadius: 999, opacity: busy ? 0.6 : 1 }}
      onClick={onClick}
      disabled={busy}
      title={on ? 'Enabled — click to disable' : 'Disabled — click to enable'}
    >
      {busy ? <span className="spinner" /> : <>{label} · {on ? 'On' : 'Off'}</>}
    </button>
  );
}

// The four price inputs shared by data + cable modals.
function PriceFields({ form, setField }) {
  return (
    <div className="grid grid-2">
      <div className="field" style={{ margin: 0 }}>
        <label className="label">Buy price (cost) </label>
        <input className="input" type="number" value={form.price}
          onChange={(e) => setField('price', e.target.value)} placeholder="e.g. 240" />
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label className="label">User price</label>
        <input className="input" type="number" value={form.userprice}
          onChange={(e) => setField('userprice', e.target.value)} placeholder="e.g. 250" />
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label className="label">Agent price</label>
        <input className="input" type="number" value={form.agentprice}
          onChange={(e) => setField('agentprice', e.target.value)} placeholder="e.g. 248" />
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label className="label">Vendor price</label>
        <input className="input" type="number" value={form.vendorprice}
          onChange={(e) => setField('vendorprice', e.target.value)} placeholder="e.g. 245" />
      </div>
    </div>
  );
}

export default function AdminPlans() {
  const toast = useToast();
  const [tab, setTab] = useState('data');

  // shared data
  const [loading, setLoading] = useState(true);
  const [networks, setNetworks] = useState([]);      // for data tab toggles + dropdown
  const [cableProviders, setCableProviders] = useState([]); // for cable tab toggles + dropdown
  const [rows, setRows] = useState([]);              // current tab's plan/DisCo rows
  const [search, setSearch] = useState('');          // free-text filter
  const [netFilter, setNetFilter] = useState('');    // '' = all networks/providers
  const [typeFilter, setTypeFilter] = useState('');  // '' = all plan types (data tab)
  const [page, setPage] = useState(1);               // 1-based, client-side
  const [toggleBusy, setToggleBusy] = useState(null); // key of the toggle currently saving

  // modal state: { mode:'create'|'edit', id?, form }
  const [modal, setModal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null); // row pending delete confirm

  // ---- loaders ----
  const loadNetworks = useCallback(() => api.get('/admin/plans/data/networks').then((r) => setNetworks(r.data || [])), []);
  const loadCableProviders = useCallback(() => api.get('/admin/plans/cable/providers').then((r) => setCableProviders(r.data || [])), []);

  const loadRows = useCallback(async (which) => {
    setLoading(true);
    try {
      if (which === 'data') {
        const [, plans] = await Promise.all([loadNetworks(), api.get('/admin/plans/data')]);
        setRows(plans.data || []);
      } else if (which === 'cable') {
        const [, plans] = await Promise.all([loadCableProviders(), api.get('/admin/plans/cable')]);
        setRows(plans.data || []);
      } else {
        const discos = await api.get('/admin/plans/electricity');
        setRows(discos.data || []);
      }
    } catch (err) {
      toast.error('Could not load plans', err.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [loadNetworks, loadCableProviders, toast]);

  useEffect(() => { loadRows(tab); }, [tab, loadRows]);

  // ---- name lookups (datanetwork/cableprovider tinyint -> label) ----
  // Declared ABOVE the filter memo that calls them. As consts they are in the
  // temporal dead zone until this line runs, and the memo body executes during
  // the same render pass — declaring them lower down threw "Cannot access
  // 'networkName' before initialization" and took the whole page down.
  const networkName = (id) => networks.find((n) => n.nId === Number(id))?.network || `Network ${id}`;
  const cableName = (id) => cableProviders.find((c) => c.cId === Number(id))?.provider || `Provider ${id}`;

  // ---- filtering (client-side, runs before paging) ----
  // Searches the fields an operator actually knows a plan by: its name, the
  // provider plan ID they cross-check against the provider dashboard, and the
  // network/DisCo name. Matching on networkLabel() too, so typing "T2" finds
  // 9MOBILE plans — the DB name is never what the admin sees on screen.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    return rows.filter((row) => {
      if (tab === 'data') {
        if (netFilter && String(row.datanetwork) !== String(netFilter)) return false;
        if (typeFilter && String(row.type || '').toLowerCase() !== typeFilter.toLowerCase()) return false;
      } else if (tab === 'cable') {
        if (netFilter && String(row.cableprovider) !== String(netFilter)) return false;
      }
      if (!q) return true;

      const haystack = tab === 'data'
        ? [row.name, row.planid, row.type, networkName(row.datanetwork), networkLabel(networkName(row.datanetwork))]
        : tab === 'cable'
          ? [row.name, row.planid, row.type, cableName(row.cableprovider)]
          : [row.provider, row.abbreviation, row.electricityid];

      return haystack.some((v) => String(v ?? '').toLowerCase().includes(q));
    });
  }, [rows, search, netFilter, typeFilter, tab, networks, cableProviders]); // eslint-disable-line react-hooks/exhaustive-deps

  // Any filter change can shrink the list under the current page.
  useEffect(() => { setPage(1); }, [search, netFilter, typeFilter]);

  // ---- paging (client-side) ----
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  // Switching tabs swaps the whole dataset, so start at the top again —
  // otherwise moving from a long data list to a 3-row DisCo list lands on
  // an empty page 4.
  useEffect(() => { setPage(1); }, [tab]);

  // Deleting the last row on the final page would strand us past the end.
  // Clamp instead of resetting to 1, so removing one row keeps you in place.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pageRows = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page]
  );

  // Human-readable range for the footer ("11–20 of 47").
  const firstShown = filtered.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(page * PAGE_SIZE, filtered.length);
  const filtersActive = !!(search.trim() || netFilter || typeFilter);

  // ---- toggles ----
  const toggleDataType = async (net, type) => {
    const key = `data-${net.nId}-${type}`;
    setToggleBusy(key);
    try {
      const r = await api.patch(`/admin/plans/data/network/${net.nId}/toggle/${type}`);
      toast.success(r.msg || 'Updated');
      await loadNetworks();
    } catch (err) {
      toast.error('Could not toggle', err.message);
    } finally { setToggleBusy(null); }
  };

  const toggleDataPlan = async (plan) => {
    const key = `plan-${plan.pId}`;
    setToggleBusy(key);
    try {
      const r = await api.patch(`/admin/plans/data/${plan.pId}/toggle`);
      toast.success(r.msg || 'Updated');
      await loadRows('data');
    } catch (err) {
      toast.error('Could not toggle', err.message);
    } finally { setToggleBusy(null); }
  };

  const toggleCable = async (prov) => {
    const key = `cable-${prov.cId}`;
    setToggleBusy(key);
    try {
      const r = await api.patch(`/admin/plans/cable/provider/${prov.cId}/toggle`);
      toast.success(r.msg || 'Updated');
      await loadCableProviders();
    } catch (err) {
      toast.error('Could not toggle', err.message);
    } finally { setToggleBusy(null); }
  };

  const toggleElectricity = async (disco) => {
    const key = `elec-${disco.eId}`;
    setToggleBusy(key);
    try {
      const r = await api.patch(`/admin/plans/electricity/${disco.eId}/toggle`);
      toast.success(r.msg || 'Updated');
      await loadRows('electricity');
    } catch (err) {
      toast.error('Could not toggle', err.message);
    } finally { setToggleBusy(null); }
  };

  // ---- create / edit modals ----
  const emptyData = { name: '', datanetwork: networks[0]?.nId || 1, type: 'SME', planid: '', price: '', userprice: '', agentprice: '', vendorprice: '', day: '30' };
  const emptyCable = { name: '', cableprovider: cableProviders[0]?.cId || 1, type: '', planid: '', price: '', userprice: '', agentprice: '', vendorprice: '', day: '30' };
  const emptyElec = { electricityid: '', provider: '', abbreviation: '' };

  const openCreate = () => {
    if (tab === 'data') setModal({ mode: 'create', form: { ...emptyData } });
    else if (tab === 'cable') setModal({ mode: 'create', form: { ...emptyCable } });
    else setModal({ mode: 'create', form: { ...emptyElec } });
  };

  const openEdit = (row) => {
    if (tab === 'data') {
      setModal({ mode: 'edit', id: row.pId, form: {
        name: row.name, datanetwork: row.datanetwork, type: row.type || 'SME', planid: row.planid,
        price: row.price, userprice: row.userprice, agentprice: row.agentprice, vendorprice: row.vendorprice, day: row.day,
      }});
    } else if (tab === 'cable') {
      setModal({ mode: 'edit', id: row.cpId, form: {
        name: row.name, cableprovider: row.cableprovider, type: row.type || '', planid: row.planid,
        price: row.price, userprice: row.userprice, agentprice: row.agentprice, vendorprice: row.vendorprice, day: row.day,
      }});
    } else {
      setModal({ mode: 'edit', id: row.eId, form: {
        electricityid: row.electricityid, provider: row.provider, abbreviation: row.abbreviation,
      }});
    }
  };

  const setField = (k, v) => setModal((m) => ({ ...m, form: { ...m.form, [k]: v } }));

  const save = async () => {
    const f = modal.form;
    // per-tab required-field validation (mirrors backend)
    if (tab === 'data') {
      if (!f.name || !f.planid || !f.price || !f.userprice || !f.agentprice || !f.vendorprice || !f.type || !f.datanetwork || !f.day)
        return toast.error('All fields are required.');
    } else if (tab === 'cable') {
      if (!f.name || !f.planid || !f.price || !f.userprice || !f.agentprice || !f.vendorprice || !f.cableprovider || !f.day)
        return toast.error('All fields are required (package type is optional).');
    } else {
      if (!f.electricityid || !f.provider || !f.abbreviation)
        return toast.error('DisCo code, name and abbreviation are required.');
    }

    const base = tab === 'data' ? '/admin/plans/data' : tab === 'cable' ? '/admin/plans/cable' : '/admin/plans/electricity';
    setSaving(true);
    try {
      if (modal.mode === 'create') await api.post(base, f);
      else await api.put(`${base}/${modal.id}`, f);
      toast.success(modal.mode === 'create' ? 'Added' : 'Saved');
      setModal(null);
      loadRows(tab);
    } catch (err) {
      toast.error('Save failed', err.message);
    } finally { setSaving(false); }
  };

  const doDelete = async () => {
    const row = confirmDel;
    const base = tab === 'data' ? '/admin/plans/data' : tab === 'cable' ? '/admin/plans/cable' : '/admin/plans/electricity';
    const id = tab === 'data' ? row.pId : tab === 'cable' ? row.cpId : row.eId;
    try {
      await api.del(`${base}/${id}`);
      toast.success('Removed');
      setConfirmDel(null);
      loadRows(tab);
    } catch (err) {
      toast.error('Could not remove', err.message);
    }
  };

  const rowName = (row) => tab === 'electricity' ? row.provider : row.name;

  return (
    <>
      <div className="row between wrap mb-2">
        <div>
          <h1 className="page-title" style={{ marginBottom: 2 }}>Plans</h1>
          <p className="page-sub" style={{ margin: 0 }}>Add, edit, remove and enable/disable your data, cable and electricity offerings.</p>
        </div>
        <button className="btn" onClick={openCreate}>
          <IcPlus size={18} /> Add {tab === 'electricity' ? 'DisCo' : `${tab} plan`}
        </button>
      </div>

      {/* Tabs */}
      <div className="row wrap mb-2" style={{ gap: 8 }}>
        {TABS.map((t) => (
          <button key={t.id} className={`btn btn-sm ${tab === t.id ? '' : 'btn-soft'}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Enable/disable panel (the net-new capability over legacy PHP) */}
      {tab === 'data' && (
        <div className="card mb-2">
          <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <IcLayers size={18} /><strong>Enable / disable data plan types</strong>
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            Turn a network's SME / Gifting / Corporate plans on or off for the whole site.
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Network</th><th>SME</th><th>Gifting</th><th>Corporate</th></tr></thead>
              <tbody>
                {networks.map((n) => (
                  <tr key={n.nId}>
                    <td className="strong">{networkLabel(n.network)}</td>
                    {['sme', 'gifting', 'corporate'].map((tp) => (
                      <td key={tp}>
                        <TogglePill on={n[tp]} label={tp.toUpperCase()} busy={toggleBusy === `data-${n.nId}-${tp}`}
                          onClick={() => toggleDataType(n, tp)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'cable' && (
        <div className="card mb-2">
          <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <IcLayers size={18} /><strong>Enable / disable cable providers</strong>
          </div>
          <div className="row wrap" style={{ gap: 10 }}>
            {cableProviders.map((c) => (
              <TogglePill key={c.cId} on={c.enabled} label={c.provider} busy={toggleBusy === `cable-${c.cId}`}
                onClick={() => toggleCable(c)} />
            ))}
          </div>
        </div>
      )}

      {/* Search + filters */}
      <div className="card mb-2">
        <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
          <div className="field" style={{ margin: 0, flex: '1 1 240px' }}>
            <label className="label">Search</label>
            <input
              className="input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tab === 'electricity' ? 'DisCo name, abbreviation or code' : 'Plan name or provider plan ID'}
            />
          </div>

          {tab === 'data' && (
            <>
              <div className="field" style={{ margin: 0, flex: '0 1 170px' }}>
                <label className="label">Network</label>
                <select className="select" value={netFilter} onChange={(e) => setNetFilter(e.target.value)}>
                  <option value="">All networks</option>
                  {networks.map((n) => (
                    <option key={n.nId} value={n.nId}>{networkLabel(n.network)}</option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ margin: 0, flex: '0 1 150px' }}>
                <label className="label">Type</label>
                <select className="select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                  <option value="">All types</option>
                  <option value="SME">SME</option>
                  <option value="Gifting">Gifting</option>
                  <option value="Corporate">Corporate</option>
                </select>
              </div>
            </>
          )}

          {tab === 'cable' && (
            <div className="field" style={{ margin: 0, flex: '0 1 170px' }}>
              <label className="label">Provider</label>
              <select className="select" value={netFilter} onChange={(e) => setNetFilter(e.target.value)}>
                <option value="">All providers</option>
                {cableProviders.map((c) => (
                  <option key={c.cId} value={c.cId}>{c.provider}</option>
                ))}
              </select>
            </div>
          )}

          {filtersActive && (
            <button className="btn btn-soft btn-sm"
              onClick={() => { setSearch(''); setNetFilter(''); setTypeFilter(''); }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Main rows table */}
      <div className="card">
        {loading ? <Loader /> : filtered.length === 0 ? (
          filtersActive ? (
            <Empty title="No matches" message="No rows match your search or filters.">
              <button className="btn btn-soft mt-1"
                onClick={() => { setSearch(''); setNetFilter(''); setTypeFilter(''); }}>Clear filters</button>
            </Empty>
          ) : (
            <Empty title={`No ${tab === 'electricity' ? 'DisCos' : 'plans'} yet`} message="Add one to get started.">
              <button className="btn mt-1" onClick={openCreate}><IcPlus size={16} /> Add {tab === 'electricity' ? 'DisCo' : `${tab} plan`}</button>
            </Empty>
          )
        ) : (
          <div className="table-wrap">
            <table className="table">
              {tab === 'data' && (
                <thead><tr><th>Name</th><th>Network</th><th>Type</th><th>Plan ID</th><th>Buy</th><th>User</th><th>Agent</th><th>Vendor</th><th>Days</th><th>Status</th><th></th></tr></thead>
              )}
              {tab === 'cable' && (
                <thead><tr><th>Name</th><th>Provider</th><th>Package</th><th>Plan ID</th><th>Buy</th><th>User</th><th>Agent</th><th>Vendor</th><th>Days</th><th></th></tr></thead>
              )}
              {tab === 'electricity' && (
                <thead><tr><th>DisCo</th><th>Abbr.</th><th>DisCo code</th><th>Status</th><th></th></tr></thead>
              )}
              <tbody>
                {pageRows.map((row) => tab === 'data' ? (
                  <tr key={row.pId}>
                    <td className="strong">{row.name}</td>
                    <td className="small muted">{networkName(row.datanetwork)}</td>
                    <td className="small">{row.type}</td>
                    <td className="small muted">{row.planid}</td>
                    <td className="small">{formatNaira(row.price)}</td>
                    <td className="small">{formatNaira(row.userprice)}</td>
                    <td className="small">{formatNaira(row.agentprice)}</td>
                    <td className="small">{formatNaira(row.vendorprice)}</td>
                    <td className="small muted">{row.day}</td>
                    <td>
                      <TogglePill
                        on={row.enabled !== false}
                        label={row.enabled !== false ? 'Enabled' : 'Disabled'}
                        busy={toggleBusy === `plan-${row.pId}`}
                        onClick={() => toggleDataPlan(row)}
                      />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(row)}>Edit</button>
                        <button className="btn btn-soft btn-sm" onClick={() => setConfirmDel(row)}><IcTrash size={15} /></button>
                      </div>
                    </td>
                  </tr>
                ) : tab === 'cable' ? (
                  <tr key={row.cpId}>
                    <td className="strong">{row.name}</td>
                    <td className="small muted">{cableName(row.cableprovider)}</td>
                    <td className="small">{row.type || '—'}</td>
                    <td className="small muted">{row.planid}</td>
                    <td className="small">{formatNaira(row.price)}</td>
                    <td className="small">{formatNaira(row.userprice)}</td>
                    <td className="small">{formatNaira(row.agentprice)}</td>
                    <td className="small">{formatNaira(row.vendorprice)}</td>
                    <td className="small muted">{row.day}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(row)}>Edit</button>
                        <button className="btn btn-soft btn-sm" onClick={() => setConfirmDel(row)}><IcTrash size={15} /></button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={row.eId}>
                    <td className="strong">{row.provider}</td>
                    <td className="small muted">{row.abbreviation}</td>
                    <td className="small muted">{row.electricityid}</td>
                    <td>
                      <TogglePill on={row.enabled} label={row.enabled ? 'Enabled' : 'Disabled'} busy={toggleBusy === `elec-${row.eId}`}
                        onClick={() => toggleElectricity(row)} />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(row)}>Edit</button>
                        <button className="btn btn-soft btn-sm" onClick={() => setConfirmDel(row)}><IcTrash size={15} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination — hidden when everything already fits on one page. */}
        {!loading && filtered.length > PAGE_SIZE && (
          <div className="row between wrap mt-2" style={{ alignItems: 'center' }}>
            <div className="small muted">
              {firstShown}–{lastShown} of {filtered.length}
              {filtersActive && rows.length !== filtered.length ? ` (filtered from ${rows.length})` : ''} · page {page} of {totalPages}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn btn-soft btn-sm" disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</button>
              <button className="btn btn-soft btn-sm" disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</button>
            </div>
          </div>
        )}
      </div>

      {/* Add / edit modal */}
      <Modal open={!!modal} onClose={() => !saving && setModal(null)}
        title={`${modal?.mode === 'create' ? 'Add' : 'Edit'} ${tab === 'electricity' ? 'DisCo' : `${tab} plan`}`} maxWidth={560}>
        {modal && (
          <div>
            {tab === 'electricity' ? (
              <>
                <div className="field">
                  <label className="label">DisCo name</label>
                  <input className="input" value={modal.form.provider} onChange={(e) => setField('provider', e.target.value)} placeholder="e.g. Ikeja Electric" />
                </div>
                <div className="grid grid-2">
                  <div className="field" style={{ margin: 0 }}>
                    <label className="label">Abbreviation</label>
                    <input className="input" value={modal.form.abbreviation} onChange={(e) => setField('abbreviation', e.target.value)} placeholder="e.g. IE" />
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label className="label">DisCo code <span className="muted small">(sent to provider)</span></label>
                    <input className="input" value={modal.form.electricityid} onChange={(e) => setField('electricityid', e.target.value)} placeholder="e.g. 1" />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <label className="label">Plan name</label>
                  <input className="input" value={modal.form.name} onChange={(e) => setField('name', e.target.value)}
                    placeholder={tab === 'data' ? 'e.g. 1GB - 30 Days' : 'e.g. DStv Compact'} />
                </div>
                <div className="grid grid-2">
                  {tab === 'data' ? (
                    <>
                      <div className="field" style={{ margin: 0 }}>
                        <label className="label">Network</label>
                        <select className="select" value={modal.form.datanetwork} onChange={(e) => setField('datanetwork', e.target.value)}>
                          {networks.map((n) => <option key={n.nId} value={n.nId}>{networkLabel(n.network)}</option>)}
                        </select>
                      </div>
                      <div className="field" style={{ margin: 0 }}>
                        <label className="label">Type</label>
                        <select className="select" value={modal.form.type} onChange={(e) => setField('type', e.target.value)}>
                          <option value="SME">SME</option>
                          <option value="Gifting">Gifting</option>
                          <option value="Corporate">Corporate</option>
                        </select>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="field" style={{ margin: 0 }}>
                        <label className="label">Provider</label>
                        <select className="select" value={modal.form.cableprovider} onChange={(e) => setField('cableprovider', e.target.value)}>
                          {cableProviders.map((c) => <option key={c.cId} value={c.cId}>{c.provider}</option>)}
                        </select>
                      </div>
                      <div className="field" style={{ margin: 0 }}>
                        <label className="label">Package type <span className="muted small">(optional)</span></label>
                        <input className="input" value={modal.form.type} onChange={(e) => setField('type', e.target.value)} placeholder="e.g. change / renew" />
                      </div>
                    </>
                  )}
                </div>
                <div className="grid grid-2">
                  <div className="field" style={{ margin: 0 }}>
                    <label className="label">Plan ID <span className="muted small">(provider)</span></label>
                    <input className="input" value={modal.form.planid} onChange={(e) => setField('planid', e.target.value)} placeholder="Provider plan ID" />
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label className="label">Validity (days)</label>
                    <input className="input" value={modal.form.day} onChange={(e) => setField('day', e.target.value)} placeholder="e.g. 30" />
                  </div>
                </div>
                <PriceFields form={modal.form} setField={setField} />
              </>
            )}
            <button className="btn btn-block mt-2" onClick={save} disabled={saving}>
              {saving ? <span className="spinner" /> : (modal.mode === 'create' ? 'Add' : 'Save changes')}
            </button>
          </div>
        )}
      </Modal>

      {/* Delete confirm */}
      <Modal open={!!confirmDel} onClose={() => setConfirmDel(null)} title="Remove?" maxWidth={420}>
        {confirmDel && (
          <div>
            <p>Remove <strong>{rowName(confirmDel)}</strong>? This can't be undone.</p>
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-soft" onClick={() => setConfirmDel(null)}>Cancel</button>
              <button className="btn" onClick={doDelete}>Remove</button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
