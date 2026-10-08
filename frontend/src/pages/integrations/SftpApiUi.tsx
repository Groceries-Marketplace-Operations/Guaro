import { labels, message } from './sftp-api.types';
export function Badge({ status }: { status: string }) { return <span className={`sftp-badge sftp-${status}`}>{labels[status] ?? status}</span>; }
export function ErrorBox({ error }: { error: unknown }) { return error ? <div className="sftp-error" role="alert">{message(error)}</div> : null; }
export function Pager({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }) {
  return total > 20 ? <div className="sftp-actions sftp-pagination"><button className="btn btn-secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>Anterior</button><span>{page} / {Math.ceil(total / 20)}</span><button className="btn btn-secondary" disabled={page * 20 >= total} onClick={() => onChange(page + 1)}>Siguiente</button></div> : null;
}
