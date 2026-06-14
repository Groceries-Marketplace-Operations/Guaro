interface PaginatorProps {
  page: number;
  total: number;
  limit: number;
  onChange: (page: number) => void;
}

export default function Paginator({ page, total, limit, onChange }: PaginatorProps) {
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const pages: (number | '…')[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (page > 3) pages.push('…');
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i);
    if (page < totalPages - 2) pages.push('…');
    pages.push(totalPages);
  }

  const btnStyle = (active: boolean, disabled = false): React.CSSProperties => ({
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: active ? 'var(--orange)' : 'var(--surface)',
    color: active ? '#fff' : disabled ? 'var(--border)' : 'var(--text-secondary)',
    cursor: disabled ? 'default' : 'pointer',
    fontSize: '0.8rem',
    fontWeight: active ? 700 : 400,
    minWidth: 32,
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderTop: '1px solid var(--border)', gap: 12 }}>
      <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        {total === 0 ? 'No results' : `${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total}`}
      </span>
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button style={btnStyle(false, page <= 1)} disabled={page <= 1} onClick={() => onChange(page - 1)}>‹</button>
          {pages.map((p, i) =>
            p === '…'
              ? <span key={`e${i}`} style={{ color: 'var(--text-muted)', padding: '0 4px', fontSize: '0.8rem' }}>…</span>
              : <button key={p} style={btnStyle(p === page)} onClick={() => p !== page && onChange(p as number)}>{p}</button>
          )}
          <button style={btnStyle(false, page >= totalPages)} disabled={page >= totalPages} onClick={() => onChange(page + 1)}>›</button>
        </div>
      )}
    </div>
  );
}
