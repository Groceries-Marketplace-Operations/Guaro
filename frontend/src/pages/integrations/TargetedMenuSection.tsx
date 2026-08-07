import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import { brandsApi, targetedMenuApi } from '../../api';
import type { Brand, Paginated, TargetedMenuRule } from '../../types';

interface FormState {
  name: string;
  brandId: string;
  shopIds: string;
  upcs: string;
  mode: 'now' | 'scheduled';
  startsAt: string;
  active: boolean;
}

const activeStatuses = new Set(['pending', 'running']);

function localDateInput(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function emptyForm(): FormState {
  const start = new Date(Date.now() + 5 * 60_000);
  start.setSeconds(0, 0);
  return { name: '', brandId: '', shopIds: '', upcs: '', mode: 'now', startsAt: localDateInput(start), active: true };
}

function values(source: string) {
  return [...new Set(source.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean))];
}

function displayDate(value?: string) {
  return value ? new Date(value).toLocaleString() : '—';
}

function apiError(reason: unknown) {
  const value = reason as { response?: { data?: { message?: string | string[] } } };
  const message = value.response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : message ?? 'La acción no pudo completarse';
}

export default function TargetedMenuSection() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TargetedMenuRule | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: rules = [], isLoading } = useQuery<TargetedMenuRule[]>({
    queryKey: ['targeted-menu-rules'],
    queryFn: () => targetedMenuApi.list().then(response => response.data),
    refetchInterval: query => (query.state.data as TargetedMenuRule[] | undefined)
      ?.some(rule => rule.executions.some(execution => activeStatuses.has(execution.status))) ? 3000 : 15000,
  });
  const { data: brandPage } = useQuery<Paginated<Brand>>({
    queryKey: ['brands', 'targeted-menu'],
    queryFn: () => brandsApi.list({ page: 1, limit: 500 }).then(response => response.data),
  });
  const brands = useMemo(
    () => (brandPage?.data ?? []).filter(brand => !!brand.applicationId).sort((a, b) => a.brandName.localeCompare(b.brandName)),
    [brandPage],
  );
  const refresh = () => qc.invalidateQueries({ queryKey: ['targeted-menu-rules'] });
  const save = useMutation({
    mutationFn: () => {
      const runNow = !editing && form.mode === 'now';
      const payload = {
        name: form.name,
        brandId: form.brandId,
        shopIds: values(form.shopIds),
        upcs: values(form.upcs),
        startsAt: runNow ? new Date().toISOString() : new Date(form.startsAt).toISOString(),
        active: form.active,
        runNow,
      };
      return editing ? targetedMenuApi.update(editing.id, payload) : targetedMenuApi.create(payload);
    },
    onSuccess: () => { refresh(); setOpen(false); setEditing(null); setError(''); },
    onError: reason => setError(apiError(reason)),
  });
  const action = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'run' | 'stop' | 'delete' }) => verb === 'run'
      ? targetedMenuApi.run(id)
      : verb === 'stop'
        ? targetedMenuApi.stop(id)
        : targetedMenuApi.delete(id),
    onSuccess: refresh,
    onError: reason => window.alert(apiError(reason)),
  });

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setError('');
    setOpen(true);
  };
  const openEdit = (rule: TargetedMenuRule) => {
    setEditing(rule);
    setForm({
      name: rule.name,
      brandId: rule.brandId,
      shopIds: rule.shopIds.join('\n'),
      upcs: rule.upcs.join('\n'),
      mode: 'scheduled',
      startsAt: localDateInput(new Date(rule.startsAt)),
      active: rule.active,
    });
    setError('');
    setOpen(true);
  };
  const valid = form.name.trim() && form.brandId && values(form.shopIds).length > 0 && values(form.upcs).length > 0
    && (form.mode === 'now' || !!form.startsAt);

  return <section style={{ marginBottom: 22 }}>
    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
        <div>
          <strong>Targeted Menu Upload</strong>
          <p className="text-muted" style={{ marginTop: 5, fontSize: 12 }}>
            Descarga el menú de cada shop_id y vuelve a cargar únicamente los UPC indicados. No utiliza Excel ni plantillas; cada regla se repite diariamente a la hora de inicio.
          </p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Nueva regla</button>
      </div>
    </div>

    {isLoading && <p className="text-muted">Cargando reglas…</p>}
    {!isLoading && rules.length === 0 && <div className="empty-state"><p>No hay reglas de carga dirigida.</p></div>}
    <div style={{ display: 'grid', gap: 12 }}>
      {rules.map(rule => {
        const latest = rule.executions[0];
        const running = latest && activeStatuses.has(latest.status);
        const shops = latest?.result?.shops ?? [];
        return <article key={rule.id} className="card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{rule.name}</strong>
                <StatusBadge status={rule.active ? 'active' : 'inactive'} />
                <span className="badge">{rule.brand.brandName}</span>
                <span className="badge">{rule.shopIds.length} shops</span>
                <span className="badge">{rule.upcs.length} UPCs</span>
                <span className="badge">Diario</span>
                {latest && <StatusBadge status={latest.status} />}
              </div>
              <p className="text-muted" style={{ marginTop: 8, fontSize: 12 }}>
                Inicio: {displayDate(rule.startsAt)} · Próxima: {displayDate(rule.nextRunAt)} · Última: {displayDate(rule.lastRunAt)}
              </p>
              <p className="text-muted" style={{ marginTop: 5, fontSize: 12 }}>
                Creada por {rule.createdBy?.name ?? rule.createdBy?.email ?? 'Sistema'} · Modificada por {rule.updatedBy?.name ?? rule.updatedBy?.email ?? 'Sistema'}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" disabled={!!running || action.isPending} onClick={() => action.mutate({ id: rule.id, verb: 'run' })}>Ejecutar ahora</button>
              {running && <button className="btn btn-ghost btn-sm" onClick={() => action.mutate({ id: rule.id, verb: 'stop' })}>Detener</button>}
              <button className="btn btn-ghost btn-sm" disabled={!!running} onClick={() => openEdit(rule)}>Editar</button>
              <button className="btn btn-ghost btn-sm" disabled={!!running} style={{ color: 'var(--red)' }} onClick={() => {
                if (window.confirm(`¿Eliminar ${rule.name}?`)) action.mutate({ id: rule.id, verb: 'delete' });
              }}>Eliminar</button>
            </div>
          </div>
          {latest && <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>{latest.processedShops}/{latest.totalShops} tiendas</span>
              <span style={{ color: 'var(--green)' }}>{latest.successfulShops} aceptadas</span>
              <span style={{ color: latest.failedShops ? 'var(--red)' : undefined }}>{latest.failedShops} fallidas</span>
              {latest.currentShopId && <span>Procesando {latest.currentShopId}</span>}
              {shops.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(expanded === latest.id ? null : latest.id)}>{expanded === latest.id ? 'Ocultar detalle' : 'Ver tiendas'}</button>}
            </div>
            {latest.errorMessage && <p style={{ color: 'var(--red)', marginTop: 8 }}>{latest.errorMessage}</p>}
            {expanded === latest.id && <div className="table-wrap" style={{ marginTop: 12 }}><table>
              <thead><tr><th>Shop ID</th><th>Resultado</th><th>UPCs cargados</th><th>UPCs faltantes</th><th>Task ID / error</th></tr></thead>
              <tbody>{shops.map(shop => <tr key={shop.shopId}>
                <td className="td-mono">{shop.shopId}</td>
                <td><StatusBadge status={shop.status} /></td>
                <td>{shop.uploadedUpcs}/{shop.requestedUpcs}</td>
                <td className="td-mono">{shop.missingUpcs.join(', ') || '—'}</td>
                <td className="td-mono">{shop.error ?? shop.uploadTaskId ?? '—'}</td>
              </tr>)}</tbody>
            </table></div>}
          </div>}
        </article>;
      })}
    </div>

    {open && <Modal title={editing ? 'Editar Targeted Menu Upload' : 'Nueva regla Targeted Menu Upload'} onClose={() => setOpen(false)} footer={<>
      <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
      <button className="btn btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : editing ? 'Guardar' : form.mode === 'now' ? 'Crear y ejecutar' : 'Programar'}</button>
    </>}>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-group"><label className="form-label">Nombre *</label><input className="form-input" value={form.name} onChange={event => setForm(value => ({ ...value, name: event.target.value }))} /></div>
      <div className="form-group"><label className="form-label">Marca *</label><select className="form-input" value={form.brandId} onChange={event => setForm(value => ({ ...value, brandId: event.target.value }))}><option value="">Seleccionar…</option>{brands.map(brand => <option key={brand.id} value={brand.id}>{brand.brandName} · {brand.country}</option>)}</select></div>
      <div className="form-row">
        <div className="form-group"><label className="form-label">Shop IDs *</label><textarea className="form-input" rows={7} placeholder={'576…\n576…'} value={form.shopIds} onChange={event => setForm(value => ({ ...value, shopIds: event.target.value }))} /><p className="form-hint">Uno por línea o separados por coma. Se descarga el menú de cada tienda.</p></div>
        <div className="form-group"><label className="form-label">UPCs *</label><textarea className="form-input" rows={7} placeholder={'750…\n750…'} value={form.upcs} onChange={event => setForm(value => ({ ...value, upcs: event.target.value }))} /><p className="form-hint">Solo estos UPC se incluyen en la carga con merge; el resto del menú no se reemplaza.</p></div>
      </div>
      {!editing && <div className="form-group"><label className="form-label">Primera ejecución *</label><div style={{ display: 'flex', gap: 16 }}><label><input type="radio" checked={form.mode === 'now'} onChange={() => setForm(value => ({ ...value, mode: 'now' }))} /> Ejecutar ahora</label><label><input type="radio" checked={form.mode === 'scheduled'} onChange={() => setForm(value => ({ ...value, mode: 'scheduled' }))} /> Fecha programada</label></div></div>}
      {(editing || form.mode === 'scheduled') && <div className="form-group"><label className="form-label">Inicio y hora diaria *</label><input className="form-input" type="datetime-local" min={editing ? undefined : localDateInput()} value={form.startsAt} onChange={event => setForm(value => ({ ...value, startsAt: event.target.value }))} /><p className="form-hint">Después de la primera ejecución, se repite cada día a esta hora.</p></div>}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={form.active} onChange={event => setForm(value => ({ ...value, active: event.target.checked }))} /> Mantener recurrencia diaria activa</label>
    </Modal>}
  </section>;
}
