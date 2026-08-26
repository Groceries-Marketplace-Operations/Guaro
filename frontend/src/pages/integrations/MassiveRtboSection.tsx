import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import ExecutionTiming from '../../components/integrations/ExecutionTiming';
import { massiveRtboApi } from '../../api';
import type { MassiveRtboExecution } from '../../types';
import ApplicationSearchField from './ApplicationSearchField';

interface FormState {
  applicationId: string;
  applicationSearch: string;
  shopIds: string;
  promiseProduceTime: number;
}

const activeStatuses = new Set(['pending', 'running']);
const shopIdPattern = /^57\d{17}$/;
const initialForm = (): FormState => ({
  applicationId: '',
  applicationSearch: '',
  shopIds: '',
  promiseProduceTime: 600,
});

function parseShopIds(value: string) {
  return [...new Set(value.split(/[\s,;]+/).map(entry => entry.trim()).filter(Boolean))];
}

function apiError(reason: unknown) {
  const message = (reason as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : message ?? 'No se pudo iniciar Massive RTBO';
}

function date(value?: string) {
  return value ? new Date(value).toLocaleString() : '—';
}

export default function MassiveRtboSection() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(initialForm);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: executions = [], isLoading } = useQuery<MassiveRtboExecution[]>({
    queryKey: ['massive-rtbo-executions'],
    queryFn: () => massiveRtboApi.list().then(response => response.data),
    refetchInterval: query => (query.state.data as MassiveRtboExecution[] | undefined)
      ?.some(execution => activeStatuses.has(execution.status)) ? 3000 : 15000,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['massive-rtbo-executions'] });
  const shopIds = parseShopIds(form.shopIds);
  const invalidShopIds = shopIds.filter(shopId => !shopIdPattern.test(shopId));
  const valid = !!form.applicationId
    && Number.isInteger(form.promiseProduceTime)
    && form.promiseProduceTime >= 1
    && form.promiseProduceTime <= 86400
    && shopIds.length <= 2000
    && invalidShopIds.length === 0;

  const create = useMutation({
    mutationFn: () => massiveRtboApi.create({
      applicationId: form.applicationId,
      shopIds,
      promiseProduceTime: form.promiseProduceTime,
    }),
    onSuccess: () => {
      refresh();
      setOpen(false);
      setForm(initialForm());
      setError('');
    },
    onError: reason => setError(apiError(reason)),
  });
  const stop = useMutation({
    mutationFn: (id: string) => massiveRtboApi.stop(id),
    onSuccess: refresh,
    onError: reason => window.alert(apiError(reason)),
  });

  const submit = () => {
    const scope = shopIds.length
      ? `${shopIds.length} tienda(s)`
      : 'TODAS las tiendas de la aplicación';
    if (!window.confirm(`Se actualizará promise_produce_time a ${form.promiseProduceTime} segundos en ${scope}. ¿Continuar?`)) return;
    create.mutate();
  };

  const repeat = (execution: MassiveRtboExecution) => {
    setForm({
      applicationId: execution.applicationId,
      applicationSearch: `${execution.application.appName} · ${execution.application.country} · ${execution.application.appId}`,
      shopIds: execution.shopIds.join('\n'),
      promiseProduceTime: execution.promiseProduceTime,
    });
    setError('');
    setOpen(true);
  };

  return <section style={{ marginBottom: 22 }}>
    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
        <div>
          <strong>Massive RTBO</strong>
          <p className="text-muted" style={{ marginTop: 5, fontSize: 12 }}>
            Actualiza el tiempo promedio de preparación (<span className="td-mono">promise_produce_time</span>) por tienda mediante POST /v1/shop/shop/update. Cada resultado queda registrado y la ejecución puede detenerse.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => { setForm(initialForm()); setError(''); setOpen(true); }}>+ Nueva actualización</button>
      </div>
    </div>

    {isLoading && <p className="text-muted">Cargando ejecuciones…</p>}
    {!isLoading && executions.length === 0 && <div className="empty-state"><p>No hay ejecuciones de Massive RTBO.</p></div>}
    <div style={{ display: 'grid', gap: 12 }}>
      {executions.map(execution => {
        const running = activeStatuses.has(execution.status);
        const results = execution.result?.shops ?? [];
        const failures = results.filter(result => result.status === 'failed');
        const percent = execution.totalShops > 0
          ? Math.round(execution.processedShops / execution.totalShops * 100)
          : 0;
        return <article key={execution.id} className="card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <strong>{execution.application.appName}</strong>
                <StatusBadge status={execution.status} />
                <span className="badge">{execution.promiseProduceTime} s</span>
                <span className="badge">{execution.shopIds.length ? `${execution.shopIds.length} seleccionadas` : 'Todas las tiendas'}</span>
              </div>
              <p className="text-muted" style={{ marginTop: 7, fontSize: 12 }}>
                {execution.application.country} · App ID {execution.application.appId} · Creada: {date(execution.createdAt)}
              </p>
              <ExecutionTiming startedAt={execution.startedAt} finishedAt={execution.finishedAt} />
              <div style={{ marginTop: 10, maxWidth: 560 }}>
                <div style={{ height: 7, borderRadius: 999, overflow: 'hidden', background: 'var(--surface-2)' }}>
                  <div style={{ width: `${percent}%`, height: '100%', background: execution.failedShops ? 'var(--orange)' : '#12b76a', transition: 'width .25s' }} />
                </div>
                <p style={{ marginTop: 6, fontSize: 12 }}>
                  {execution.processedShops}/{execution.totalShops || '—'} procesadas · <span style={{ color: '#027A48' }}>{execution.successfulShops} correctas</span> · <span style={{ color: 'var(--red)' }}>{execution.failedShops} fallidas</span>{execution.currentShopId ? ` · Actual: ${execution.currentShopId}` : ''}
                </p>
              </div>
              {execution.errorMessage && <p style={{ color: 'var(--red)', marginTop: 7 }}>{execution.errorMessage}</p>}
              {expanded === execution.id && <div className="table-wrap" style={{ marginTop: 12 }}>
                {failures.length === 0
                  ? <p className="text-muted" style={{ padding: 10 }}>No hay errores por tienda.</p>
                  : <table><thead><tr><th>Shop ID</th><th>App Shop ID</th><th>Error</th></tr></thead><tbody>
                    {failures.map(result => <tr key={result.shopId}><td className="td-mono">{result.shopId}</td><td className="td-mono">{result.appShopId ?? '—'}</td><td style={{ color: 'var(--red)' }}>{result.error}</td></tr>)}
                  </tbody></table>}
              </div>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {results.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(expanded === execution.id ? null : execution.id)}>{expanded === execution.id ? 'Ocultar errores' : 'Ver errores'}</button>}
              {!running && <button className="btn btn-ghost btn-sm" onClick={() => repeat(execution)}>Repetir</button>}
              {running && <button className="btn btn-ghost btn-sm" disabled={stop.isPending} onClick={() => stop.mutate(execution.id)}>Detener</button>}
            </div>
          </div>
        </article>;
      })}
    </div>

    {open && <Modal title="Actualizar Massive RTBO" onClose={() => setOpen(false)} footer={<>
      <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
      <button className="btn btn-primary" disabled={!valid || create.isPending} onClick={submit}>{create.isPending ? 'Enviando…' : 'Iniciar actualización'}</button>
    </>}>
      {error && <div className="error-banner">{error}</div>}
      <div className="alert alert-info" style={{ marginBottom: 14 }}>Selecciona la aplicación vinculada a la marca. Si dejas la lista de Shop IDs vacía, se consultarán y actualizarán todas las tiendas devueltas por DiDi para esa aplicación.</div>
      <div className="form-group">
        <label className="form-label">Aplicación / marca *</label>
        <ApplicationSearchField value={form.applicationId} displayValue={form.applicationSearch} onChange={(applicationId, applicationSearch) => setForm(value => ({ ...value, applicationId, applicationSearch }))} />
      </div>
      <div className="form-group">
        <label className="form-label">promise_produce_time (segundos) *</label>
        <input className="form-input" type="number" min={1} max={86400} step={1} value={form.promiseProduceTime} onChange={event => setForm(value => ({ ...value, promiseProduceTime: Number(event.target.value) }))} />
        <p className="form-hint">Tiempo promedio de preparación que verá DiDi. Debe ser un entero entre 1 y 86,400 segundos.</p>
      </div>
      <div className="form-group">
        <label className="form-label">Shop IDs (opcional)</label>
        <textarea className="form-input td-mono" rows={8} value={form.shopIds} placeholder={'Vacío = todas las tiendas de la aplicación\nO un shop_id por línea, por ejemplo:\n5764012345678901234'} onChange={event => setForm(value => ({ ...value, shopIds: event.target.value }))} />
        <p className="form-hint">Se aceptan líneas, comas o espacios. {shopIds.length} tienda(s) detectada(s), máximo 2,000.</p>
      </div>
      {invalidShopIds.length > 0 && <p style={{ color: 'var(--red)' }}>Todos los Shop IDs deben tener 19 dígitos y comenzar con 57.</p>}
      {shopIds.length > 2000 && <p style={{ color: 'var(--red)' }}>El máximo permitido es de 2,000 tiendas por solicitud.</p>}
    </Modal>}
  </section>;
}
