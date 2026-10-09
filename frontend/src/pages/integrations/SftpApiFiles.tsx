import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client from '../../api/client';
import { BASE, date } from './sftp-api.types';
import type { Page, ProcessedFile } from './sftp-api.types';
import { Badge, ErrorBox, Pager } from './SftpApiUi';

export default function SftpApiFiles({ ruleId, runId, canDelete, busy }: { ruleId: string; runId: string; canDelete: boolean; busy: boolean }) {
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState('');
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['sftp-api', ruleId, 'files', runId, page],
    queryFn: () => client.get<Page<ProcessedFile>>(`${BASE}/${ruleId}/files`, { params: { page, runId } }).then(r => r.data), refetchInterval: 5000 });
  const forget = useMutation({ mutationFn: (fileId?: string) => client.delete(`${BASE}/${ruleId}/files${fileId ? `/${fileId}` : ''}`, { params: { runId } }),
    onSuccess: () => { setPage(1); setNotice('Registro eliminado. El archivo podrá procesarse en la próxima lectura si cumple el regex y la antigüedad máxima.'); void qc.invalidateQueries({ queryKey: ['sftp-api', ruleId, 'files'] }); } });
  const remove = (file?: ProcessedFile) => {
    const target = file ? `el registro de ${file.fileName}` : 'todos los registros de archivos de esta ejecución';
    if (window.confirm(`¿Eliminar ${target}? Esto permite repetir sus envíos. El archivo SFTP y el historial de envíos se conservan.`)) {
      setNotice(''); forget.mutate(file?.id);
    }
  };
  return <section className="sftp-history">
    <div className="sftp-heading"><div><h3>Archivos registrados</h3><p>Cada nombre se procesa una sola vez por marca, tanto en Full como en Delta. Para repetirlo, elimina su registro.</p></div>
      {canDelete && <button className="btn btn-secondary" disabled={busy || forget.isPending || !query.data?.total} onClick={() => remove()}>Eliminar registros de esta ejecución</button>}</div>
    <p>Los errores también quedan registrados. Revisa el resultado antes de reprocesar: un archivo con varias tiendas volverá a enviar información a todas ellas. Se conserva el historial de envíos.</p>
    {busy && <p role="status">Espera a que termine la ejecución para eliminar registros.</p>}
    <ErrorBox error={query.error} /><ErrorBox error={forget.error} />{notice && <p role="status">{notice}</p>}
    {query.isPending ? <p>Cargando archivos…</p> : !query.data?.data.length ? <p>No hay registros de archivos en esta página de la ejecución. Los archivos omitidos por estar ya procesados pertenecen a su ejecución original.</p> :
      <div className="sftp-table-wrap"><table className="sftp-table"><thead><tr><th>Archivo</th><th>Modificación SFTP · MX</th><th>Procesamiento · MX</th><th>Resultado</th>{canDelete && <th>Acciones</th>}</tr></thead>
        <tbody>{query.data.data.map(file => <tr key={file.id}><td className="sftp-mono">{file.fileName}</td><td>{date(file.modifiedAt)}</td><td>{date(file.processedAt ?? file.createdAt)}</td>
          <td><Badge status={file.status} />{file.error && <small className="sftp-error-text">{file.error}</small>}</td>
          {canDelete && <td><button className="btn btn-secondary" disabled={busy || forget.isPending} onClick={() => remove(file)}>Eliminar registro</button></td>}</tr>)}</tbody></table></div>}
    <Pager page={page} total={query.data?.total ?? 0} onChange={setPage} />
  </section>;
}
