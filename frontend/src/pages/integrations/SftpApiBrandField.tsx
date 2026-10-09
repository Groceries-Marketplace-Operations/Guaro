import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import client from '../../api/client';
import { BASE } from './sftp-api.types';
import { ErrorBox } from './SftpApiUi';
type BrandOption = { id: string; brandName: string; brandId: string };
export default function SftpApiBrandField({ value, displayValue, onChange }: { value: string; displayValue: string; onChange: (id: string, label: string) => void }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const timer = setTimeout(() => setDebounced(search), 250); return () => clearTimeout(timer); }, [search]);
  const query = useQuery({ queryKey: ['sftp-api', 'brand-options', debounced], queryFn: () => client.get<BrandOption[]>(`${BASE}/brands/options`, { params: { q: debounced } }).then(r => r.data) });
  return <><input aria-label="Buscar marca del catálogo" className="form-input" placeholder="Buscar por nombre o Brand ID…" value={search} onChange={e => setSearch(e.target.value)} />
    <select aria-label="Marca del catálogo" className="form-input" required value={value} onChange={e => { const brand = query.data?.find(b => b.id === e.target.value); onChange(e.target.value, brand ? `${brand.brandName} · ${brand.brandId}` : ''); }}>
      <option value="">{query.isFetching ? 'Buscando marcas…' : 'Selecciona una marca'}</option>
      {value && !query.data?.some(b => b.id === value) && <option value={value}>{displayValue}</option>}
      {query.data?.map(brand => <option key={brand.id} value={brand.id}>{brand.brandName} · {brand.brandId}</option>)}
    </select><ErrorBox error={query.error} />
    {!query.isPending && !query.isError && !query.data?.length && <small>No hay marcas con ese nombre. Registra primero la marca en el catálogo.</small>}
  </>;
}
