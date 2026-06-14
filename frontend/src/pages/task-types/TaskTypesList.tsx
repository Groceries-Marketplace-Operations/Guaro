import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import { taskTypesApi, sectionsApi } from '../../api';
import type { TaskType, Section } from '../../types';

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

export default function TaskTypesList() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ name: '', description: '', sectionId: '', schedulable: false });

  const { data: types = [], isLoading } = useQuery<TaskType[]>({
    queryKey: ['task-types'],
    queryFn: () => taskTypesApi.list().then(r => r.data),
  });
  const { data: sections = [] } = useQuery<Section[]>({
    queryKey: ['sections'],
    queryFn: () => sectionsApi.list().then(r => r.data),
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      const res = await taskTypesApi.create(form);
      qc.invalidateQueries({ queryKey: ['task-types'] });
      setOpen(false);
      nav(`/task-types/${res.data.id}`);
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: { message?: string } } };
      setErr(Array.isArray(e2.response?.data?.message) ? e2.response!.data!.message!.join(', ') : (e2.response?.data?.message ?? 'Error'));
    } finally { setSaving(false); }
  };

  return (
    <>
      <Topbar breadcrumb={[{ label: 'Task Types' }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>Task Types</h1>
            <p>Workflow templates for your operations</p>
          </div>
          <button className="btn btn-primary" onClick={() => setOpen(true)}>
            <PlusIcon /> New Task Type
          </button>
        </div>

        {isLoading ? (
          <p className="text-muted">Loading…</p>
        ) : types.length === 0 ? (
          <div className="empty-state">
            <h3>No task types yet</h3>
            <p>Create a task type to define a workflow for your team.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {types.map(t => (
              <div key={t.id} className="card" style={{ cursor: 'pointer', transition: 'box-shadow 0.1s' }}
                onClick={() => nav(`/task-types/${t.id}`)}
                onMouseOver={e => (e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.07)')}
                onMouseOut={e => (e.currentTarget.style.boxShadow = 'none')}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{t.name}</div>
                  {t.schedulable && (
                    <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'var(--blue-bg)', color: 'var(--blue)' }}>
                      Schedulable
                    </span>
                  )}
                </div>
                {t.description && <p className="text-muted text-sm">{t.description}</p>}
                <div style={{ marginTop: 12, display: 'flex', gap: 16, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  <span>{t.stepDefinitions?.length ?? 0} steps</span>
                  <span>{t.formFields?.length ?? 0} fields</span>
                  <span>{t._count?.tasks ?? 0} tasks</span>
                </div>
                <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Section: {t.section?.name ?? '—'}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {open && (
        <Modal title="New Task Type" onClose={() => setOpen(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
              {saving ? 'Creating…' : 'Create & Configure'}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <form onSubmit={handleCreate}>
            <div className="form-group">
              <label className="form-label">Name</label>
              <input className="form-input" placeholder="Shop Onboarding" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
            </div>
            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea className="form-textarea" placeholder="Describe this workflow…" value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Section</label>
              <select className="form-select" value={form.sectionId} onChange={e => setForm(f => ({ ...f, sectionId: e.target.value }))} required>
                <option value="">Select section…</option>
                {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="form-check">
              <input type="checkbox" id="schedulable" checked={form.schedulable}
                onChange={e => setForm(f => ({ ...f, schedulable: e.target.checked }))} />
              <label htmlFor="schedulable" style={{ fontSize: '0.83rem', cursor: 'pointer' }}>
                Schedulable (tasks can be set to a future time window)
              </label>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
