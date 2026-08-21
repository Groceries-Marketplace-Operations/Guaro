import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { storeOnboardingApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission } from '../../auth/permissions';
import type {
  Country,
  KaType,
  StoreOnboardingNotificationProfile,
  StoreOnboardingNotificationProfilesResponse,
  StoreOnboardingRolloutPolicy,
  StoreOnboardingRolloutResponse,
  StoreOnboardingSource,
} from '../../types';
import { useStoreOnboardingFeature } from './useStoreOnboardingFeature';

const COUNTRIES: Array<{ value: Country; label: string }> = [
  { value: 'MX', label: 'México' },
  { value: 'CO', label: 'Colombia' },
  { value: 'CR', label: 'Costa Rica' },
];
const KA_TYPES: KaType[] = ['KA', 'CKA', 'SME'];
const SOURCES: Array<{ value: StoreOnboardingSource; label: string }> = [
  { value: 'create', label: 'Crear tiendas' },
  { value: 'duplicate', label: 'Duplicar tiendas' },
];

function rolloutKey(policy: Pick<StoreOnboardingRolloutPolicy, 'country' | 'kaType'>) {
  return `${policy.country}:${policy.kaType}`;
}

function workflowVersionFor(kaType: KaType) {
  return `${kaType.toLowerCase()}-v1`;
}

function normalizePolicy(policy: StoreOnboardingRolloutPolicy): StoreOnboardingRolloutPolicy {
  const taskTypeIds: Partial<Record<StoreOnboardingSource, string>> = { ...(policy.taskTypeIds ?? {}) };
  for (const mapping of policy.sourceTaskTypes ?? []) taskTypeIds[mapping.source] = mapping.taskTypeId;
  return { ...policy, taskTypeIds, workflowVersion: workflowVersionFor(policy.kaType) };
}

function offPolicy(country: Country, kaType: KaType): StoreOnboardingRolloutPolicy {
  return {
    country,
    kaType,
    sources: ['create', 'duplicate'],
    taskTypeIds: {},
    brandTaskTypeId: null,
    notificationProfileId: null,
    enabled: false,
    effectiveAt: null,
    workflowVersion: workflowVersionFor(kaType),
    newRequestsOnly: true,
    timezone: 'America/Mexico_City',
  };
}

function toDateTimeInput(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function deactivationEffectiveAt(previous?: string | null) {
  const previousTime = previous ? new Date(previous).getTime() : Number.NaN;
  return new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1_000 : 0)).toISOString();
}

function apiMessage(error: unknown) {
  const apiError = error as { response?: { data?: { message?: string | string[] } }; message?: string };
  const message = apiError.response?.data?.message;
  return Array.isArray(message) ? message.join(' · ') : message ?? apiError.message ?? 'No se pudo guardar el borrador.';
}

