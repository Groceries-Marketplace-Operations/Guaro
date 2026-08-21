import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from '../../components/ui/Modal';
import { storeOnboardingApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission } from '../../auth/permissions';
import type { StoreOnboardingControlResponse } from '../../types';

function apiMessage(error: unknown) {
  const apiError = error as { response?: { data?: { message?: string | string[] } }; message?: string };
  const message = apiError.response?.data?.message;
  return Array.isArray(message)
    ? message.join(' · ')
    : message ?? apiError.message ?? 'No se pudo actualizar el control maestro.';
}

export function StoreOnboardingMasterControlPanel() {
  const { account } = useAuth();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<{ globalEnabled: boolean; notificationsEnabled: boolean } | null>(null);
  const [activationConfirmed, setActivationConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const query = useQuery<StoreOnboardingControlResponse>({
    queryKey: ['store-onboarding-config'],
    queryFn: () => storeOnboardingApi.config().then(response => response.data),
    retry: false,
  });
  const trusted = query.isSuccess && !query.isError;
  const globalEnabled = draft?.globalEnabled ?? (trusted && query.data?.globalEnabled === true);
  const notificationsEnabled = draft?.notificationsEnabled ?? (trusted && query.data?.notificationsEnabled === true);
  const anyEnabled = globalEnabled || notificationsEnabled;
  const readiness = trusted ? query.data?.activationReadiness : undefined;
  const canManage = hasPermission(account, 'system.manage') && trusted;
  const canEnable = trusted
    && query.data?.operationalReady === true
    && query.data?.activationAllowed === true
    && readiness?.ready === true;

  const update = (next: { globalEnabled?: boolean; notificationsEnabled?: boolean }) => {
    const current = { globalEnabled, notificationsEnabled };
    const merged = { ...current, ...next };
    if (!merged.globalEnabled) merged.notificationsEnabled = false;
    setDraft(merged);
    setActivationConfirmed(false);
    setMessage('');
  };

  const mutation = useMutation({
    mutationFn: () => storeOnboardingApi.updateConfig({
      globalEnabled,
      notificationsEnabled,
      activationConfirmed: anyEnabled ? activationConfirmed : false,
    }),
    onSuccess: async response => {
      setDraft({
        globalEnabled: response.data.globalEnabled === true,
        notificationsEnabled: response.data.notificationsEnabled === true,
      });
      setActivationConfirmed(false);
      setMessage(response.data.globalEnabled
        ? 'Control maestro actualizado con confirmación explícita.'
        : 'Store Onboarding y sus notificaciones quedaron en OFF.');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['store-onboarding-status'] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding-config'] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding-rollouts'] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding-notification-profiles'] }),
      ]);
    },
  });

  return <section className="onboarding-settings-section" aria-labelledby="master-control-title">
    <div className="onboarding-settings-title-row">
      <div>
        <span className="onboarding-settings-kicker">Interruptor global</span>
        <h3 id="master-control-title">Control maestro</h3>
      </div>
      <span className={globalEnabled ? 'onboarding-off-badge is-on' : 'onboarding-off-badge'}>
        {globalEnabled ? 'Global ON' : 'Global OFF'}
      </span>
    </div>
    <div className="onboarding-safety-banner" role="status">
      <strong>{canEnable ? 'Preflight completo: el control maestro puede habilitarse.' : 'Activación bloqueada hasta completar el preflight.'}</strong>
      <span>{canEnable
        ? `${readiness?.readyScopeCount ?? 0} scope(s) publicado(s) con Task Types y perfil de avisos compatible.`
        : query.data?.reason ?? 'Publica primero al menos un perfil y un rollout compatibles. El estado seguro permanece OFF.'}</span>
      {!canEnable && Boolean(readiness?.reasons?.length) && <ul>{readiness?.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    </div>
    {query.isLoading && <div className="onboarding-inline-state">Cargando control maestro…</div>}
    {query.isError && <div className="onboarding-inline-state is-warning"><strong>OFF seguro.</strong> No se pudo leer el control; no se permite guardar ni asumir activación.</div>}
    <div className="onboarding-master-options">
      <label>
        <input
          type="checkbox"
          checked={globalEnabled}
          disabled={!canManage || (!globalEnabled && !canEnable)}
          onChange={event => update({ globalEnabled: event.target.checked })}
        />
        <span><strong>Store Onboarding global</strong><small>Expone la operación y permite inscribir únicamente Tasks elegibles posteriores al corte.</small></span>
      </label>
      <label>
        <input
          type="checkbox"
          checked={notificationsEnabled}
          disabled={!canManage || !globalEnabled || (!notificationsEnabled && !canEnable)}
          onChange={event => update({ notificationsEnabled: event.target.checked })}
        />
        <span><strong>Notificaciones globales</strong><small>Autoriza entregas sólo para perfiles publicados; los borradores OFF no envían.</small></span>
      </label>
    </div>
    {anyEnabled && <label className="onboarding-activation-confirm">
      <input
        type="checkbox"
        checked={activationConfirmed}
        disabled={!canEnable}
        onChange={event => setActivationConfirmed(event.target.checked)}
      />
      Confirmo que revisé los rollouts, cortes, Task Types, webhooks y plantillas. Entiendo que sólo se tomarán requests nuevos.
    </label>}
    <div className="onboarding-master-summary">
      <span>{query.data?.rolloutDrafts ?? 0} rollout(s) OFF preparados</span>
      <span>{query.data?.notificationProfileDrafts ?? 0} perfil(es) OFF preparados</span>
      <span>{readiness?.readyScopeCount ?? 0} de {readiness?.runtimeScopeCount ?? 0} scope(s) runtime listos</span>
    </div>
    <div className="onboarding-settings-actions">
      <span>Nada cambia hasta presionar Guardar. La desactivación no ejecuta ni cancela procesos.</span>
      <button
        type="button"
        className={anyEnabled ? 'btn btn-primary' : 'btn btn-danger'}
        disabled={!canManage || mutation.isPending || (anyEnabled && (!canEnable || !activationConfirmed))}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? 'Guardando…' : anyEnabled ? 'Guardar control confirmado' : 'Guardar Global OFF'}
      </button>
    </div>
    {mutation.isError && <div className="error-banner">{apiMessage(mutation.error)}</div>}
    {message && <div className="alert alert-success">{message}</div>}
  </section>;
}

export default function StoreOnboardingMasterControl({ onClose }: { onClose: () => void }) {
  return <Modal
    title="Control maestro de Store Onboarding"
    onClose={onClose}
    footer={<button className="btn btn-ghost" onClick={onClose}>Cerrar</button>}
  >
    <StoreOnboardingMasterControlPanel />
  </Modal>;
}
