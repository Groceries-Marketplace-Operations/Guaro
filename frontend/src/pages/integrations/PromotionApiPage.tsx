import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import StatusBadge from '../../components/ui/StatusBadge';
import { brandsApi, promotionApi, shopsApi } from '../../api';
import type { Brand, Paginated, Shop } from '../../types';

const EXAMPLE = JSON.stringify({
  app_item_id_type: 1,
  promo_list: [{
    action: 1,
    activity_id: 'mx_example_special_price_001',
    activity_type: 2,
    activity_name: 'Precio especial de ejemplo',
    start_date: '2026-08-10 00:00:00',
    end_date: '2026-08-17 23:59:59',
    item_activity_list: [{ app_item_id: '7501000000000', discount_perc: 20 }],
  }],
}, null, 2);

interface Contract {
  endpoint: string;
  liveEnabled: boolean;
}

interface PromotionExecution {
  id: string;
  mode: 'dry_run' | 'live';
  status: string;
  durationMs?: number;
  remoteTaskId?: string;
  errorMessage?: string;
  createdAt: string;
  brand: { brandName: string; country: string };
  shop: { shopId: string; appShopId: string; name?: string };
}

function duration(ms?: number) {
  return ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export default function PromotionApiPage() {
  const qc = useQueryClient();
  const [brandId, setBrandId] = useState('');
  const [shopId, setShopId] = useState('');
  const [payload, setPayload] = useState(EXAMPLE);
  const [message, setMessage] = useState('');

  const { data: contract } = useQuery<Contract>({
    queryKey: ['promotion-api-contract'], queryFn: () => promotionApi.contract().then(response => response.data),
  });
  const { data: brandData } = useQuery<Paginated<Brand>>({
    queryKey: ['promotion-api-brands'], queryFn: () => brandsApi.list({ page: 1, limit: 100 }).then(response => response.data),
  });
  const { data: shopData } = useQuery<Paginated<Shop>>({
    queryKey: ['promotion-api-shops', brandId],
    queryFn: () => shopsApi.list({ brandId, page: 1, limit: 1000 }).then(response => response.data),
    enabled: !!brandId,
  });
  const { data: history } = useQuery<Paginated<PromotionExecution>>({
    queryKey: ['promotion-api-executions'], queryFn: () => promotionApi.executions(1).then(response => response.data),
  });
  const shops = useMemo(() => shopData?.data ?? [], [shopData]);

  const execute = useMutation({
    mutationFn: (mode: 'dry_run' | 'live') => {
      let parsed: object;
      try { parsed = JSON.parse(payload); } catch { throw new Error('El JSON no es válido'); }
      if (!brandId || !shopId) throw new Error('Selecciona una marca y una tienda');
      return promotionApi.execute({ brandId, shopId, mode, payload: parsed });
    },
    onSuccess: response => {
      const mode = response.data.mode === 'dry_run' ? 'Validación local correcta. No se envió información.' : `Promoción aceptada. Task ID: ${response.data.remoteTaskId ?? 'sin task ID'}`;
      setMessage(mode);
      qc.invalidateQueries({ queryKey: ['promotion-api-executions'] });
    },
    onError: (reason: unknown) => {
      const apiMessage = (reason as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
      setMessage(Array.isArray(apiMessage) ? apiMessage.join(', ') : apiMessage ?? (reason as Error).message ?? 'La operación falló');
    },
  });

  return <>
    <Topbar breadcrumb={[{ label: 'Carga de promociones por API' }]} />
    <main className="main-content">
      <div className="page-header"><div className="page-header-info">
        <h1>Carga de promociones por API</h1>
        <p>Construye y valida actividades Grocery antes de enviarlas a 99Food.</p>
      </div></div>
      <div className="alert alert-info" style={{ marginBottom: 18 }}>
        Endpoint oficial: <code>{contract?.endpoint ?? 'POST /v1/promo/promo/uploadGrocery'}</code>. El modo simulación valida todo localmente y nunca solicita un auth_token.
      </div>
      {!contract?.liveEnabled && <div className="alert alert-warning" style={{ marginBottom: 18 }}>
        La carga real está bloqueada en este ambiente. Se habilitará únicamente después de homologación; no se probará contra producción.
      </div>}
      <section className="card" style={{ padding: 20, marginBottom: 20 }}>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Marca *</label><select className="form-input" value={brandId} onChange={event => { setBrandId(event.target.value); setShopId(''); }}><option value="">Seleccionar…</option>{brandData?.data.map(brand => <option key={brand.id} value={brand.id}>{brand.brandName} · {brand.country}</option>)}</select></div>
          <div className="form-group"><label className="form-label">Tienda *</label><select className="form-input" value={shopId} onChange={event => setShopId(event.target.value)} disabled={!brandId}><option value="">Seleccionar…</option>{shops.map(shop => <option key={shop.id} value={shop.id}>{shop.shopId} · {shop.name || shop.appShopId}</option>)}</select></div>
        </div>
        <div className="form-group"><label className="form-label">Payload (sin auth_token)</label><textarea className="form-input td-mono" style={{ minHeight: 390, resize: 'vertical' }} value={payload} onChange={event => setPayload(event.target.value)} /></div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={execute.isPending} onClick={() => execute.mutate('dry_run')}>Validar / simular</button>
          <button className="btn btn-ghost" disabled={execute.isPending || !contract?.liveEnabled} onClick={() => {
            if (window.confirm('Esta acción enviará promociones reales a 99Food. ¿Continuar?')) execute.mutate('live');
          }}>Enviar a 99Food</button>
          {message && <span>{message}</span>}
        </div>
      </section>
      <section className="card" style={{ padding: 20 }}>
        <h2 style={{ marginTop: 0 }}>Ejecuciones recientes</h2>
        <div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Marca</th><th>Tienda</th><th>Modo</th><th>Estado</th><th>Duración</th><th>Resultado</th></tr></thead>
          <tbody>{history?.data.map(item => <tr key={item.id}>
            <td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.brand.brandName}</td><td>{item.shop.shopId} · {item.shop.name || item.shop.appShopId}</td>
            <td>{item.mode === 'dry_run' ? 'Simulación' : 'Real'}</td><td><StatusBadge status={item.status} /></td><td>{duration(item.durationMs)}</td><td>{item.remoteTaskId ? `Task ${item.remoteTaskId}` : item.errorMessage || 'Validado'}</td>
          </tr>)}</tbody>
        </table></div>
      </section>
    </main>
  </>;
}