export default function StoreOnboardingRolloutSettings() {
  const { account } = useAuth();
  const feature = useStoreOnboardingFeature();
  const qc = useQueryClient();
  const [selectedKey, setSelectedKey] = useState('MX:KA');
  const [drafts, setDrafts] = useState<Record<string, StoreOnboardingRolloutPolicy>>({});
  const [activationConfirmed, setActivationConfirmed] = useState(false);
  const [deactivationConfirmed, setDeactivationConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const query = useQuery<StoreOnboardingRolloutResponse>({
    queryKey: ['store-onboarding-rollouts'],
    queryFn: () => storeOnboardingApi.rollouts().then(response => response.data),
    retry: false,
  });
  const profilesQuery = useQuery<StoreOnboardingNotificationProfilesResponse>({
    queryKey: ['store-onboarding-notification-profiles'],
    queryFn: () => storeOnboardingApi.notificationProfiles().then(response => response.data),
    retry: false,
  });
  const policies = useMemo(() => (query.data?.data ?? []).map(normalizePolicy), [query.data?.data]);
  const taskTypes = query.data?.taskTypeOptions ?? [];
  const matrix = useMemo(() => COUNTRIES.flatMap(country => KA_TYPES.map(kaType => {
    return policies.find(policy => policy.country === country.value && policy.kaType === kaType)
      ?? offPolicy(country.value, kaType);
  })), [policies]);
  const source = matrix.find(policy => rolloutKey(policy) === selectedKey) ?? matrix[0];
  const form = drafts[selectedKey] ?? source;
  const allProfiles = useMemo(() => profilesQuery.data?.data ?? [], [profilesQuery.data?.data]);
  const runtimeProfiles = useMemo(() => {
    const byLogicalKey = new Map<string, StoreOnboardingNotificationProfile>();
    for (const profile of allProfiles) {
      if (!profile.id || !profile.logicalKey || profile.runtimeEnabled !== true || !profile.publishedAt) continue;
      if (profile.isRuntimeRevision === false) continue;
      if (profile.runtimeRevisionId && profile.id !== profile.runtimeRevisionId) continue;
      const current = byLogicalKey.get(profile.logicalKey);
      if (!current || (profile.revision ?? 0) > (current.revision ?? 0)) byLogicalKey.set(profile.logicalKey, profile);
    }
    return [...byLogicalKey.values()];
  }, [allProfiles]);
  const compatibleProfileIds = useMemo(() => new Set(runtimeProfiles.filter(profile => {
    if (!form) return false;
    if (profile.country && profile.country !== form.country) return false;
    if (profile.kaType && profile.kaType !== form.kaType) return false;
    const coveredSources = new Set(profile.sources ?? []);
    return form.sources.every(item => coveredSources.has(item));
  }).flatMap(profile => profile.id ? [profile.id] : [])), [form, runtimeProfiles]);
  const selectedProfile = allProfiles.find(profile => profile.id === form?.notificationProfileId);
  const profileChoices = selectedProfile?.id && !runtimeProfiles.some(profile => profile.id === selectedProfile.id)
    ? [...runtimeProfiles, selectedProfile]
    : runtimeProfiles;
  const notificationProfileReady = Boolean(form?.notificationProfileId && compatibleProfileIds.has(form.notificationProfileId));
  const runtimeEnabled = source?.runtimeEnabled ?? (() => {
    const published = policies.find(policy => rolloutKey(policy) === selectedKey && Boolean(policy.publishedAt ?? policy.activatedAt));
    return published?.enabled === true;
  })();
  const futureActivationPending = Boolean(
    source?.pendingActivation
    && source.pendingActivationEffectiveAt,
  );
  const cancelFutureActivation = !runtimeEnabled && futureActivationPending;
  const globalEnabled = feature.globalEnabled;
  const canManage = query.isSuccess && !query.isError && hasPermission(account, 'system.manage');
  const canPublish = feature.operationalReady && feature.activationAllowed;

  const update = (patch: Partial<StoreOnboardingRolloutPolicy>) => {
    if (!form) return;
    setDrafts(current => ({ ...current, [selectedKey]: { ...form, ...patch, newRequestsOnly: true } }));
    setActivationConfirmed(false);
    setDeactivationConfirmed(false);
    setMessage('');
  };
  const save = useMutation({
    mutationFn: ({ policy, publication }: {
      policy: StoreOnboardingRolloutPolicy;
      publication: 'draft' | 'enable' | 'disable' | 'cancel-future';
    }) => {
      if (!policy.effectiveAt) throw new Error('Define el corte para requests nuevos.');
      return storeOnboardingApi.updateRollout({
        country: policy.country,
        kaType: policy.kaType,
        sources: policy.sources,
        taskTypeIds: policy.taskTypeIds ?? {},
        brandTaskTypeId: policy.brandTaskTypeId || null,
        notificationProfileId: policy.notificationProfileId || null,
        enabled: publication === 'enable',
        activationConfirmed: publication === 'draft' ? undefined : true,
        effectiveAt: publication === 'cancel-future'
          ? source?.pendingActivationEffectiveAt ?? policy.pendingActivationEffectiveAt ?? policy.effectiveAt
          : publication === 'disable'
            ? deactivationEffectiveAt(policy.effectiveAt)
            : policy.effectiveAt,
        workflowVersion: workflowVersionFor(policy.kaType),
        newRequestsOnly: true,
        timezone: policy.timezone || 'America/Mexico_City',
      });
    },
    onSuccess: async (response, variables) => {
      const saved = normalizePolicy({ ...response.data, newRequestsOnly: true as const });
      setDrafts(current => ({ ...current, [rolloutKey(saved)]: saved }));
      setActivationConfirmed(false);
      setDeactivationConfirmed(false);
      setMessage(variables.publication === 'enable'
        ? 'Revisión publicada con confirmación explícita.'
        : variables.publication === 'cancel-future'
          ? 'Activación futura cancelada exactamente en su corte; no existe una ventana de inscripción.'
        : variables.publication === 'disable'
          ? 'Desactivación publicada explícitamente para este scope.'
          : runtimeEnabled
            ? 'Borrador OFF guardado. El scope publicado continúa activo hasta una desactivación explícita.'
            : 'Borrador guardado en OFF. No se inscribieron solicitudes ni se activó el flujo.');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['store-onboarding-rollouts'] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding-config'] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding-status'] }),
      ]);
    },
  });
  const missingTaskTypeMapping = form?.sources.some(source => source !== 'manual' && !form.taskTypeIds?.[source]) ?? false;

  return <section className="onboarding-settings-section onboarding-rollout-settings" aria-labelledby="rollout-settings-title">
    <div className="onboarding-settings-title-row">
      <div>
        <span className="onboarding-settings-kicker">Control de adopción</span>
        <h3 id="rollout-settings-title">Rollout para nuevos requests</h3>
      </div>
      <span className={globalEnabled ? 'onboarding-off-badge is-on' : 'onboarding-off-badge'}>{globalEnabled ? 'Habilitación parcial' : 'Global OFF'}</span>
    </div>
    <div className="onboarding-safety-banner" role="status">
      <strong>{canPublish ? 'El rollout puede prepararse y publicarse con el control maestro OFF.' : 'OFF seguro: la publicación no está disponible.'}</strong>
      <span>{canPublish ? 'Publicar deja el scope listo para el preflight, pero no inscribe Tasks hasta que el control maestro se habilite por separado.' : feature.reason ?? 'El backend no declaró listo y autorizado el flujo operacional. Los borradores permanecen en OFF.'}</span>
    </div>
    {query.isLoading && <div className="onboarding-inline-state">Cargando matriz de rollout…</div>}
    {query.isError && <div className="onboarding-inline-state is-warning"><strong>OFF seguro.</strong> El endpoint de rollout no está disponible; no se puede guardar ni asumir una habilitación.</div>}
    <div className="rollout-matrix" role="grid" aria-label="Matriz de rollout por país y tipo de cuenta" aria-rowcount={COUNTRIES.length + 1} aria-colcount={KA_TYPES.length + 1}>
      <div className="rollout-matrix-head" role="row"><span role="columnheader">País</span>{KA_TYPES.map(type => <span role="columnheader" key={type}>{type}</span>)}</div>
      {COUNTRIES.map(country => <div className="rollout-matrix-row" role="row" key={country.value}>
        <strong role="rowheader">{country.label}</strong>
        {KA_TYPES.map(type => {
          const policy = matrix.find(item => item.country === country.value && item.kaType === type) ?? offPolicy(country.value, type);
          const key = rolloutKey(policy);
          const published = policies.find(item => rolloutKey(item) === key && Boolean(item.publishedAt ?? item.activatedAt));
          const active = globalEnabled && (policy.runtimeEnabled ?? published?.enabled === true);
          return <div role="gridcell" key={key}><button
              type="button"
              className={`${selectedKey === key ? 'selected ' : ''}${active ? 'is-on' : ''}`}
              onClick={() => { setSelectedKey(key); setActivationConfirmed(false); setDeactivationConfirmed(false); setMessage(''); }}
              aria-label={`${country.label}, ${type}: ${active ? 'activo' : 'inactivo'}, flujo ${workflowVersionFor(policy.kaType)}`}
              aria-pressed={selectedKey === key}
            >
              <span>{active ? 'ON' : 'OFF'}</span>
              <small>{workflowVersionFor(policy.kaType)}</small>
            </button></div>;
        })}
      </div>)}
    </div>
    {form && <div className="rollout-editor">
      <div className="rollout-editor-heading"><div><span>Scope seleccionado</span><strong>{form.country} · {form.kaType}</strong></div><span className={runtimeEnabled ? 'onboarding-off-badge is-on' : 'onboarding-off-badge'}>{runtimeEnabled ? 'Runtime ON' : 'Runtime OFF'}</span></div>
      <div className="form-row">
        <div className="form-group"><label className="form-label" htmlFor="rollout-effective-at">Corte para requests nuevos</label><input id="rollout-effective-at" className="form-input" type="datetime-local" value={toDateTimeInput(form.effectiveAt)} disabled={!canManage} onChange={event => update({ effectiveAt: event.target.value ? new Date(event.target.value).toISOString() : null })} /><p className="form-hint">La elegibilidad usará la fecha inmutable de creación del Task, nunca la fecha de procesamiento.</p></div>
        <div className="form-group"><label className="form-label" htmlFor="rollout-workflow-version">Versión del flujo</label><input id="rollout-workflow-version" className="form-input" value={workflowVersionFor(form.kaType)} readOnly aria-readonly="true" /><p className="form-hint">Se deriva del tipo de cuenta y queda congelada en cada request elegible.</p></div>
      </div>
      <div className="rollout-task-type-mapping">
        <div><strong>Task Types de origen</strong><span>La decisión se congela por ID; no depende de nombres ni de <code>systemKey</code>.</span></div>
        {!taskTypes.length && <div className="onboarding-inline-state is-warning">No hay Task Types seguros disponibles. El borrador no puede guardarse sin asociar los Task Types reales.</div>}
        {form.sources.filter(sourceValue => sourceValue !== 'manual').map(sourceValue => <label key={sourceValue}><span>{sourceValue === 'create' ? 'Crear tiendas' : 'Duplicar tiendas'}</span><select className="form-select" disabled={!canManage || !taskTypes.length} value={form.taskTypeIds?.[sourceValue] ?? ''} onChange={event => update({ taskTypeIds: { ...(form.taskTypeIds ?? {}), [sourceValue]: event.target.value } })}><option value="">Selecciona Task Type existente…</option>{taskTypes.map(taskType => <option key={taskType.id} value={taskType.id}>{taskType.name}{taskType.section?.name ? ` · ${taskType.section.name}` : ''}</option>)}</select></label>)}
        <label><span>Task Type de creación de Brand <small>(opcional)</small></span><select className="form-select" disabled={!canManage || !taskTypes.length} value={form.brandTaskTypeId ?? ''} onChange={event => update({ brandTaskTypeId: event.target.value || null })}><option value="">Sin dependencia: Brand existente = 0 min</option>{taskTypes.map(taskType => <option key={taskType.id} value={taskType.id}>{taskType.name}{taskType.section?.name ? ` · ${taskType.section.name}` : ''}</option>)}</select><small>Si un Task coincidente creó la Brand, su tiempo real se proyecta en cada batch dependiente.</small></label>
      </div>
      <div className="rollout-notification-link">
        <div className="form-group"><label className="form-label" htmlFor="rollout-notification-profile">Perfil de notificaciones publicado</label><select id="rollout-notification-profile" className="form-select" disabled={!canManage || profilesQuery.isLoading || profilesQuery.isError} value={form.notificationProfileId ?? ''} onChange={event => update({ notificationProfileId: event.target.value || null })}><option value="">Sin perfil vinculado · sólo válido para borrador OFF</option>{profileChoices.map(profile => {
          const compatible = Boolean(profile.id && compatibleProfileIds.has(profile.id));
          return <option key={profile.id ?? `${profile.logicalKey}-${profile.revision}`} value={profile.id} disabled={!compatible}>{profile.name} · v{profile.revision ?? 1} · {profile.country ?? 'Todos'} / {profile.kaType ?? 'Todos'}{compatible ? '' : ' · incompatible o no runtime'}</option>;
        })}</select><p className="form-hint">Se vincula el ID de la revisión runtime publicada. El perfil debe cubrir país, tipo y todas las fuentes del rollout.</p></div>
        <span className={notificationProfileReady ? 'onboarding-off-badge is-on' : 'onboarding-off-badge'}>{notificationProfileReady ? 'Perfil compatible' : 'Vínculo requerido para ON'}</span>
      </div>
      {profilesQuery.isError && <div className="onboarding-inline-state is-warning">No se pudieron verificar perfiles publicados. El borrador puede guardarse, pero publicar el rollout permanece bloqueado.</div>}
      {!profilesQuery.isLoading && !profilesQuery.isError && runtimeProfiles.length === 0 && <div className="onboarding-inline-state is-warning">Publica primero un perfil de notificaciones compatible. Ningún rollout puede quedar ON sin ese vínculo.</div>}
      {form.notificationProfileId && !notificationProfileReady && <div className="onboarding-inline-state is-warning">El perfil seleccionado ya no es la revisión runtime activa o no cubre este scope. Selecciona otro antes de publicar.</div>}
      <div className="form-row">
        <div className="form-group"><span className="form-label">Fuentes incluidas</span><div className="onboarding-setting-toggles">{SOURCES.map(sourceOption => <label key={sourceOption.value}><input type="checkbox" disabled={!canManage} checked={form.sources.includes(sourceOption.value)} onChange={event => update({ sources: event.target.checked ? [...form.sources, sourceOption.value] : form.sources.filter(sourceValue => sourceValue !== sourceOption.value) })} /> {sourceOption.label}</label>)}</div></div>
        <div className="form-group"><label className="form-label" htmlFor="rollout-timezone">Zona horaria del corte</label><input id="rollout-timezone" className="form-input" value={form.timezone ?? 'America/Mexico_City'} disabled={!canManage} onChange={event => update({ timezone: event.target.value })} /></div>
      </div>
      <label className="rollout-locked-rule"><input type="checkbox" checked readOnly disabled /> Sólo requests creados después del corte; sin backfill retroactivo.</label>
      <div className="onboarding-activation-control">
        <label className="onboarding-activation-confirm"><input type="checkbox" checked={activationConfirmed} disabled={!canPublish || !notificationProfileReady} onChange={event => setActivationConfirmed(event.target.checked)} /> Confirmo que revisé país, tipo, Task Types, perfil de avisos y corte efectivo; publicar prepara el scope sin habilitar el control maestro.</label>
        {(runtimeEnabled || cancelFutureActivation) && <div className="onboarding-inline-state is-warning" role="alertdialog" aria-label={cancelFutureActivation ? 'Confirmar cancelación de la activación futura' : 'Confirmar desactivación del rollout'}><strong>{cancelFutureActivation ? 'Cancelación exacta de activación futura.' : 'Desactivación separada.'}</strong><span>{cancelFutureActivation ? `Se publicará OFF en el mismo corte ${new Date(source?.pendingActivationEffectiveAt ?? '').toLocaleString()} para que no exista una ventana de inscripción.` : 'Guardar el borrador no apaga el scope vigente.'}</span><label className="onboarding-activation-confirm"><input type="checkbox" checked={deactivationConfirmed} disabled={!canManage} onChange={event => setDeactivationConfirmed(event.target.checked)} /> Confirmo que deseo {cancelFutureActivation ? 'cancelar la activación futura' : 'publicar la desactivación'} de {form.country} · {form.kaType}.</label></div>}
      </div>
      {missingTaskTypeMapping && <div className="onboarding-inline-state is-warning">Selecciona el Task Type real para cada fuente automática incluida.</div>}
      {!form.effectiveAt && <div className="onboarding-inline-state is-warning">Define el corte efectivo. El backend lo congela para excluir todos los Tasks anteriores.</div>}
      <div className="onboarding-settings-actions"><span>Guardar borrador nunca cambia el runtime. Publicar con Global OFF sólo completa el preflight; desactivar sigue siendo una acción separada.</span><div className="onboarding-publish-actions"><button type="button" className="btn btn-ghost" disabled={!canManage || save.isPending || !form.sources.length || !form.effectiveAt || !form.workflowVersion.trim() || missingTaskTypeMapping} onClick={() => save.mutate({ policy: form, publication: 'draft' })}>Guardar borrador OFF</button><button type="button" className="btn btn-primary" disabled={!canManage || save.isPending || !canPublish || !activationConfirmed || !notificationProfileReady || !form.sources.length || !form.effectiveAt || !form.workflowVersion.trim() || missingTaskTypeMapping} onClick={() => save.mutate({ policy: form, publication: 'enable' })}>Publicar cambios</button>{(runtimeEnabled || cancelFutureActivation) && <button type="button" className="btn btn-danger" disabled={!canManage || save.isPending || !deactivationConfirmed || !form.sources.length || !form.effectiveAt || !form.workflowVersion.trim() || missingTaskTypeMapping} onClick={() => save.mutate({ policy: form, publication: cancelFutureActivation ? 'cancel-future' : 'disable' })}>{cancelFutureActivation ? 'Cancelar activación futura' : 'Publicar desactivación'}</button>}</div></div>
    </div>}
    {save.isError && <div className="error-banner">{apiMessage(save.error)}</div>}
    {message && <div className="alert alert-success">{message}</div>}
  </section>;
}
