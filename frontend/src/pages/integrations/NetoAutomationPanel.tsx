import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client from '../../api/client';
import { useAuth } from '../../auth/AuthContext';

interface NetoStatus {
  enabled: boolean;
  workerOnline: boolean;
  running: boolean;
  stopping: boolean;
  ready: boolean;
  phase: string | null;
  progress: {
    total: number | null;
    completed: number | null;
    cached: number | null;
    skipped: number | null;
    inFlight: number | null;
    taskIds: number | null;
    byStatus: Record<string, number>;
  };
  generationId: string | null;
  activeStores: number | null;
  currentCycleId: string | null;
  lastCycle: {
    id: string | null;
    status: string | null;
    stores: number | null;
    taskIds: number | null;
    startedAt: string | null;
    completedAt: string | null;
    byStatus: Record<string, number>;
  } | null;
  nextUploadAt: string | null;
  updatedAt: string | null;
  workerUpdatedAt: string | null;
  lastExit: { at: string | null; code: number | null; signal: string | null; error: string | null } | null;
}

function date(value: string | null | undefined) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
}

function apiError(error: unknown) {
  const message = (error as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : message || 'No se pudo actualizar Tiendas Neto.';
}

export default function NetoAutomationPanel() {
  const { account } = useAuth();
  const queryClient = useQueryClient();
  const admin = account?.roles?.some(role => role === 'admin' || role === 'super_admin') ?? false;
  const query = useQuery<NetoStatus>({
    queryKey: ['neto-automation'],
    queryFn: () => client.get<NetoStatus>('/integrations/neto-automation').then(response => response.data),
    enabled: admin,
    refetchInterval: 5_000,
  });
  const update = useMutation({
    mutationFn: (enabled: boolean) => client.post('/integrations/neto-automation/enabled', { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['neto-automation'] }),
  });
  if (!admin) return null;

  const status = query.data;
  const label = !status?.workerOnline ? 'Worker desconectado'
    : status.stopping ? 'Deteniéndose'
      : status.running ? 'Ejecutándose'
        : status.enabled ? 'Esperando reinicio' : 'Pausado';

  return (
    <section className="card" style={{ padding: 24, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0 }}>Tiendas Neto · menú semanal</h2>
          <p className="text-muted" style={{ margin: '8px 0 0' }}>Descarga el menú una vez por semana y sube los productos con status 1 cada dos horas.</p>
        </div>
        <span className="badge">{label}</span>
      </div>

      {query.isLoading && <p style={{ marginTop: 20 }}>Cargando estado…</p>}
      {query.isError && <p className="alert alert-error" style={{ marginTop: 20 }}>{apiError(query.error)}</p>}
      {status && <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginTop: 24 }}>
          <div className="card" style={{ padding: 16 }}><small>Tiendas con menú</small><strong style={{ display: 'block', fontSize: 24 }}>{status.activeStores ?? '—'}</strong></div>
          <div className="card" style={{ padding: 16 }}><small>Progreso actual</small><strong style={{ display: 'block', fontSize: 24 }}>{status.progress.completed ?? status.progress.cached ?? '—'} / {status.progress.total ?? '—'}</strong></div>
          <div className="card" style={{ padding: 16 }}><small>Task IDs del ciclo</small><strong style={{ display: 'block', fontSize: 24 }}>{status.progress.taskIds ?? status.lastCycle?.taskIds ?? '—'}</strong></div>
          <div className="card" style={{ padding: 16 }}><small>Próxima subida</small><strong style={{ display: 'block', fontSize: 16 }}>{date(status.nextUploadAt)}</strong></div>
        </div>

        <div style={{ marginTop: 20, display: 'grid', gap: 7 }}>
          <div><strong>Fase:</strong> {status.phase || '—'}</div>
          <div><strong>Generación:</strong> {status.generationId || '—'}</div>
          <div><strong>Ciclo actual:</strong> {status.currentCycleId || '—'}</div>
          <div><strong>Último ciclo:</strong> {status.lastCycle?.id || '—'} · {status.lastCycle?.status || '—'} · {date(status.lastCycle?.completedAt)}</div>
          <div><strong>Actualización:</strong> {date(status.updatedAt)}</div>
          {status.lastExit?.error && <div className="alert alert-error">Último error del worker: {status.lastExit.error}</div>}
        </div>

        {!status.ready && <p className="alert alert-warning" style={{ marginTop: 16 }}>Falta migrar el checkpoint local (lista de tiendas, generación y ciclos) al volumen persistente del servidor. No se puede iniciar todavía.</p>}
        {update.isError && <p className="alert alert-error" style={{ marginTop: 16 }}>{apiError(update.error)}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <button className="btn btn-primary" disabled={update.isPending || status.enabled || !status.ready || !status.workerOnline} onClick={() => update.mutate(true)}>Iniciar</button>
          <button className="btn btn-secondary" disabled={update.isPending || !status.enabled} onClick={() => update.mutate(false)}>Pausar al guardar el avance</button>
          <button className="btn btn-secondary" disabled={query.isFetching} onClick={() => query.refetch()}>Actualizar</button>
        </div>
      </>}
    </section>
  );
}
