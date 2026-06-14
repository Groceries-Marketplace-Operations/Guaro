import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import { brandsApi, shopsApi, tasksApi, taskTypesApi, applicationsApi, accountsApi } from '../../api';
import type { Brand, Shop, Task, TaskType, Paginated, Application, Country } from '../../types';

const COUNTRY_EMOJI: Record<string, string> = { MX: '🇲🇽', CO: '🇨🇴', CR: '🇨🇷' };

export default function BrandDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'shops' | 'tasks'>('shops');
  const [openTask, setOpenTask] = useState(false);
  const [taskTypeId, setTaskTypeId] = useState('');
  const [saving, setSaving] = useState(false);

  // Change application modal
  const [openChangeApp, setOpenChangeApp] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [savingApp, setSavingApp] = useState(false);

  // Change OP modal
  const [openChangeOp, setOpenChangeOp] = useState(false);
  const [selectedOwnerId, setSelectedOwnerId] = useState('');
  const [savingOp, setSavingOp] = useState(false);

  const { data: brand, refetch: refetchBrand } = useQuery<Brand>({
    queryKey: ['brand', id],
    queryFn: () => brandsApi.get(id!).then(r => r.data),
  });
  const { data: shopsResult } = useQuery<Paginated<Shop>>({
    queryKey: ['shops', { brandId: id, limit: 500 }],
    queryFn: () => shopsApi.list({ brandId: id, limit: 500 }).then(r => r.data as Paginated<Shop>),
  });
  const { data: tasksResult } = useQuery<Paginated<Task>>({
    queryKey: ['tasks', { brandId: id, limit: 100 }],
    queryFn: () => tasksApi.list({ brandId: id, limit: 100 }).then(r => r.data as Paginated<Task>),
  });
  const shops = shopsResult?.data ?? [];
  const tasks = tasksResult?.data ?? [];
  const { data: types = [] } = useQuery<TaskType[]>({
    queryKey: ['task-types'],
    queryFn: () => taskTypesApi.list().then(r => r.data),
  });

  // Load BPOs for OP picker
  const { data: bpos = [] } = useQuery<{ id: string; name: string; email: string }[]>({
    queryKey: ['accounts', { role: 'bpo' }],
    queryFn: () => accountsApi.list('bpo').then(r => r.data),
    enabled: openChangeOp,
  });

  // Load applications for this brand's country
  const { data: appsResult } = useQuery<Paginated<Application>>({
    queryKey: ['applications', { country: brand?.country, limit: 100 }],
    queryFn: () => applicationsApi.list({ country: brand?.country, limit: 100 }).then(r => r.data as Paginated<Application>),
    enabled: !!brand?.country && openChangeApp,
  });
  const availableApps = appsResult?.data ?? [];

  const createTask = async () => {
    if (!taskTypeId) return;
    setSaving(true);
    try {
      const res = await tasksApi.create({ taskTypeId, brandId: id });
      qc.invalidateQueries({ queryKey: ['tasks', id] });
      setOpenTask(false);
      nav(`/tasks/${res.data.id}`);
    } finally { setSaving(false); }
  };

  const openOpModal = () => {
    setSelectedOwnerId(brand?.owner?.id ?? '');
    setOpenChangeOp(true);
  };

  const handleChangeOp = async () => {
    setSavingOp(true);
    try {
      await brandsApi.update(id!, { ownerId: selectedOwnerId || null });
      await refetchBrand();
      qc.invalidateQueries({ queryKey: ['brands'] });
      setOpenChangeOp(false);
    } finally { setSavingOp(false); }
  };

  const openAppModal = () => {
    setSelectedAppId(brand?.application?.id ?? '');
    setOpenChangeApp(true);
  };

  const handleChangeApp = async () => {
    setSavingApp(true);
    try {
      await brandsApi.update(id!, { applicationId: selectedAppId || null });
      await refetchBrand();
      qc.invalidateQueries({ queryKey: ['brands'] });
      setOpenChangeApp(false);
    } finally { setSavingApp(false); }
  };

  if (!brand) return null;

  return (
    <>
      <Topbar breadcrumb={[{ label: 'Brands', href: '/brands' }, { label: brand.brandName }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{brand.brandName}</h1>
            <p>{COUNTRY_EMOJI[brand.country]} {brand.country} · {brand.kaType}</p>
          </div>
          <div className="page-actions">
            <button className="btn btn-primary" onClick={() => setOpenTask(true)}>Start Task</button>
          </div>
        </div>

        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 24 }}>
          <div className="stat-card">
            <div className="s-label">Brand ID</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem', fontWeight: 600, marginTop: 4 }}>{brand.brandId}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">Owner (OP)</div>
            <div style={{ fontWeight: 600, marginTop: 4, fontSize: '0.9rem' }}>{brand.owner?.name ?? '—'}</div>
            <div className="s-meta">{brand.owner?.email ?? 'Unassigned'}</div>
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 6, fontSize: '0.72rem', padding: '2px 8px' }}
              onClick={openOpModal}
            >
              {brand.owner ? 'Change' : 'Assign'}
            </button>
          </div>
          <div className="stat-card">
            <div className="s-label">Application</div>
            <div style={{ fontWeight: 600, marginTop: 4, fontSize: '0.9rem' }}>
              {brand.application?.appName ?? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>None</span>}
            </div>
            {brand.application && <div className="s-meta td-mono">{brand.application.appId}</div>}
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 6, fontSize: '0.72rem', padding: '2px 8px' }}
              onClick={openAppModal}
            >
              {brand.application ? 'Change' : 'Link'}
            </button>
          </div>
          <div className="stat-card">
            <div className="s-label">Shops</div>
            <div className="s-value">{shops.length}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">Tasks</div>
            <div className="s-value">{tasks.length}</div>
          </div>
        </div>

        <div className="tabs">
          <div className={`tab ${tab === 'shops' ? 'active' : ''}`} onClick={() => setTab('shops')}>
            Shops ({shops.length})
          </div>
          <div className={`tab ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>
            Tasks ({tasks.length})
          </div>
        </div>

        {tab === 'shops' && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Shop ID</th><th>App Shop ID</th><th>City</th><th>Status</th></tr>
              </thead>
              <tbody>
                {shops.length === 0 && <tr><td colSpan={4}><div className="empty-state"><p>No shops for this brand.</p></div></td></tr>}
                {shops.map(s => (
                  <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/shops/${s.id}`)}>
                    <td className="td-mono">{s.shopId}</td>
                    <td className="td-mono">{s.appShopId}</td>
                    <td>{s.city ?? '—'}</td>
                    <td><StatusBadge status={s.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'tasks' && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Task Type</th><th>Status</th><th>Created</th></tr>
              </thead>
              <tbody>
                {tasks.length === 0 && <tr><td colSpan={3}><div className="empty-state"><p>No tasks yet.</p></div></td></tr>}
                {tasks.map(t => (
                  <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/tasks/${t.id}`)}>
                    <td style={{ fontWeight: 600 }}>{t.taskType?.name ?? '—'}</td>
                    <td><StatusBadge status={t.status} /></td>
                    <td className="text-muted text-sm">{new Date(t.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {openTask && (
        <Modal title="Start Task" onClose={() => setOpenTask(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenTask(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={createTask} disabled={saving || !taskTypeId}>
              {saving ? 'Creating…' : 'Start Task'}
            </button>
          </>}
        >
          <div className="form-group">
            <label className="form-label">Task Type</label>
            <select className="form-select" value={taskTypeId} onChange={e => setTaskTypeId(e.target.value)}>
              <option value="">Select a task type…</option>
              {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        </Modal>
      )}

      {openChangeOp && (
        <Modal
          title="Cambiar OP (responsable de marca)"
          onClose={() => setOpenChangeOp(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenChangeOp(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleChangeOp} disabled={savingOp}>
              {savingOp ? 'Saving…' : 'Save'}
            </button>
          </>}
        >
          <p className="text-muted text-sm" style={{ marginBottom: 14 }}>
            Asignación manual — sobreescribe la regla automática de asignación.
          </p>
          <div className="form-group">
            <label className="form-label">BPO / Responsable</label>
            <select className="form-select" value={selectedOwnerId} onChange={e => setSelectedOwnerId(e.target.value)}>
              <option value="">Sin asignar</option>
              {bpos.map(b => (
                <option key={b.id} value={b.id}>{b.name} — {b.email}</option>
              ))}
            </select>
          </div>
        </Modal>
      )}

      {openChangeApp && (
        <Modal
          title="Link Application"
          onClose={() => setOpenChangeApp(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenChangeApp(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleChangeApp} disabled={savingApp}>
              {savingApp ? 'Saving…' : 'Save'}
            </button>
          </>}
        >
          <p className="text-muted text-sm" style={{ marginBottom: 14 }}>
            Only applications for {COUNTRY_EMOJI[brand.country as Country]} {brand.country} are shown.
          </p>
          <div className="form-group">
            <label className="form-label">Application</label>
            <select className="form-select" value={selectedAppId} onChange={e => setSelectedAppId(e.target.value)}>
              <option value="">None</option>
              {availableApps.map(a => (
                <option key={a.id} value={a.id}>{a.appName} ({a.appId})</option>
              ))}
            </select>
            {availableApps.length === 0 && (
              <p className="form-hint">No applications for {brand.country} yet. <a href="/applications" style={{ color: 'var(--orange)' }}>Create one →</a></p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
