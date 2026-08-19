import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import Topbar from '../components/layout/Topbar';
import { useAuth } from '../auth/AuthContext';
import { useT } from '../i18n';
import {
  adminApi,
  autoFetchApi,
  autoTurnOffApi,
  brandsApi,
  fileIntegrationsApi,
  integrationsApi,
  offerMenuUploadApi,
  shopsApi,
  storeEmergenciesApi,
  targetedMenuApi,
  tasksApi,
} from '../api';
import { hasPermission } from '../auth/permissions';
import StatusBadge from '../components/ui/StatusBadge';
import type {
  AutoOpenPool,
  AutoTurnOffPool,
  Brand,
  FileIntegrationRule,
  OfferMenuUploadRule,
  Paginated,
  StoreEmergency,
  TargetedMenuRule,
  Task,
  TaskDashboardSummary,
  TaskStatus,
} from '../types';

type DashboardExecution = { status: string };
type FetchPool = {
  active: boolean;
  brands: unknown[];
  executions: DashboardExecution[];
};
type QueueSummary = {
  queues: Record<string, { counts: Record<string, number>; recentFailed: unknown[] }>;
};
type IntegrationCard = {
  id: string;
  title: string;
  description: string;
  href: string;
  active: number;
  total: number;
  running: number;
  issues: number;
  tone: 'orange' | 'blue' | 'purple' | 'green' | 'red';
};

const TASK_STATUSES: Array<{ status: TaskStatus; color: string }> = [
  { status: 'scheduled', color: '#2e90fa' },
  { status: 'pending', color: '#98a2b3' },
  { status: 'assigned', color: '#ff8a34' },
  { status: 'in_progress', color: '#fdb022' },
  { status: 'blocked', color: '#7f56d9' },
  { status: 'failed', color: '#f04438' },
  { status: 'done', color: '#12b76a' },
];

const RUNNING = new Set(['pending', 'running', 'in_progress', 'restoring']);
const ISSUES = new Set(['failed', 'partial_success', 'blocked']);

