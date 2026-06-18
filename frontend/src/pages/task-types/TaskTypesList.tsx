import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import Paginator from '../../components/ui/Paginator';
import { taskTypesApi, sectionsApi } from '../../api';
import { useT } from '../../i18n';
import type { TaskType, Section, Paginated } from '../../types';

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

const LIMIT = 50;

export default function TaskTypesList() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ name: '', description: '', sectionId: '', schedulable: false });
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => { setDq(q); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  const params = { page, limit: LIMIT, ...(dq && { q: dq }) };

  const { data: result, isLoading } = useQuery<Paginated<TaskType>>({
    queryKey: ['task-types', params],
    queryFn: () => taskTypesApi.list(params).then(r => r.data as Paginated<TaskType>),
  });

  const types = result?.data ?? [];
  const total = result?.total ?? 0;
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

  const subtitle = total === 1
    ? t('pages.taskTypesList.subtitle').replace('{total}', String(total))
    : t('pages.taskTypesList.subtitlePlural').replace('{total}', String(total));

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.taskTypes') }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('pages.taskTypesList.title')}</h1>
            <p>{subtitle}</p>
          </div>
          <button className="btn btn-primary" onClick={() => setOpen(true)}>
            <PlusIcon /> {t('pages.taskTypesList.newTaskType')}
          </button>
        </div>

        <div className="toolbar" style={{ marginBottom: 16 }}>
          <input
            className="form-input"
            placeholder={t('pages.taskTypesList.searchPlaceholder')}
            value={q}
            onChange={e => setQ(e.target.value)}
            style={{ maxWidth: 280 }}
          />
        </div>

        {isLoading ? (
          <p className="text-muted">{t('common.loading')}</p>
        ) : types.length === 0 ? (
          <div className="empty-state">
            <h3>{t('pages.taskTypesList.noTaskTypesFound')}</h3>
            <p>{dq ? t('pages.taskTypesList.noTaskTypesHintSearch') : t('pages.taskTypesList.noTaskTypesHint')}</p>
          </div>
        ) : (
          <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {types.map(tp => (
              <div key={tp.id} className="card" style={{ cursor: 'pointer', transition: 'box-shadow 0.1s' }}
                onClick={() => nav(`/task-types/${tp.id}`)}
                onMouseOver={e => (e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.07)')}
                onMouseOut={e => (e.currentTarget.style.boxShadow = 'none')}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.95rem', color: tp.active === false ? 'var(--text-muted)' : undefined }}>{tp.name}</div>
                  <div style={{ display: 'flex', gap: 5 }}>
                    {tp.schedulable && (
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'var(--blue-bg)', color: 'var(--blue)' }}>
                        {t('pages.taskTypesList.schedulable')}
                      </span>
                    )}
                    {tp.active === false && (
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'rgba(180,40,40,0.12)', color: 'var(--red)' }}>
                        {t('pages.taskTypesList.hidden')}
                      </span>
                    )}
                  </div>
                </div>
                {tp.description && <p className="text-muted text-sm">{tp.description}</p>}
                <div style={{ marginTop: 12, display: 'flex', gap: 16, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  <span>{tp._count?.stepDefinitions ?? tp.stepDefinitions?.length ?? 0} {t('common.steps')}</span>
                  <span>{tp._count?.formFields ?? tp.formFields?.length ?? 0} {t('common.fields')}</span>
                  <span>{tp._count?.tasks ?? 0} {t('common.tasks')}</span>
                </div>
                <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {t('pages.taskTypesList.sectionLabel')}: {tp.section?.name ?? '—'}
                </div>
              </div>
            ))}
          </div>
          <Paginator page={page} total={total} limit={LIMIT} onChange={setPage} />
          </>
        )}
      </main>

      {open && (
        <Modal title={t('pages.taskTypesList.modalTitle')} onClose={() => setOpen(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
              {saving ? t('pages.taskTypesList.creating') : t('common.createConfigure')}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <form onSubmit={handleCreate}>
            <div className="form-group">
              <label className="form-label">{t('pages.taskTypesList.nameLabel')}</label>
              <input className="form-input" placeholder="Shop Onboarding" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
            </div>
            <div className="form-group">
              <label className="form-label">{t('pages.taskTypesList.descriptionLabel')}</label>
              <textarea className="form-textarea" placeholder="Describe this workflow…" value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('pages.taskTypesList.sectionFormLabel')}</label>
              <select className="form-select" value={form.sectionId} onChange={e => setForm(f => ({ ...f, sectionId: e.target.value }))} required>
                <option value="">{t('pages.taskTypesList.sectionPlaceholder')}</option>
                {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="form-check">
              <input type="checkbox" id="schedulable" checked={form.schedulable}
                onChange={e => setForm(f => ({ ...f, schedulable: e.target.checked }))} />
              <label htmlFor="schedulable" style={{ fontSize: '0.83rem', cursor: 'pointer' }}>
                {t('pages.taskTypesList.schedulableCheck')}
              </label>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
