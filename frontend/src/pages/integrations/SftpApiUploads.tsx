import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import client from '../../api/client';
import Modal from '../../components/ui/Modal';
import { BASE, date } from './sftp-api.types';
import type { Page, Run, Upload } from './sftp-api.types';
import { Badge, ErrorBox, Pager } from './SftpApiUi';
import SftpApiFiles from './SftpApiFiles';
export default function SftpApiUploads({ run, ruleId, canDelete, busy, onClose }: { run: Run; ruleId: string; canDelete: boolean; busy: boolean; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState('');
  const query = useQuery({ queryKey: ['sftp-api', 'uploads', run.id, page], queryFn: () => client.get<Page<Upload>>(`${BASE}/runs/${run.id}/uploads`, { params: { page } }).then(r => r.data), refetchInterval: ['pending', 'running'].includes(run.status) ? 5000 : false });
  const payload = useQuery({ queryKey: ['sftp-api', 'payload', selected], queryFn: () => client.get<Upload>(`${BASE}/uploads/${selected}/payload`).then(r => r.data), enabled: Boolean(selected) });
  function download(value: Upload) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `sftp-api-${value.id}.json`; anchor.click(); URL.revokeObjectURL(url);
  }
  return <div className="sftp-uploads-modal" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}><Modal title="Archivos y envíos de la ejecución" onClose={onClose} footer={<button type="button" autoFocus className="btn btn-secondary" onClick={onClose}>Cerrar</button>}>
    <div className="sftp-uploads-modal-body"><p className="sftp-mono">{run.id}</p><p>{date(run.startedAt ?? run.createdAt)} · {run.mode === 'full' ? 'Full' : 'Delta'} · {query.data?.total ?? run._count.uploads} envíos</p>
    <SftpApiFiles ruleId={ruleId} runId={run.id} canDelete={canDelete} busy={busy} />
    <h3>Envíos a la API</h3><p>Envíos por tienda de esta ejecución. Consulta todas las páginas para ver cada registro y su JSON.</p><ErrorBox error={query.error} />
    {query.isPending ? <p role="status">Cargando envíos…</p> : !query.data?.data.length ? <p>Aún no hay envíos para esta ejecución.</p> : <div className="sftp-table-wrap"><table className="sftp-table"><thead><tr><th>Tienda / archivo</th><th>Envío · hora MX</th><th>Productos</th><th>Resultado</th><th>Detalle</th></tr></thead><tbody>{query.data.data.map(upload => <Fragment key={upload.id}><tr className={selected === upload.id ? 'selected' : undefined}><td><strong>{upload.shopId}</strong><small>{upload.fileName}</small></td><td>{date(upload.sentAt)}</td><td>{upload.itemCount}</td><td><Badge status={upload.status} /><small>{upload.httpStatus ? `HTTP ${upload.httpStatus}` : 'Sin respuesta HTTP'}</small></td><td><button className="btn btn-secondary" aria-expanded={selected === upload.id} aria-controls={selected === upload.id ? `upload-detail-${upload.id}` : undefined} onClick={() => setSelected(current => current === upload.id ? '' : upload.id)}>{selected === upload.id ? 'Ocultar JSON' : 'Ver JSON'}</button></td></tr>
      {selected === upload.id && <tr className="sftp-json-row"><td colSpan={5}><div id={`upload-detail-${upload.id}`}><div className="sftp-json-panel"><div className="sftp-heading"><h3>Detalle del envío</h3><div className="sftp-actions">{payload.data && <button className="btn btn-secondary" onClick={() => download(payload.data)}>Descargar JSON</button>}<button className="btn btn-secondary" onClick={() => setSelected('')}>Cerrar</button></div></div><ErrorBox error={payload.error} />{payload.isPending && <p>Cargando JSON…</p>}{payload.data && <><p>{payload.data.sentAtMx} · {payload.data.durationMs ?? '—'} ms</p><p className="sftp-mono">{payload.data.endpoint}{payload.data.taskId && ` · taskID: ${payload.data.taskId}`}</p>{payload.data.error && <p className="sftp-error">{payload.data.error}</p>}<h4>JSON enviado</h4><pre>{JSON.stringify(payload.data.payload, null, 2)}</pre><h4>Respuesta API</h4><pre>{JSON.stringify(payload.data.response, null, 2)}</pre></>}</div></div></td></tr>}
    </Fragment>)}</tbody></table></div>}
    <Pager page={page} total={query.data?.total ?? 0} onChange={nextPage => { setSelected(''); setPage(nextPage); }} />
    </div>
  </Modal></div>;
}