function MetricIcon({ name }: { name: 'tasks' | 'activity' | 'alert' | 'check' | 'catalog' | 'shop' }) {
  const paths: Record<typeof name, React.ReactNode> = {
    tasks: <><rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 4.5V3h6v1.5M9 9h6M9 13h6M9 17h4"/></>,
    activity: <><path d="M4 12h3l2-5 4 10 2-5h5"/><circle cx="12" cy="12" r="9"/></>,
    alert: <><path d="M10.3 4.2 3.4 16a2 2 0 0 0 1.7 3h13.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 8v4M12 16h.01"/></>,
    check: <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></>,
    catalog: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 1 4 16.5v-11Z"/><path d="M4 16.5A2.5 2.5 0 0 1 6.5 14H20M8 7h8"/></>,
    shop: <><path d="M4 10v10h16V10M3 10l2-6h14l2 6"/><path d="M3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M9 20v-5h6v5"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function latestExecutions<T extends { executions?: DashboardExecution[] }>(rules: T[]) {
  return rules.flatMap(rule => rule.executions?.slice(0, 1) ?? []);
}

function statusCount(executions: DashboardExecution[], statuses: Set<string>) {
  return executions.filter(execution => statuses.has(execution.status)).length;
}

function activeStep(task: Task) {
  const step = task.stepInstances?.find(item => ['in_progress', 'assigned', 'blocked', 'failed'].includes(item.status));
  return step?.stepDefinition?.name ?? '—';
}

export default function Dashboard() {
  const nav = useNavigate();
  const { account } = useAuth();
  const t = useT();
  const firstName = account?.name?.split(' ')[0] ?? '';
  const isBpoOnly = Boolean(account?.roles.includes('bpo')
    && !account.roles.includes('admin')
    && !account.roles.includes('super_admin')
    && !account.roles.includes('user'));
  const isSuperAdmin = Boolean(account?.roles.includes('super_admin'));
  const canSeeTasks = hasPermission(account, 'tasks.view');
  const canCreateTasks = hasPermission(account, 'tasks.create') && !account?.roles.includes('director');
  const canSeeCatalog = hasPermission(account, 'brands.view');
  const canSeeAutoOpen = hasPermission(account, 'integrations.forced_open');
  const canSeeTurnOff = hasPermission(account, 'integrations.auto_turn_off');
  const canSeeStoresFetch = hasPermission(account, 'integrations.auto_stores_fetch');
  const canSeeMenuFetch = hasPermission(account, 'integrations.auto_menu_fetch');
  const canSeeCustom = hasPermission(account, 'integrations.custom');
  const canSeePromotions = hasPermission(account, 'integrations.promotions_sftp');
  const canSeeEmergencies = hasPermission(account, 'integrations.emergencies');

  const taskSummaryQuery = useQuery<TaskDashboardSummary>({
    queryKey: ['dashboard', 'task-summary'],
    queryFn: () => tasksApi.dashboardSummary().then(response => response.data),
    enabled: canSeeTasks,
    refetchInterval: 30_000,
  });
  const recentTasksQuery = useQuery<Paginated<Task>>({
    queryKey: ['dashboard', 'recent-tasks'],
    queryFn: () => tasksApi.list({ limit: 12 }).then(response => response.data as Paginated<Task>),
    enabled: canSeeTasks,
    refetchInterval: 30_000,
  });
  const sectionsQuery = useQuery({
    queryKey: ['dashboard', 'task-sections'],
    queryFn: () => tasksApi.filterOptions().then(response => response.data),
    enabled: canSeeTasks,
  });
  const brandsQuery = useQuery<Paginated<Brand>>({
    queryKey: ['dashboard', 'brands'],
    queryFn: () => brandsApi.list({ limit: 1 })
      .then(response => response.data as Paginated<Brand>),
    enabled: canSeeCatalog && !isBpoOnly,
  });
  const shopsQuery = useQuery<Paginated<unknown>>({
    queryKey: ['dashboard', 'shops'],
    queryFn: () => shopsApi.list({ limit: 1 }).then(response => response.data as Paginated<unknown>),
    enabled: canSeeCatalog && !isBpoOnly,
  });

  const autoOpenQuery = useQuery<AutoOpenPool[]>({
    queryKey: ['dashboard', 'auto-open'],
    queryFn: () => integrationsApi.listPools().then(response => response.data as AutoOpenPool[]),
    enabled: canSeeAutoOpen,
  });
  const turnOffQuery = useQuery<AutoTurnOffPool[]>({
    queryKey: ['dashboard', 'auto-turn-off'],
    queryFn: () => autoTurnOffApi.listPools().then(response => response.data as AutoTurnOffPool[]),
    enabled: canSeeTurnOff,
    refetchInterval: 30_000,
  });
  const storesFetchQuery = useQuery<FetchPool[]>({
    queryKey: ['dashboard', 'auto-fetch', 'stores'],
    queryFn: () => autoFetchApi.listPools('stores').then(response => response.data as FetchPool[]),
    enabled: canSeeStoresFetch,
    refetchInterval: 30_000,
  });
  const menuFetchQuery = useQuery<FetchPool[]>({
    queryKey: ['dashboard', 'auto-fetch', 'menu'],
    queryFn: () => autoFetchApi.listPools('menu').then(response => response.data as FetchPool[]),
    enabled: canSeeMenuFetch,
    refetchInterval: 30_000,
  });
  const targetedQuery = useQuery<TargetedMenuRule[]>({
    queryKey: ['dashboard', 'targeted-menu'],
    queryFn: () => targetedMenuApi.list().then(response => response.data as TargetedMenuRule[]),
    enabled: canSeeCustom,
    refetchInterval: 30_000,
  });
  const offerQuery = useQuery<OfferMenuUploadRule[]>({
    queryKey: ['dashboard', 'offer-menu'],
    queryFn: () => offerMenuUploadApi.list().then(response => response.data as OfferMenuUploadRule[]),
    enabled: canSeeCustom,
    refetchInterval: 30_000,
  });
  const customFilesQuery = useQuery<FileIntegrationRule[]>({
    queryKey: ['dashboard', 'custom-files'],
    queryFn: () => fileIntegrationsApi.list('price_filter').then(response => response.data as FileIntegrationRule[]),
    enabled: canSeeCustom,
    refetchInterval: 30_000,
  });
  const promotionsQuery = useQuery<FileIntegrationRule[]>({
    queryKey: ['dashboard', 'promotions-sftp'],
    queryFn: () => fileIntegrationsApi.list('complex_promotion_reader').then(response => response.data as FileIntegrationRule[]),
    enabled: canSeePromotions,
    refetchInterval: 30_000,
  });
  const emergenciesQuery = useQuery<Paginated<StoreEmergency>>({
    queryKey: ['dashboard', 'emergencies'],
    queryFn: () => storeEmergenciesApi.list(1, 20).then(response => response.data as Paginated<StoreEmergency>),
    enabled: canSeeEmergencies,
    refetchInterval: 30_000,
  });
  const queuesQuery = useQuery<QueueSummary>({
    queryKey: ['dashboard', 'queues'],
    queryFn: () => adminApi.queueStatus().then(response => response.data as QueueSummary),
    enabled: isSuperAdmin && hasPermission(account, 'system.manage'),
    refetchInterval: 15_000,
  });

  const summary = taskSummaryQuery.data;
  const recent = recentTasksQuery.data?.data ?? [];
  const attentionTasks = recent.filter(task => task.status === 'failed' || task.status === 'blocked').slice(0, 4);
  const sectionNames = new Map((sectionsQuery.data?.sections ?? []).map(section => [section.id, section.name]));
  const visibleBrandCount = isBpoOnly ? summary?.scopedBrandCount : brandsQuery.data?.total;
  const visibleShopCount = isBpoOnly ? summary?.scopedShopCount : shopsQuery.data?.total;

  const integrationCards = useMemo<IntegrationCard[]>(() => {
    const cards: IntegrationCard[] = [];
    if (canSeeAutoOpen) {
      const pools = autoOpenQuery.data ?? [];
      cards.push({ id: 'auto-open', title: 'Auto Open Stores', description: t('pages.dashboard.integrationAutoOpen'), href: '/integrations/auto-open', active: pools.filter(pool => pool.active).length, total: pools.length, running: 0, issues: 0, tone: 'green' });
    }
    if (canSeeTurnOff) {
      const pools = turnOffQuery.data ?? [];
      const rules = pools.flatMap(pool => pool.rules);
      const executions = latestExecutions(rules);
      cards.push({ id: 'turn-off', title: 'Auto Turn Off Items', description: t('pages.dashboard.integrationTurnOff'), href: '/integrations/auto-turn-off', active: rules.filter(rule => rule.active).length, total: rules.length, running: statusCount(executions, RUNNING), issues: statusCount(executions, ISSUES), tone: 'orange' });
    }
    const addFetch = (id: string, title: string, href: string, pools: FetchPool[], tone: IntegrationCard['tone']) => {
      const executions = latestExecutions(pools);
      cards.push({ id, title, description: id === 'stores-fetch' ? t('pages.dashboard.integrationStoresFetch') : t('pages.dashboard.integrationMenuFetch'), href, active: pools.filter(pool => pool.active).length, total: pools.length, running: statusCount(executions, RUNNING), issues: statusCount(executions, ISSUES), tone });
    };
    if (canSeeStoresFetch) addFetch('stores-fetch', 'Auto Stores Fetch', '/integrations/auto-stores-fetch', storesFetchQuery.data ?? [], 'blue');
    if (canSeeMenuFetch) addFetch('menu-fetch', 'Auto Menu Fetch', '/integrations/auto-menu-fetch', menuFetchQuery.data ?? [], 'purple');
    if (canSeeCustom) {
      const targeted = targetedQuery.data ?? [];
      const offers = offerQuery.data ?? [];
      const files = customFilesQuery.data ?? [];
      const rules = [...targeted, ...offers, ...files];
      const executions = [...latestExecutions(targeted), ...latestExecutions(offers), ...latestExecutions(files)];
      cards.push({ id: 'custom', title: 'Custom integrations', description: t('pages.dashboard.integrationCustom'), href: '/integrations/custom', active: rules.filter(rule => rule.active).length, total: rules.length, running: statusCount(executions, RUNNING), issues: statusCount(executions, ISSUES), tone: 'purple' });
    }
    if (canSeePromotions) {
      const rules = promotionsQuery.data ?? [];
      const executions = latestExecutions(rules);
      cards.push({ id: 'promotions', title: 'Promociones SFTP', description: t('pages.dashboard.integrationPromotions'), href: '/integrations/complex-promotions-sftp', active: rules.filter(rule => rule.active).length, total: rules.length, running: statusCount(executions, RUNNING), issues: statusCount(executions, ISSUES), tone: 'blue' });
    }
    if (canSeeEmergencies) {
      const emergencies = emergenciesQuery.data?.data ?? [];
      cards.push({ id: 'emergencies', title: t('pages.dashboard.emergencies'), description: t('pages.dashboard.integrationEmergencies'), href: '/integrations/emergencies', active: emergencies.filter(item => ['pending', 'running', 'offline', 'partial_success', 'restoring'].includes(item.status)).length, total: emergenciesQuery.data?.total ?? emergencies.length, running: emergencies.filter(item => RUNNING.has(item.status)).length, issues: emergencies.filter(item => ISSUES.has(item.status)).length, tone: 'red' });
    }
    return cards;
  }, [autoOpenQuery.data, canSeeAutoOpen, canSeeCustom, canSeeEmergencies, canSeeMenuFetch, canSeePromotions, canSeeStoresFetch, canSeeTurnOff, customFilesQuery.data, emergenciesQuery.data, menuFetchQuery.data, offerQuery.data, promotionsQuery.data, storesFetchQuery.data, t, targetedQuery.data, turnOffQuery.data]);

  const totalQueueWaiting = Object.values(queuesQuery.data?.queues ?? {}).reduce(
    (sum, queue) => sum + (queue.counts.waiting ?? 0) + (queue.counts.delayed ?? 0) + (queue.counts.active ?? 0), 0,
  );
  const totalQueueFailed = Object.values(queuesQuery.data?.queues ?? {}).reduce(
    (sum, queue) => sum + (queue.counts.failed ?? 0), 0,
  );
  const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  return <>
    <Topbar breadcrumb={[{ label: t('nav.dashboard') }]} />
    <main className="main-content dashboard-page">
      <section className="dashboard-hero">
        <div>
          <span className="dashboard-eyebrow">TEQUILA 1.0 · {t('pages.dashboard.commandCenter')}</span>
          <h1>{t('pages.dashboard.hello', { name: firstName })}</h1>
          <p>{isBpoOnly ? t('pages.dashboard.subtitleBpo') : t('pages.dashboard.subtitlePlatform')}</p>
        </div>
        <div className="dashboard-hero-actions">
          <span className="dashboard-date"><i />{dateLabel}</span>
          {canCreateTasks && <Link to="/tasks/new" className="btn btn-primary">+ {t('nav.newTask')}</Link>}
        </div>
      </section>

      {canSeeTasks && <>
        <section className="dashboard-metrics" aria-label={t('pages.dashboard.taskOverview')}>
          <article className="dashboard-metric metric-neutral">
            <div className="dashboard-metric-icon"><MetricIcon name="tasks" /></div>
            <div><span>{t('pages.dashboard.totalTasks')}</span><strong>{summary?.total ?? '—'}</strong><small>{summary?.createdLast24Hours ?? 0} {t('pages.dashboard.created24h')}</small></div>
          </article>
          <article className="dashboard-metric metric-warning">
            <div className="dashboard-metric-icon"><MetricIcon name="activity" /></div>
            <div><span>{t('pages.dashboard.activeWork')}</span><strong>{summary?.active ?? '—'}</strong><small>{summary?.counts.in_progress ?? 0} {t('pages.dashboard.executingNow')}</small></div>
          </article>
          <article className="dashboard-metric metric-danger">
            <div className="dashboard-metric-icon"><MetricIcon name="alert" /></div>
            <div><span>{t('pages.dashboard.attention')}</span><strong>{summary?.attention ?? '—'}</strong><small>{summary?.counts.blocked ?? 0} {t('pages.dashboard.blocked')} · {summary?.counts.failed ?? 0} {t('pages.dashboard.failedLower')}</small></div>
          </article>
          <article className="dashboard-metric metric-success">
            <div className="dashboard-metric-icon"><MetricIcon name="check" /></div>
            <div><span>{t('pages.dashboard.resolutionRate')}</span><strong>{summary?.completionRate ?? 0}%</strong><small>{summary?.counts.done ?? 0} {t('pages.dashboard.completedLower')}</small></div>
          </article>
        </section>

        <section className="dashboard-primary-grid">
          <article className="dashboard-panel workflow-panel">
            <header><div><span className="dashboard-panel-kicker">{t('pages.dashboard.operations')}</span><h2>{t('pages.dashboard.workflowHealth')}</h2></div><Link to="/tasks">{t('pages.dashboard.viewAll')} →</Link></header>
            <div className="workflow-total"><strong>{summary?.total ?? 0}</strong><span>{t('pages.dashboard.visibleTasks')}</span></div>
            <div className="workflow-bar" aria-label={t('pages.dashboard.statusDistribution')}>
              {TASK_STATUSES.map(item => {
                const count = summary?.counts[item.status] ?? 0;
                return count > 0 && <span key={item.status} title={`${t(`status.${item.status}`)}: ${count}`} style={{ width: `${(count / Math.max(summary?.total ?? 1, 1)) * 100}%`, background: item.color }} />;
              })}
            </div>
            <div className="workflow-legend">
              {TASK_STATUSES.map(item => <Link key={item.status} to={`/tasks?status=${item.status}`}>
                <i style={{ background: item.color }} /><span>{t(`status.${item.status}`)}</span><strong>{summary?.counts[item.status] ?? 0}</strong>
              </Link>)}
            </div>
          </article>

          <article className="dashboard-panel attention-panel">
            <header><div><span className="dashboard-panel-kicker">{t('pages.dashboard.priority')}</span><h2>{t('pages.dashboard.needsAttention')}</h2></div><span className={`dashboard-health-dot${summary?.attention ? ' has-issues' : ''}`} /></header>
            {attentionTasks.length ? <div className="attention-list">{attentionTasks.map(task => <button key={task.id} onClick={() => nav(`/tasks/${task.id}`)}>
              <StatusBadge status={task.status} />
              <span><strong>{task.brand?.brandName ?? t('pages.dashboard.noBrand')}</strong><small>{task.taskType?.name ?? '—'}</small></span>
              <b>›</b>
            </button>)}</div> : <div className="dashboard-clear-state"><MetricIcon name="check" /><strong>{t('pages.dashboard.noCriticalTasks')}</strong><span>{t('pages.dashboard.noCriticalTasksHint')}</span></div>}
            {(summary?.attention ?? 0) > attentionTasks.length && <Link className="attention-more" to="/tasks">+{(summary?.attention ?? 0) - attentionTasks.length} {t('pages.dashboard.moreAttention')}</Link>}
          </article>
        </section>
      </>}

      {(canSeeCatalog || integrationCards.length > 0 || queuesQuery.data) && <section className="dashboard-platform-strip">
        <div className="dashboard-platform-title"><span>{t('pages.dashboard.platform')}</span><strong>{t('pages.dashboard.platformSnapshot')}</strong></div>
        {canSeeCatalog && <Link to="/brands" className="dashboard-platform-stat"><MetricIcon name="catalog" /><span><strong>{visibleBrandCount ?? '—'}</strong>{isBpoOnly ? t('pages.dashboard.assignedBrands') : t('pages.dashboard.brands')}</span></Link>}
        {canSeeCatalog && <Link to="/shops" className="dashboard-platform-stat"><MetricIcon name="shop" /><span><strong>{visibleShopCount ?? '—'}</strong>{isBpoOnly ? t('pages.dashboard.relatedShops') : t('pages.dashboard.shops')}</span></Link>}
        {integrationCards.length > 0 && <div className="dashboard-platform-stat"><MetricIcon name="activity" /><span><strong>{integrationCards.reduce((sum, card) => sum + card.active, 0)}</strong>{t('pages.dashboard.activeAutomations')}</span></div>}
        {queuesQuery.data && <Link to="/admin" className={`dashboard-platform-stat${totalQueueFailed ? ' is-alert' : ''}`}><MetricIcon name="activity" /><span><strong>{totalQueueWaiting}</strong>{t('pages.dashboard.queueJobs')} {totalQueueFailed ? `· ${totalQueueFailed} ${t('pages.dashboard.failedLower')}` : ''}</span></Link>}
      </section>}

      {integrationCards.length > 0 && <section className="dashboard-section">
        <div className="dashboard-section-header"><div><span className="dashboard-panel-kicker">{t('pages.dashboard.automation')}</span><h2>{t('pages.dashboard.integrationHealth')}</h2></div><span>{t('pages.dashboard.onlyAuthorized')}</span></div>
        <div className="integration-card-grid">
          {integrationCards.map(card => <Link key={card.id} to={card.href} className={`integration-summary-card tone-${card.tone}`}>
            <div className="integration-summary-top"><span className="integration-symbol">{card.title.slice(0, 1)}</span><i className={card.issues ? 'is-issue' : card.running ? 'is-running' : 'is-healthy'} /></div>
            <h3>{card.title}</h3><p>{card.description}</p>
            <div className="integration-summary-metrics"><span><strong>{card.active}</strong>{t('pages.dashboard.active')}</span><span><strong>{card.running}</strong>{t('pages.dashboard.running')}</span><span className={card.issues ? 'has-issues' : ''}><strong>{card.issues}</strong>{t('pages.dashboard.issues')}</span></div>
          </Link>)}
        </div>
      </section>}

      {canSeeTasks && <section className="dashboard-panel recent-panel">
        <header><div><span className="dashboard-panel-kicker">{t('pages.dashboard.activity')}</span><h2>{t('pages.dashboard.recentTasks')}</h2></div><Link to="/tasks">{t('pages.dashboard.viewAll')} →</Link></header>
        {recent.length === 0 ? <div className="empty-state"><p>{t('pages.dashboard.noTasksYet')}</p></div> : <div className="dashboard-table-wrap"><table><thead><tr><th>{t('pages.dashboard.colBrand')}</th><th>{t('pages.dashboard.colTaskType')}</th><th>{t('pages.dashboard.section')}</th><th>{t('pages.dashboard.activeStep')}</th><th>{t('pages.dashboard.colStatus')}</th><th>{t('pages.dashboard.colCreated')}</th></tr></thead><tbody>
          {recent.slice(0, 8).map(task => <tr key={task.id} onClick={() => nav(`/tasks/${task.id}`)}><td><strong>{task.brand?.brandName ?? '—'}</strong></td><td>{task.taskType?.name ?? '—'}</td><td><span className="section-chip">{sectionNames.get(task.taskType?.sectionId ?? '') ?? '—'}</span></td><td className="text-muted">{activeStep(task)}</td><td><StatusBadge status={task.status} /></td><td className="text-muted">{new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(task.createdAt))}</td></tr>)}
        </tbody></table></div>}
      </section>}
    </main>
  </>;
}
