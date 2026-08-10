import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { authApi } from '../api';
import { useT } from '../i18n';

type DevAccount = {
  id: string;
  name: string;
  email: string;
  roles: string[];
  sectionName: string | null;
  permissions: string[];
};

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

type VoxelWorkerProps = {
  className: string;
  tool: 'monitor' | 'alert' | 'tablet' | 'calendar' | 'integration';
  badge: string;
};

const VoxelOrangeWorker = ({ className, tool, badge }: VoxelWorkerProps) => (
  <div className={`voxel-worker ${className}`} aria-hidden="true">
    <span className="voxel-worker-shadow" />
    <div className="voxel-orange-head">
      <span className="voxel-orange-leaf" />
      <span className="voxel-orange-eye eye-left" />
      <span className="voxel-orange-eye eye-right" />
      <span className="voxel-orange-smile" />
    </div>
    <div className="voxel-worker-body">
      <span className="voxel-worker-vest" />
      <span className="voxel-worker-badge">{badge}</span>
      <span className="voxel-worker-arm arm-left" />
      <span className="voxel-worker-arm arm-right" />
      <span className="voxel-worker-leg leg-left" />
      <span className="voxel-worker-leg leg-right" />
      <span className={`voxel-worker-tool tool-${tool}`}>
        {tool === 'monitor' && <><i /><i /><i /></>}
        {tool === 'alert' && <><i /><i /><i /></>}
        {tool === 'tablet' && <><i /><i /><i /></>}
        {tool === 'calendar' && <><i /><i /><i /><i /></>}
        {tool === 'integration' && <><i /><i /><i /><i /></>}
      </span>
    </div>
  </div>
);

const VoxelMetricChart = () => (
  <em className="metric-chart"><b /><b /><b /><b /><b /></em>
);

const VoxelOrangeWorld = () => (
  <div className="voxel-orange-world" aria-hidden="true">
    <div className="voxel-ceiling">
      <span className="ceiling-light light-one" />
      <span className="ceiling-light light-two" />
      <span className="ceiling-light light-three" />
    </div>

    <div className="grocery-control-wall">
      <div className="control-wall-title">
        <span>GROCERY CONTROL CENTER</span>
        <i /> LIVE
      </div>
      <div className="control-metric metric-completed"><i>✓</i><span>COMPLETED</span><strong>124</strong><VoxelMetricChart /></div>
      <div className="control-metric metric-cancelled"><i>×</i><span>CANCELED</span><strong>07</strong><VoxelMetricChart /></div>
      <div className="control-metric metric-emergency"><i>!</i><span>EMERGENCIES</span><strong>02</strong><VoxelMetricChart /></div>
      <div className="control-metric metric-operations"><i>◆</i><span>OPERATIONS</span><strong>38</strong><VoxelMetricChart /></div>
      <div className="control-metric metric-schedule"><i>◷</i><span>SCHEDULES</span><strong>09:00</strong><VoxelMetricChart /></div>
      <div className="control-metric metric-integrations"><i>↔</i><span>INTEGRATIONS</span><strong>16</strong><VoxelMetricChart /></div>
    </div>

    <div className="grocery-aisle aisle-produce">
      <span className="aisle-sign">GROCERY</span>
      <span className="aisle-shelf shelf-top" />
      <span className="aisle-shelf shelf-bottom" />
      <span className="produce-bin produce-oranges"><i /><i /><i /><i /><i /><i /></span>
      <span className="produce-bin produce-greens"><i /><i /><i /><i /><i /></span>
      <span className="produce-bin produce-tomatoes"><i /><i /><i /><i /><i /></span>
      <span className="produce-bin produce-bananas"><i /><i /><i /><i /></span>
    </div>

    <div className="grocery-cold-room">
      <span className="cold-room-sign">CHILLED</span>
      <span className="cold-room-door" />
      <span className="cold-room-window" />
      <span className="cold-room-snow snow-one">+</span>
      <span className="cold-room-snow snow-two">+</span>
      <span className="cold-room-snow snow-three">+</span>
    </div>

    <div className="voxel-floor floor-back" />

    <div className="grocery-control-desk">
      <span className="desk-monitor monitor-orders"><i /><VoxelMetricChart /><small>ORDERS</small></span>
      <span className="desk-monitor monitor-alerts"><i /><VoxelMetricChart /><small>ALERTS</small></span>
      <span className="desk-monitor monitor-integrations"><i /><VoxelMetricChart /><small>LINKS</small></span>
      <span className="desk-monitor monitor-ops"><i /><VoxelMetricChart /><small>OPS</small></span>
      <span className="desk-monitor monitor-hours"><i /><VoxelMetricChart /><small>SHIFTS</small></span>
      <span className="desk-surface" />
      <span className="desk-leg leg-one" />
      <span className="desk-leg leg-two" />
    </div>

    <div className="voxel-floor floor-front" />

    <VoxelOrangeWorker className="worker-orders" tool="monitor" badge="O" />
    <VoxelOrangeWorker className="worker-emergency" tool="alert" badge="E" />
    <VoxelOrangeWorker className="worker-integrations" tool="integration" badge="I" />
    <VoxelOrangeWorker className="worker-operations" tool="tablet" badge="X" />
    <VoxelOrangeWorker className="worker-schedule" tool="calendar" badge="H" />

    <span className="voxel-ping ping-one">✓</span>
    <span className="voxel-ping ping-two">!</span>
    <span className="voxel-ping ping-three">◷</span>

    <div className="grocery-world-caption">
      <span>GROCERY CONTROL</span>
      <strong>Orders, incidents, integrations and shifts in sync.</strong>
    </div>
  </div>
);

