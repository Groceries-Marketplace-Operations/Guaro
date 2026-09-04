import { useQuery } from '@tanstack/react-query';
import { applicationsApi } from '../api';
import OrderWebhookLogsPanel from '../components/applications/OrderWebhookLogsPanel';
import '../components/applications/order-webhook-logs.css';
import Topbar from '../components/layout/Topbar';
import { useT } from '../i18n';
import type { Application, Paginated } from '../types';

const APPLICATION_PAGE_SIZE = 100;

async function loadActiveApplications() {
  const firstResponse = await applicationsApi.list({ page: 1, limit: APPLICATION_PAGE_SIZE });
  const firstPage = firstResponse.data as Paginated<Application>;
  const pageCount = Math.ceil(firstPage.total / APPLICATION_PAGE_SIZE);
  if (pageCount <= 1) return firstPage.data;

  const remainingPages = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) => applicationsApi.list({
      page: index + 2,
      limit: APPLICATION_PAGE_SIZE,
    }).then(response => (response.data as Paginated<Application>).data)),
  );
  return [firstPage.data, ...remainingPages].flat();
}

export default function OrderWebhookLogsPage() {
  const t = useT();
  const applicationsQuery = useQuery<Application[]>({
    queryKey: ['applications', 'order-webhook-log-filter'],
    queryFn: loadActiveApplications,
  });

  return (
    <>
      <Topbar breadcrumb={[
        { label: t('nav.applications'), href: '/applications' },
        { label: t('nav.orderWebhookLogs') },
      ]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('pages.applications.orderWebhookLogsPageTitle')}</h1>
            <p>{t('pages.applications.orderWebhookLogsPageSubtitle')}</p>
          </div>
        </div>

        {applicationsQuery.isError && (
          <div className="error-banner">
            {t('pages.applications.orderWebhookLogsApplicationsLoadError')}
          </div>
        )}

        <OrderWebhookLogsPanel
          active
          applications={applicationsQuery.data ?? []}
          applicationsLoading={applicationsQuery.isLoading}
        />
      </main>
    </>
  );
}
