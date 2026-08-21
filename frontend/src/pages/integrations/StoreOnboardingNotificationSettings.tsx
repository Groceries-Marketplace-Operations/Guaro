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
  StoreOnboardingSource,
} from '../../types';
import { useStoreOnboardingFeature } from './useStoreOnboardingFeature';

const DEFAULT_CRITICAL_EVENTS = [
  'audit.needs_information',
  'audit.rejected',
  'request.blocked',
  'store.online_failed',
];
const DEFAULT_VARIABLES = [
  'event.type',
  'event.occurredAt',
  'event.actorName',
  'event.note',
  'request.id',
  'request.status',
  'request.stage',
  'request.url',
  'task.id',
  'task.name',
  'task.url',
  'brand.id',
  'brand.name',
  'brand.country',
  'brand.kaType',
  'stores.total',
  'stores.completed',
  'stores.failed',
  'store.shopId',
  'store.appShopId',
  'store.status',
  'audit.status',
  'rtbo.status',
  'rollout.country',
  'rollout.kaType',
  'rollout.workflowVersion',
];
const SAMPLE_VALUES: Record<string, string> = {
  'event.type': 'audit.approved',
  'event.occurredAt': '21/08/2026, 10:30',
  'event.actorName': 'Comercial México',
  'event.note': 'Resultado registrado con evidencia ficticia.',
  'request.id': 'request_demo_812',
  'request.status': 'active',
  'request.stage': 'audit_approved',
  'request.url': 'https://guaro.example/store-onboarding/request_demo_812',
  'task.id': 'task_demo_10482',
  'task.name': 'Crear tiendas · Marca Piloto',
  'task.url': 'https://guaro.example/tasks/task_demo_10482',
  'brand.id': 'brand_demo_21',
  'brand.name': 'Marca Piloto',
  'brand.country': 'MX',
  'brand.kaType': 'KA',
  'stores.total': '8',
  'stores.completed': '4',
  'stores.failed': '0',
  'store.shopId': '576460123',
  'store.appShopId': 'app_shop_demo_04',
  'store.status': 'audit_approved',
  'audit.status': 'approved',
  'rtbo.status': 'pending',
  'rollout.country': 'MX',
  'rollout.kaType': 'KA',
  'rollout.workflowVersion': 'ka-v1',
};
const SOURCES: Array<{ value: StoreOnboardingSource; label: string }> = [
  { value: 'create', label: 'Crear tiendas' },
  { value: 'duplicate', label: 'Duplicar tiendas' },
];

function defaultProfile(): StoreOnboardingNotificationProfile {
  return {
    name: 'Borrador Store Onboarding',
    country: null,
    kaType: null,
    sources: ['create', 'duplicate'],
    webhookId: '',
    enabled: false,
    frequency: 'digest',
    intervalMinutes: 30,
    scheduledTime: '09:00',
    timezone: 'America/Mexico_City',
    criticalEvents: DEFAULT_CRITICAL_EVENTS,
    template: '🟡 {{event.type}}\n\nTask: {{task.name}} · {{task.id}}\nBrand: {{brand.name}} · {{brand.country}} · {{brand.kaType}}\nFlujo: {{rollout.workflowVersion}}\nEtapa: {{request.stage}}\nAvance: {{stores.completed}} / {{stores.total}}\nResponsable: {{event.actorName}}\nNota: {{event.note}}\n{{task.url}}',
  };
}

function variableToken(variable: string) {
  const trimmed = variable.trim();
  return trimmed.startsWith('{{') ? trimmed : `{{${trimmed}}}`;
}

function renderPreview(template: string) {
  return template.replace(/{{\s*([^}]+?)\s*}}/g, (_, key: string) => SAMPLE_VALUES[key.trim()] ?? `‹${key.trim()}›`);
}

function apiMessage(error: unknown) {
  const apiError = error as { response?: { data?: { message?: string | string[] } }; message?: string };
  const message = apiError.response?.data?.message;
  return Array.isArray(message) ? message.join(' · ') : message ?? apiError.message ?? 'No se pudo guardar el perfil.';
}