export default function Login() {
  const { account, loading, login } = useAuth();
  const nav = useNavigate();
  const t = useT();
  const [devEmail, setDevEmail] = useState('');
  const [devAccounts, setDevAccounts] = useState<DevAccount[]>([]);
  const [devAccountsLoading, setDevAccountsLoading] = useState(import.meta.env.DEV);
  const [devError, setDevError] = useState('');
  const [devLoading, setDevLoading] = useState(false);

  useEffect(() => {
    if (!loading && account) nav('/', { replace: true });
  }, [account, loading, nav]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    authApi.devAccounts()
      .then(response => {
        const accounts = response.data as DevAccount[];
        setDevAccounts(accounts);
        const remembered = localStorage.getItem('dev-login-email');
        const preferred = accounts.find(item => item.email === remembered)
          ?? accounts.find(item => item.email === 'eduardolarazarrabal@didi-labs.com')
          ?? accounts[0];
        setDevEmail(preferred?.email ?? '');
      })
      .catch(() => setDevError('No se pudo cargar la lista de usuarios locales.'))
      .finally(() => setDevAccountsLoading(false));
  }, []);

  const googleLogin = () => {
    window.location.href = `${import.meta.env.VITE_API_URL ?? 'http://localhost:3000'}/auth/google`;
  };

  const localLogin = async () => {
    setDevLoading(true);
    setDevError('');
    try {
      const tokenResponse = await authApi.devLogin(devEmail.trim());
      const token = tokenResponse.data.access_token as string;
      localStorage.setItem('dev-login-email', devEmail.trim());
      localStorage.setItem('token', token);
      const accountResponse = await authApi.me();
      login(accountResponse.data.token ?? token, accountResponse.data);
      nav('/', { replace: true });
    } catch {
      localStorage.removeItem('token');
      setDevError('No se pudo iniciar sesión con ese correo.');
    } finally {
      setDevLoading(false);
    }
  };

  const selectedDevAccount = devAccounts.find(item => item.email === devEmail);
  const groupedDevAccounts = devAccounts.reduce<Record<string, DevAccount[]>>((groups, item) => {
    const key = item.roles.join(' + ') || 'sin rol';
    (groups[key] ??= []).push(item);
    return groups;
  }, {});

  return (
    <div className="login-page">
      <div className="login-panel">
        <div className="login-logo-row">
          <img src={`${import.meta.env.BASE_URL}didi-logo.png`} alt="DiDi" style={{ width: 36, height: 36, objectFit: 'contain', borderRadius: 8 }} />
          <div className="texts">
            <div className="t1">Tequila 1.0</div>
            <div className="t2">{t('nav.internalPanel')}</div>
          </div>
        </div>

        <h1>{t('pages.login.title')}</h1>
        <p className="sub">{t('pages.login.subtitle')}</p>

        <button className="btn-google" onClick={googleLogin}>
          <GoogleIcon />
          {t('pages.login.continueWithGoogle')}
        </button>

        {import.meta.env.DEV && (
          <div style={{ marginTop: 24, display: 'grid', gap: 10 }}>
            <label htmlFor="dev-account" style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>
              Usuario local
            </label>
            <select
              id="dev-account"
              value={devEmail}
              onChange={(event) => setDevEmail(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void localLogin(); }}
              aria-label="Usuario para acceso local"
              disabled={devAccountsLoading}
              style={{ padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
            >
              {devAccountsLoading && <option value="">Cargando usuarios…</option>}
              {!devAccountsLoading && devAccounts.length === 0 && <option value="">No hay usuarios disponibles</option>}
              {Object.entries(groupedDevAccounts).map(([role, accounts]) => (
                <optgroup key={role} label={role}>
                  {accounts.map(item => (
                    <option key={item.id} value={item.email}>{item.name} — {item.email}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            {selectedDevAccount && (
              <div style={{ padding: '9px 11px', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: '0.72rem', lineHeight: 1.5 }}>
                <strong style={{ color: 'var(--text)' }}>{selectedDevAccount.roles.join(' + ')}</strong>
                {' · '}{selectedDevAccount.permissions.length} permisos
                {selectedDevAccount.sectionName && <>{' · '}{selectedDevAccount.sectionName}</>}
              </div>
            )}
            <button className="btn-google" onClick={() => void localLogin()} disabled={devLoading || devAccountsLoading || !devEmail.trim()}>
              {devLoading ? 'Ingresando…' : 'Acceder como este usuario'}
            </button>
            {devError && <p style={{ margin: 0, color: 'var(--danger)', fontSize: '0.8rem' }}>{devError}</p>}
          </div>
        )}

        <p style={{ marginTop: 32, fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
          {t('pages.login.domainNote').replace('@didi-labs.com', '')}
          <strong>@didi-labs.com</strong>
          {' accounts.'}
        </p>
      </div>

      <div className="login-aside">
        <VoxelOrangeWorld />
        <div className="login-aside-scrim" aria-hidden="true" />
        <div className="login-aside-logo">
          <img src={`${import.meta.env.BASE_URL}didi-logo.png`} alt="DiDi" style={{ width: 80, height: 80, objectFit: 'contain', borderRadius: 16, marginBottom: 16 }} />
          <strong>Tequila 1.0</strong>
          <p>Operations Panel<br />Task &amp; Workflow Management<br />for Delivery Brands</p>
        </div>
      </div>
    </div>
  );
}
