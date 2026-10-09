import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import client from '../../api/client';
import Topbar from '../../components/layout/Topbar';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission } from '../../auth/permissions';
import SftpApiEditor from './SftpApiEditor';
import SftpApiDetail from './SftpApiDetail';
import { BASE, date } from './sftp-api.types';
import type { Rule } from './sftp-api.types';
import { Badge, ErrorBox } from './SftpApiUi';
import './sftp-api.css';
export default function SftpApiPage() {
  const { id } = useParams();
  const { account } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['sftp-api', 'rules'], queryFn: () => client.get<Rule[]>(BASE).then(r => r.data), enabled: !id, refetchInterval: 10_000 });
  const rules = query.data ?? [];
  const filtered = rules.filter(rule => `${rule.brand.brandName} ${rule.brand.brandId}`.toLowerCase().includes(search.toLowerCase()));
  return <><Topbar breadcrumb={[{ label: "Integrations" }, { label: "SFTP to API" }]} /><main className="main-content sftp-page"><div className="sftp-heading"><div><div className="sftp-eyebrow">INTEGRATIONS</div><h1>SFTP to API</h1><p>De tus archivos a tus tiendas. Menú y stock en los horarios que necesitas.</p></div>{!id && !creating && hasPermission(account, 'integrations.sftp_api.configure') && <button className="btn btn-primary" onClick={() => setCreating(true)}>+ Configurar marca</button>}</div>
    {id ? <SftpApiDetail key={id} id={id} /> : creating ? <SftpApiEditor close={() => setCreating(false)} saved={rule => { setCreating(false); void qc.invalidateQueries({ queryKey: ['sftp-api'] }); navigate(`/integrations/sftp-api/${rule.id}`); }} /> : <>
      <div className="sftp-stats"><div className="card"><span>Marcas configuradas</span><strong>{query.isPending ? '—' : rules.length}</strong></div><div className="card"><span>Lecturas automáticas activas</span><strong>{query.isPending ? '—' : rules.filter(r => r.active).length}</strong></div><div className="card"><span>Marcas con última ejecución en error</span><strong>{query.isPending ? '—' : rules.filter(r => ['failed', 'partial_failure', 'needs_review'].includes(r.runs?.[0]?.status ?? '')).length}</strong></div></div>
      <section className="card"><div className="sftp-heading"><h2>Tus marcas</h2><input aria-label="Buscar marca" className="form-input sftp-search" placeholder="Buscar por marca o Brand ID…" value={search} onChange={e => setSearch(e.target.value)} /></div><ErrorBox error={query.error} />
        {query.isPending ? <p role="status">Cargando marcas…</p> : !rules.length && !query.isError ? <div className="sftp-empty"><div className="sftp-empty-icon">↗</div><h3>Conecta tu primera marca</h3><p>Configura SFTP, relaciona las columnas y elige tus horarios.<br />Aquí verás cada lectura y cada envío a tus tiendas.</p>{hasPermission(account, 'integrations.sftp_api.configure') && <button className="btn btn-primary" onClick={() => setCreating(true)}>Configurar marca</button>}</div> : !filtered.length && !query.isError ? <p>No hay marcas que coincidan con la búsqueda.</p> : <div className="sftp-table-wrap"><table className="sftp-table"><thead><tr><th>Marca</th><th>Automatización</th><th>Última lectura MX</th><th>Último envío MX</th><th>Última ejecución</th></tr></thead><tbody>{filtered.map(rule => <tr key={rule.id}><td><Link className="sftp-brand-link" to={`/integrations/sftp-api/${rule.id}`}>{rule.brand.brandName} →</Link><small>{rule.brand.brandId} · {rule.schedules.length} horarios</small></td><td><span className={`sftp-badge ${rule.active ? 'sftp-succeeded' : ''}`}>{rule.active ? 'Activa' : 'Pausada'}</span><small>{rule.active && `Próxima: ${date(rule.nextRunAt)}`}</small></td><td>{date(rule.lastReadAt)}</td><td>{date(rule.lastUploadAt)}</td><td>{rule.runs?.[0] ? <Badge status={rule.runs[0].status} /> : 'Sin ejecuciones'}</td></tr>)}</tbody></table></div>}
      </section><p className="sftp-footnote">Zona horaria: America/Mexico_City · Full: menú completo y stock · Delta: únicamente stock</p>
    </>}
  </main></>;
}
