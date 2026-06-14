import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import { sectionsApi } from '../../api';
import type { Section } from '../../types';

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

export default function SectionsList() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const { data: sections = [], isLoading } = useQuery<Section[]>({
    queryKey: ['sections'],
    queryFn: () => sectionsApi.list().then(r => r.data),
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      await sectionsApi.create({ name });
      qc.invalidateQueries({ queryKey: ['sections'] });
      setOpen(false); setName('');
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: { message?: string } } };
      setErr(e2.response?.data?.message ?? 'Error');
    } finally { setSaving(false); }
  };

  return (
    <>
      <Topbar breadcrumb={[{ label: 'Sections' }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>Sections</h1>
            <p>Teams that group task types and accounts</p>
          </div>
          <button className="btn btn-primary" onClick={() => setOpen(true)}><PlusIcon /> New Section</button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Task Types</th><th>Members</th><th>Created</th></tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={4} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>Loading…</td></tr>}
              {!isLoading && sections.length === 0 && (
                <tr><td colSpan={4}><div className="empty-state"><h3>No sections</h3><p>Create your first section to organize teams.</p></div></td></tr>
              )}
              {sections.map(s => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{s.name}</td>
                  <td>{s._count?.taskTypes ?? 0}</td>
                  <td>{s._count?.accounts ?? 0}</td>
                  <td className="text-muted text-sm">{new Date(s.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>

      {open && (
        <Modal title="New Section" onClose={() => setOpen(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>{saving ? 'Creating…' : 'Create'}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">Section Name</label>
            <input className="form-input" placeholder="Operations MX" value={name}
              onChange={e => setName(e.target.value)} required autoFocus />
          </div>
        </Modal>
      )}
    </>
  );
}
