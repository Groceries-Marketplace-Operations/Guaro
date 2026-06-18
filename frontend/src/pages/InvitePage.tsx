import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { invitationsApi } from '../api';

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', email: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (done) {
      const t = setTimeout(() => nav('/login', { replace: true }), 2500);
      return () => clearTimeout(t);
    }
  }, [done, nav]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setErr('');
    try {
      await invitationsApi.use(token!, form);
      setDone(true);
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: { message?: string | string[] } } };
      const msg = e2.response?.data?.message;
      setErr(Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Error accepting invitation'));
    } finally { setSaving(false); }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 24,
    }}>
      <div style={{
        width: '100%', maxWidth: 400,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', padding: 36,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
          <div style={{ width: 32, height: 32, background: 'var(--orange)', borderRadius: 8, flexShrink: 0 }} />
          <span style={{ fontWeight: 700, fontSize: '1rem', letterSpacing: '-0.02em' }}>DiDi Ops</span>
        </div>

        {done ? (
          <>
            <h2 style={{ marginBottom: 8 }}>Account created</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: 24 }}>
              Your account is ready. Redirecting you to sign in…
            </p>
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => nav('/login', { replace: true })}>
              Go to sign in now
            </button>
          </>
        ) : (
          <>
            <h2 style={{ marginBottom: 6 }}>Accept invitation</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: 24 }}>
              Enter your name and your <strong>@didi-labs.com</strong> Google email. You'll use that email to sign in.
            </p>

            {err && <div className="error-banner" style={{ marginBottom: 16 }}>{err}</div>}

            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label">Full name</label>
                <input
                  className="form-input"
                  placeholder="Jane Smith"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  required
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label className="form-label">Work email</label>
                <input
                  className="form-input"
                  type="email"
                  placeholder="jane@didi-labs.com"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  required
                />
              </div>
              <button className="btn btn-primary" type="submit" style={{ width: '100%', marginTop: 8 }} disabled={saving}>
                {saving ? 'Creating account…' : 'Create account'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
