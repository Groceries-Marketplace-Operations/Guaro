import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { applicationsApi } from '../../api';
import type { Application, Paginated } from '../../types';

interface ApplicationSearchFieldProps {
  value: string;
  displayValue: string;
  onChange: (applicationId: string, displayValue: string, application?: Application) => void;
  placeholder?: string;
}

function applicationLabel(application: Application) {
  return `${application.appName} · ${application.country} · ${application.appId}`;
}

export default function ApplicationSearchField({
  value,
  displayValue,
  onChange,
  placeholder = 'Escribe el nombre o App ID…',
}: ApplicationSearchFieldProps) {
  const [query, setQuery] = useState(displayValue);
  const [debounced, setDebounced] = useState(displayValue);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const { data, isFetching } = useQuery<Paginated<Application>>({
    queryKey: ['applications', 'search-field', debounced],
    queryFn: () => applicationsApi.list({ q: debounced || undefined, page: 1, limit: 20 }).then(response => response.data),
    enabled: open,
  });
  const applications = useMemo(() => data?.data ?? [], [data]);

  return <div style={{ position: 'relative' }}>
    <input
      className="form-input"
      value={query}
      placeholder={placeholder}
      autoComplete="off"
      aria-invalid={!value && !!query.trim()}
      onFocus={() => setOpen(true)}
      onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      onChange={event => {
        const next = event.target.value;
        setQuery(next);
        setOpen(true);
        onChange('', next);
      }}
    />
    {open && <div className="card" style={{ position: 'absolute', zIndex: 30, top: 'calc(100% + 4px)', left: 0, right: 0, maxHeight: 260, overflowY: 'auto', padding: 5, boxShadow: '0 12px 30px rgba(0,0,0,.14)' }}>
      {isFetching && <p className="text-muted" style={{ padding: 10, fontSize: 12 }}>Buscando aplicaciones…</p>}
      {!isFetching && applications.length === 0 && <p className="text-muted" style={{ padding: 10, fontSize: 12 }}>No se encontraron aplicaciones.</p>}
      {applications.map(application => <button
        key={application.id}
        type="button"
        className="btn btn-ghost"
        style={{ width: '100%', display: 'block', textAlign: 'left', marginBottom: 2 }}
        onMouseDown={event => event.preventDefault()}
        onClick={() => {
          const label = applicationLabel(application);
          setQuery(label);
          setOpen(false);
          onChange(application.id, label, application);
        }}
      >
        <strong>{application.appName}</strong> <span className="text-muted">· {application.country} · {application.appId}</span>
      </button>)}
    </div>}
  </div>;
}