export default function StoreOnboardingNotificationSettings() {
  const { account } = useAuth();
  const feature = useStoreOnboardingFeature();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState('new');
  const [drafts, setDrafts] = useState<Record<string, StoreOnboardingNotificationProfile>>({ new: defaultProfile() });
  const [activationConfirmed, setActivationConfirmed] = useState(false);
  const [deactivationConfirmed, setDeactivationConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const profilesQuery = useQuery<StoreOnboardingNotificationProfilesResponse>({
    queryKey: ['store-onboarding-notification-profiles'],
    queryFn: () => storeOnboardingApi.notificationProfiles().then(response => response.data),
    retry: false,
  });
  const allProfiles = useMemo(() => profilesQuery.data?.data ?? [], [profilesQuery.data?.data]);
  const profiles = useMemo(() => {
    const latest = new Map<string, StoreOnboardingNotificationProfile>();
    for (const profile of allProfiles) {
      const key = profile.logicalKey ?? profile.id ?? `${profile.name}:${profile.revision ?? 0}`;
      const current = latest.get(key);
      if (!current || (profile.revision ?? 0) > (current.revision ?? 0)) latest.set(key, profile);
    }
    return [...latest.values()];
  }, [allProfiles]);
  const source = selectedId === 'new' ? drafts.new : profiles.find(profile => profile.id === selectedId) ?? defaultProfile();
  const form = drafts[selectedId] ?? source;
  const runtimeEnabled = source.runtimeEnabled ?? (() => {
    if (!form.logicalKey) return false;
    const published = allProfiles
      .filter(profile => profile.logicalKey === form.logicalKey && Boolean(profile.publishedAt))
      .sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0))[0];
    return published?.enabled === true;
  })();
  const allowedVariables = useMemo(() => {
    const fromApi = profilesQuery.data?.allowedVariables ?? [];
    return (fromApi.length ? fromApi : DEFAULT_VARIABLES).map(variableToken);
  }, [profilesQuery.data?.allowedVariables]);
  const canManage = profilesQuery.isSuccess && !profilesQuery.isError && hasPermission(account, 'system.manage');
  const canPublish = feature.operationalReady && feature.activationAllowed;

  const update = (patch: Partial<StoreOnboardingNotificationProfile>) => {
    setDrafts(current => ({ ...current, [selectedId]: { ...form, ...patch } }));
    setActivationConfirmed(false);
    setDeactivationConfirmed(false);
    setMessage('');
  };
  const mutation = useMutation({
    mutationFn: ({ profile, publication }: { profile: StoreOnboardingNotificationProfile; publication: 'draft' | 'enable' | 'disable' }) => storeOnboardingApi.updateNotificationProfile({
      id: profile.id,
      name: profile.name.trim(),
      country: profile.country || null,
      kaType: profile.kaType || null,
      sources: profile.sources,
      webhookId: profile.webhookId,
      enabled: publication === 'enable',
      activationConfirmed: publication === 'draft' ? undefined : true,
      frequency: profile.frequency,
      intervalMinutes: profile.frequency === 'digest' ? Number(profile.intervalMinutes ?? 30) : null,
      scheduledTime: profile.frequency === 'scheduled' ? profile.scheduledTime ?? '09:00' : null,
      timezone: profile.timezone,
      criticalEvents: DEFAULT_CRITICAL_EVENTS,
      template: profile.template,
    }),
    onSuccess: async (response, variables) => {
      const saved = response.data;
      const key = saved.id ?? selectedId;
      setSelectedId(key);
      setDrafts(current => ({ ...current, [key]: saved }));
      setActivationConfirmed(false);
      setDeactivationConfirmed(false);
      setMessage(variables.publication === 'enable'
        ? 'Cambios publicados con confirmación explícita para eventos futuros.'
        : variables.publication === 'disable'
          ? 'Desactivación del perfil publicada explícitamente.'
          : runtimeEnabled
            ? 'Borrador OFF guardado. La revisión publicada continúa activa hasta una desactivación explícita.'
            : 'Perfil versionado guardado en OFF. No se envió ningún mensaje.');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['store-onboarding-notification-profiles'] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding-config'] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding-status'] }),
      ]);
    },
  });
  const selectProfile = (id: string) => { setSelectedId(id); setActivationConfirmed(false); setDeactivationConfirmed(false); setMessage(''); };

  return <section className="onboarding-settings-section onboarding-notification-settings" aria-labelledby="notification-settings-title">
    <div className="onboarding-settings-title-row">
      <div><span className="onboarding-settings-kicker">Webhook existente</span><h3 id="notification-settings-title">Notificaciones del proceso</h3></div>
      <span className={feature.notificationsEnabled ? 'onboarding-off-badge is-on' : 'onboarding-off-badge'}>{feature.notificationsEnabled ? 'Envío habilitado' : 'Notificaciones globales OFF'}</span>
    </div>
    <div className="onboarding-safety-banner"><strong>{canPublish ? 'El perfil puede prepararse y publicarse con el control maestro OFF.' : 'Edición fail-closed.'}</strong><span>{canPublish ? 'Publicar sólo deja una revisión runtime lista para el preflight. Mientras notificaciones globales esté OFF, no se despacha ningún evento.' : 'La vista previa usa datos ficticios. Guardar en OFF no prueba el webhook ni despacha eventos.'}</span></div>
    {profilesQuery.isError && <div className="onboarding-inline-state is-warning"><strong>OFF seguro.</strong> No se cargaron perfiles; la edición y el guardado permanecen bloqueados.</div>}
    <div className="notification-profile-layout">
      <aside className="notification-profile-list" aria-label="Perfiles de notificación">
        <button type="button" className={selectedId === 'new' ? 'active' : ''} onClick={() => selectProfile('new')}><strong>+ Nuevo borrador</strong><span>Siempre OFF</span></button>
        {profiles.map(profile => {
          const published = allProfiles.filter(item => item.logicalKey === profile.logicalKey && Boolean(item.publishedAt)).sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0))[0];
          const active = profile.runtimeEnabled ?? published?.enabled === true;
          return <button type="button" key={profile.id ?? `${profile.name}-${profile.revision}`} className={selectedId === profile.id ? 'active' : ''} onClick={() => profile.id && selectProfile(profile.id)}><strong>{profile.name}</strong><span>v{profile.revision ?? 1} · {active ? 'runtime ON' : 'runtime OFF'}</span></button>;
        })}
      </aside>
      <div className="notification-profile-editor">
        <div className="form-row">
          <div className="form-group"><label className="form-label" htmlFor="notification-name">Nombre del perfil</label><input id="notification-name" className="form-input" value={form.name} disabled={!canManage} onChange={event => update({ name: event.target.value })} /></div>
          <div className="form-group"><label className="form-label" htmlFor="notification-webhook">Destino</label><select id="notification-webhook" className="form-select" value={form.webhookId} disabled={!canManage || !(profilesQuery.data?.webhookOptions?.length)} onChange={event => update({ webhookId: event.target.value })}><option value="">Selecciona el webhook de creación de tiendas</option>{form.webhookId && !(profilesQuery.data?.webhookOptions ?? []).some(webhook => webhook.id === form.webhookId) && <option value={form.webhookId}>Destino configurado</option>}{(profilesQuery.data?.webhookOptions ?? []).map(webhook => <option key={webhook.id} value={webhook.id}>{webhook.name}</option>)}</select><p className="form-hint">El API dedicado sólo expone ID y nombre; la URL y secretos nunca llegan a esta pantalla.</p></div>
        </div>
        <div className="notification-scope-grid">
          <label><span>País</span><select className="form-select" disabled={!canManage} value={form.country ?? ''} onChange={event => update({ country: (event.target.value || null) as Country | null })}><option value="">Todos</option><option value="MX">México</option><option value="CO">Colombia</option><option value="CR">Costa Rica</option></select></label>
          <label><span>Tipo</span><select className="form-select" disabled={!canManage} value={form.kaType ?? ''} onChange={event => update({ kaType: (event.target.value || null) as KaType | null })}><option value="">Todos</option><option value="KA">KA</option><option value="CKA">CKA</option><option value="SME">SME</option></select></label>
          <div><span>Fuentes</span><div className="notification-source-options">{SOURCES.map(sourceOption => <label key={sourceOption.value}><input type="checkbox" disabled={!canManage} checked={(form.sources ?? []).includes(sourceOption.value)} onChange={event => update({ sources: event.target.checked ? [...(form.sources ?? []), sourceOption.value] : (form.sources ?? []).filter(value => value !== sourceOption.value) })} /> {sourceOption.label}</label>)}</div></div>
        </div>
        <fieldset className="notification-frequency"><legend>Frecuencia para avances normales</legend><div className="notification-frequency-options">{(['immediate', 'digest', 'scheduled'] as const).map(value => <label key={value} className={form.frequency === value ? 'selected' : ''}><input type="radio" name="notification-frequency" value={value} disabled={!canManage} checked={form.frequency === value} onChange={() => update({ frequency: value, ...(value === 'scheduled' && !form.scheduledTime ? { scheduledTime: '09:00' } : {}) })} /><strong>{value === 'immediate' ? 'Inmediato' : value === 'digest' ? 'Resumen periódico' : 'Horario fijo'}</strong><small>{value === 'immediate' ? 'Un mensaje por transición' : value === 'digest' ? 'Agrupa cambios del intervalo' : 'Un resumen a la hora indicada'}</small></label>)}</div>
          <div className="form-row">{form.frequency === 'digest' && <div className="form-group"><label className="form-label" htmlFor="notification-interval">Intervalo (minutos)</label><input id="notification-interval" className="form-input" type="number" min={5} max={1440} disabled={!canManage} value={form.intervalMinutes ?? 30} onChange={event => update({ intervalMinutes: Number(event.target.value) })} /></div>}{form.frequency === 'scheduled' && <div className="form-group"><label className="form-label" htmlFor="notification-time">Hora del resumen</label><input id="notification-time" className="form-input" type="time" disabled={!canManage} value={form.scheduledTime ?? '09:00'} onChange={event => update({ scheduledTime: event.target.value })} /></div>}<div className="form-group"><label className="form-label" htmlFor="notification-timezone">Zona horaria</label><input id="notification-timezone" className="form-input" disabled={!canManage} value={form.timezone} onChange={event => update({ timezone: event.target.value })} /></div></div>
        </fieldset>
        <div className="notification-critical-events"><strong>Siempre inmediatos</strong><span>Estas excepciones no pueden degradarse a resumen.</span><div>{DEFAULT_CRITICAL_EVENTS.map(event => <span key={event}>{event}</span>)}</div></div>
        <div className="notification-template-grid">
          <div className="notification-template-editor"><label className="form-label" htmlFor="notification-template">Plantilla versionada {form.revision ? `· v${form.revision}` : '· nueva'}</label><textarea id="notification-template" className="form-textarea" rows={12} disabled={!canManage} value={form.template} onChange={event => update({ template: event.target.value })} /><span className="form-hint">Variables permitidas</span><div className="notification-variable-chips">{allowedVariables.map(variable => <button type="button" key={variable} disabled={!canManage} onClick={() => update({ template: `${form.template}${form.template.endsWith('\n') ? '' : ' '}${variable}` })}>{variable}</button>)}</div></div>
          <div className="notification-preview"><div><strong>Vista previa ficticia</strong><span>No se envía al webhook</span></div><pre>{renderPreview(form.template)}</pre></div>
        </div>
        <div className="onboarding-activation-control">
          <label className="onboarding-activation-confirm"><input type="checkbox" checked={activationConfirmed} disabled={!canPublish} onChange={event => setActivationConfirmed(event.target.checked)} /> Confirmo el webhook, la frecuencia y el contenido; publicar prepara esta revisión para eventos futuros, sin habilitar el control maestro.</label>
          {runtimeEnabled && <div className="onboarding-inline-state is-warning" role="alertdialog" aria-label="Confirmar desactivación del perfil"><strong>Desactivación separada.</strong><span>Guardar un borrador no apaga la revisión publicada.</span><label className="onboarding-activation-confirm"><input type="checkbox" checked={deactivationConfirmed} disabled={!canManage} onChange={event => setDeactivationConfirmed(event.target.checked)} /> Confirmo que deseo publicar la desactivación de este perfil.</label></div>}
        </div>
        <div className="onboarding-settings-actions"><span>Guardar borrador nunca publica. Publicar con Global OFF sólo completa el preflight y no envía mensajes.</span><div className="onboarding-publish-actions"><button type="button" className="btn btn-ghost" disabled={!canManage || mutation.isPending || !form.name.trim() || !form.webhookId || !form.template.trim() || !(form.sources?.length)} onClick={() => mutation.mutate({ profile: form, publication: 'draft' })}>Guardar borrador OFF</button><button type="button" className="btn btn-primary" disabled={!canManage || mutation.isPending || !canPublish || !activationConfirmed || !form.name.trim() || !form.webhookId || !form.template.trim() || !(form.sources?.length)} onClick={() => mutation.mutate({ profile: form, publication: 'enable' })}>Publicar cambios</button>{runtimeEnabled && <button type="button" className="btn btn-danger" disabled={!canManage || mutation.isPending || !deactivationConfirmed || !form.name.trim() || !form.webhookId || !form.template.trim() || !(form.sources?.length)} onClick={() => mutation.mutate({ profile: form, publication: 'disable' })}>Publicar desactivación</button>}</div></div>
      </div>
    </div>
    {mutation.isError && <div className="error-banner">{apiMessage(mutation.error)}</div>}
    {message && <div className="alert alert-success">{message}</div>}
  </section>;
}
