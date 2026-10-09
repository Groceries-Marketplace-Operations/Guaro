import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import client from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission } from '../../auth/permissions';
import SftpApiEditor from './SftpApiEditor';
import SftpApiUploads from './SftpApiUploads';
import { BASE, date } from './sftp-api.types';
import type { Mode, Rule, Run, Page } from './sftp-api.types';
import { Badge, ErrorBox, Pager } from './SftpApiUi';
export default function SftpApiDetail({ id }: { id: string }) {
  const { account } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [page, setPage] = useState(1);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [mode, setMode] = useState<Mode>('delta');
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState('');
  const query = useQuery({ queryKey: ['sftp-api', id], queryFn: () => client.get<Rule>(`${BASE}/${id}`).then(r => r.data), refetchInterval: 10_000 });
  const history = useQuery({ queryKey: ['sftp-api', id, 'runs', page], queryFn: () => client.get<Page<Run>>(`${BASE}/${id}/runs`, { params: { page } }).then(r => r.data), refetchInterval: 5000 });
  const execute = useMutation({ mutationFn: () => client.post(`${BASE}/${id}/run`, { mode }), onSuccess: result => { setNotice(result.data.queued ? 'Ejecución enviada a la cola.' : 'Ejecución guardada. Se encolará cuando el servicio esté disponible.'); setConfirmed(false); setPage(1); void qc.invalidateQueries({ queryKey: ['sftp-api'] }); } });
  const rule = query.data;
  const selected = history.data?.data.find(run => run.id === selectedRun?.id) ?? selectedRun;
  const busy = history.data?.data.some(run => ['running', 'pending'].includes(run.status));
  if (query.isPending) return <p role="status">Cargando configuración…</p>;
  if (!rule) return <ErrorBox error={query.error} />;
  if (editing) return <SftpApiEditor rule={rule} close={() => setEditing(false)} saved={() => { setEditing(false); void qc.invalidateQueries({ queryKey: ['sftp-api'] }); }} />;
  return <>
    <Link to="/integrations/sftp-api" className="sftp-back">← Todas las marcas</Link>
    <div className="sftp-heading"><div><h2>{rule.brand.brandName}</h2><p>Brand ID {rule.brand.brandId} · <span className={`sftp-badge ${rule.active ? 'sftp-succeeded' : ''}`}>{rule.active ? 'Automática activa' : 'Automática pausada'}</span></p></div>{hasPermission(account, 'integrations.sftp_api.configure') && <button className="btn btn-secondary" onClick={() => setEditing(true)}>Editar configuración</button>}</div>
    <div className="sftp-stats"><div className="card"><span>Última lectura SFTP</span><strong>{date(rule.lastReadAt)}</strong></div><div className="card"><span>Último envío aceptado</span><strong>{date(rule.lastUploadAt)}</strong></div><div className="card"><span>Próxima lectura</span><strong>{rule.active ? date(rule.nextRunAt) : 'Pausada'}</strong></div></div>
    <div className="sftp-detail-grid"><section className="card"><h3>Conexión y archivos</h3><dl><dt>Aplicación SFTP</dt><dd>{rule.sftpApplication.name}{(!rule.sftpApplication.active || rule.sftpApplication.deletedAt) && " · no disponible"}</dd><dt>Servidor</dt><dd>{rule.sftpApplication.username}@{rule.sftpApplication.host}:{rule.sftpApplication.port}</dd><dt>Ruta raíz SFTP</dt><dd>{rule.sftpApplication.rootPath?.trim() || '/upload'}</dd><dt>Antigüedad máxima</dt><dd>{rule.maxFileAgeMinutes} minutos</dd><dt>Regex</dt><dd className="sftp-mono">{rule.fileRegex}</dd><dt>Separador</dt><dd>{rule.delimiter === '\t' ? 'Tabulador' : rule.delimiter} · {rule.hasHeader ? 'Con encabezados' : 'Sin encabezados'}</dd><dt>Aplicación API DiDi Food</dt><dd>{rule.application.appName}{rule.application.deletedAt && " · no disponible"}</dd><dt>App ID</dt><dd>{rule.application.appId}</dd><dt>Tienda</dt><dd>{rule.shopSource === 'filename' ? `Nombre de archivo: ${rule.shopRegex}` : `Columna ${rule.mapping.app_shop_id}`}</dd></dl><details><summary>Ver mapeo de columnas</summary><dl>{Object.entries(rule.mapping).filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>Columna {v}</dd></div>)}</dl></details></section>
      <section className="card"><h3>Horarios de lectura</h3><p>Todos los días · America/Mexico_City</p><div className="sftp-times">{rule.schedules.map(s => <div key={s.time}><strong>{s.time}</strong><span>{s.mode === 'full' ? 'Full · menú y stock' : 'Delta · solo stock'}</span></div>)}</div>{hasPermission(account, 'integrations.sftp_api.execute') && <form className="sftp-manual" onSubmit={e => { e.preventDefault(); setNotice(''); execute.mutate(); }}><h4>Lectura manual</h4><label className="sftp-field">Tipo de carga<select className="form-input" value={mode} onChange={e => { setMode(e.target.value as Mode); setConfirmed(false); }}><option value="delta">Delta · solo stock</option><option value="full">Full · reemplazar menú y stock</option></select></label>{mode === 'full' && <label className="sftp-check"><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> Confirmo reemplazar el menú actual de las tiendas del archivo.</label>}<button type="submit" className="btn btn-primary" disabled={execute.isPending || busy}>{execute.isPending ? 'Encolando…' : busy ? 'Ejecución en curso' : 'Leer y cargar ahora'}</button><ErrorBox error={execute.error} />{notice && <p role="status">{notice}</p>}</form>}</section></div>
    <section className="card sftp-history"><h3>Historial de lecturas y cargas</h3><p>Menú “aceptado” indica recepción por la API, no confirmación de publicación. Todos los horarios se muestran en Ciudad de México.</p><ErrorBox error={history.error} />
      {history.isPending ? <p>Cargando historial…</p> : !history.data?.data.length ? <div className="sftp-empty"><h3>Todo listo para la primera lectura</h3><p>Ejecuta una lectura manual o activa los horarios automáticos.</p></div> : <div className="sftp-table-wrap"><table className="sftp-table"><thead><tr><th>Inicio · hora MX</th><th>Tipo</th><th>Archivos / envíos</th><th>Resultado</th><th>Detalle</th></tr></thead><tbody>{history.data.data.map(run => <tr key={run.id} onClick={() => setSelectedRun(run)} style={{ cursor: 'pointer' }} className={selected?.id === run.id ? 'selected' : ''}><td>{date(run.startedAt ?? run.createdAt)}<small>{run.trigger === 'manual' ? 'Manual' : 'Programada'}{run.finishedAt && ` · Fin: ${date(run.finishedAt)}`}</small></td><td>{run.mode === 'full' ? 'Full' : 'Delta'}</td><td>{run.filesRead} leídos · {run._count.uploads} envíos<small>{run.filesSkipped} ya procesados</small></td><td><Badge status={run.status} />{run.error && <small className="sftp-error-text">{run.error}</small>}</td><td><button className="btn btn-secondary" onClick={() => setSelectedRun(run)}>Ver envíos</button></td></tr>)}</tbody></table></div>}
      <Pager page={page} total={history.data?.total ?? 0} onChange={setPage} />
    </section>
    {selected && <SftpApiUploads key={selected.id} run={selected} ruleId={id} busy={Boolean(busy)} canDelete={hasPermission(account, 'integrations.sftp_api.configure')} onClose={() => setSelectedRun(null)} />}
  </>;
}
