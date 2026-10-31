import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../context/ToastContext';
import { Loader } from '../components/Loader';
import { formatDate } from '../config';
import { IcDownload, IcShield } from '../components/Icons';

export default function VerifyRecord() {
  const { vId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    api.get(`/verify/${vId}`)
      .then((r) => setRecord(r.data))
      .catch((err) => toast.error('Could not load record', err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vId]);

  const download = async () => {
    setDownloading(true);
    try {
      await api.download(`/verify/${vId}/slip`, `verification-${vId}.pdf`);
    } catch (err) {
      toast.error('Could not download slip', err.message);
    } finally {
      setDownloading(false);
    }
  };

  if (loading) return <Loader full />;
  if (!record) return null;

  const result = record.result || {};
  const photo = result.photoBase64;

  return (
    <>
      <button className="btn btn-ghost btn-sm mb-2" onClick={() => navigate('/app/verify')}>← Back</button>
      <h1 className="page-title">{record.label} Verification</h1>
      <p className="page-sub">Reference {record.transref} · {formatDate(record.date)}</p>

      <div className="grid grid-2">
        <div className="card card-pad-lg">
          {photo && (
            <img src={photo.startsWith('data:') ? photo : `data:image/jpeg;base64,${photo}`}
              alt="Verified" style={{ width: 120, height: 120, borderRadius: 12, objectFit: 'cover', marginBottom: 16, border: '2px solid var(--border)' }} />
          )}
          <div className="row mb-2" style={{ gap: 8, alignItems: 'center' }}>
            <span className="text-success"><IcShield size={20} /></span>
            <span className="strong" style={{ fontSize: 18 }}>{result.fullName || record.query}</span>
          </div>
          <div className="kv">
            {Object.entries(result).filter(([k]) => k !== 'photoBase64').map(([k, v]) => (
              <div className="kv-row" key={k}>
                <span className="muted small" style={{ textTransform: 'capitalize' }}>{k.replace(/([A-Z])/g, ' $1')}</span>
                <span className="strong small">{String(v)}</span>
              </div>
            ))}
          </div>
          <button className="btn mt-2" onClick={download} disabled={downloading}>
            {downloading ? <span className="spinner" /> : <><IcDownload size={18} /> Download verified slip</>}
          </button>
        </div>

        <div className="card card-pad-lg">
          <h3>Details</h3>
          <div className="kv">
            <div className="kv-row"><span className="muted small">Type</span><span className="strong small">{record.label}</span></div>
            <div className="kv-row"><span className="muted small">Query</span><span className="strong small">{record.query}</span></div>
            <div className="kv-row"><span className="muted small">Reference</span><span className="strong small">{record.transref}</span></div>
            <div className="kv-row"><span className="muted small">Date</span><span className="strong small">{formatDate(record.date)}</span></div>
          </div>
          <p className="muted small mt-2">The downloadable PDF slip includes a verified watermark and the photo on record where available.</p>
        </div>
      </div>
    </>
  );
}
