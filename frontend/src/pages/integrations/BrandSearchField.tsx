import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { brandsApi } from '../../api';
import type { Brand, Paginated } from '../../types';

interface BrandSearchFieldProps {
  value: string;
  displayValue: string;
  onChange: (brandId: string, displayValue: string, brand?: Brand) => void;
  placeholder?: string;
}

function brandLabel(brand: Brand) {
  return `${brand.brandName} · ${brand.country} · ${brand.brandId}`;
}

export default function BrandSearchField({ value, displayValue, onChange, placeholder = 'Escribe el nombre o Brand ID…' }: BrandSearchFieldProps) {
  const [query, setQuery] = useState(displayValue);
  const [debounced, setDebounced] = useState(displayValue);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const { data, isFetching } = useQuery<Paginated<Brand>>({
    queryKey: ['brands', 'search-field', debounced],
    queryFn: () => brandsApi.list({ q: debounced || undefined, page: 1, limit: 20 }).then(response => response.data),
    enabled: open,
  });
  const brands = useMemo(() => data?.data ?? [], [data]);

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
      {isFetching && <p className="text-muted" style={{ padding: 10, fontSize: 12 }}>Buscando marcas…</p>}
      {!isFetching && brands.length === 0 && <p className="text-muted" style={{ padding: 10, fontSize: 12 }}>No se encontraron marcas.</p>}
      {brands.map(brand => <button
        key={brand.id}
        type="button"
        className="btn btn-ghost"
        style={{ width: '100%', display: 'block', textAlign: 'left', marginBottom: 2 }}
        onMouseDown={event => event.preventDefault()}
        onClick={() => {
          const label = brandLabel(brand);
          setQuery(label);
          setOpen(false);
          onChange(brand.id, label, brand);
        }}
      >
        <strong>{brand.brandName}</strong> <span className="text-muted">· {brand.country} · {brand.brandId}</span>
        {!brand.applicationId && <span style={{ display: 'block', color: 'var(--red)', fontSize: 11, marginTop: 2 }}>Sin aplicación DiDi vinculada</span>}
      </button>)}
    </div>}
  </div>;
}
