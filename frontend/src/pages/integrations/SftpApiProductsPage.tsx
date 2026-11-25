import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client from '../../api/client';
import Topbar from '../../components/layout/Topbar';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission } from '../../auth/permissions';
import { BASE } from './sftp-api.types';
import type { Rule } from './sftp-api.types';
import { ErrorBox } from './SftpApiUi';
import './sftp-api.css';

type Product = { app_item_id: string; price: number; stock: number };
type ProductRule = Rule & { additionalProducts: Product[] };
function ProductEditor({ rule }: { rule: ProductRule }) {
  const { account } = useAuth();
  const qc = useQueryClient();
  const [json, setJson] = useState(JSON.stringify(rule.additionalProducts ?? [], null, 2));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canEdit = hasPermission(account, 'integrations.sftp_api.configure');
  const save = useMutation({ mutationFn: (products: unknown[]) => client.patch(`${BASE}/${rule.id}/products`, { products }),
    onSuccess: () => { setNotice('Productos guardados. Se incluirán en los siguientes envíos Full.'); void qc.invalidateQueries({ queryKey: ['sftp-api'] }); } });
  return <form className="card" onSubmit={event => {
    event.preventDefault(); setError(''); setNotice('');
    try {
      const products: unknown = JSON.parse(json);
      if (!Array.isArray(products)) throw new Error('El JSON debe ser una lista de productos.');
      save.mutate(products);
    } catch (cause) { setError((cause as Error).message); }
  }}>
    <h2>{rule.brand.brandName}</h2>
    <p>Estos productos se agregan a las categorías Despensa del menú Full de cada tienda. Si un ID ya viene en el SFTP, se conserva el producto del archivo.</p>
    <p>price está expresado en pesos y se multiplica por 100. app_item_id se utiliza también como EAN (UPC) y nombre. Stock debe ser un entero no negativo.</p>
    <label className="sftp-field">Productos en JSON<textarea className="form-input sftp-mono" rows={16} maxLength={600000} value={json} readOnly={!canEdit} onChange={event => { setJson(event.target.value); setNotice(''); }} spellCheck={false} /></label>
    <p>Ejemplo: <code>{'[{"price":12000,"stock":21,"app_item_id":"7702085005231"}]'}</code></p>
    <p>Guardar reemplaza la lista de esta marca. Usa [] para quitar todos los productos adicionales. No se incluyen en Delta ni generan envíos por sí solos.</p>
    {error && <p role="alert" className="sftp-error">{error}</p>}<ErrorBox error={save.error} />
    {notice && <p role="status">{notice}</p>}
    {canEdit && <button className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar productos'}</button>}
  </form>;
}
export default function SftpApiProductsPage() {
  const [selected, setSelected] = useState('');
  const query = useQuery({ queryKey: ['sftp-api', 'product-rules'], queryFn: () => client.get<ProductRule[]>(BASE).then(result => result.data) });
  const rule = query.data?.find(entry => entry.id === selected);
  return <><Topbar breadcrumb={[{ label: 'Integrations' }, { label: 'Productos adicionales SFTP' }]} /><main className="main-content sftp-page">
    <div className="sftp-heading"><div><h1>Productos adicionales SFTP</h1><p>Agrega productos a los envíos Full de las marcas configuradas en SFTP to API.</p></div></div>
    <section className="card"><label className="sftp-field">Marca y aplicación API<select className="form-input" value={selected} disabled={query.isPending} onChange={event => setSelected(event.target.value)}>
      <option value="">Selecciona una configuración SFTP to API</option>
      {query.data?.map(entry => <option key={entry.id} value={entry.id}>{entry.brand.brandName} · {entry.application.appName} · {entry.application.appId}</option>)}
    </select></label><ErrorBox error={query.error} />
    {query.isPending && <p role="status">Cargando configuraciones…</p>}
    {query.data?.length === 0 && <p>Primero configura una marca en SFTP to API.</p>}</section>
    {rule && <ProductEditor key={rule.id} rule={rule} />}
  </main></>;
}
