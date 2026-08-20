import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { integrationsApi } from '../../api';
import { useLang, useT } from '../../i18n';
import type {
  AutoOpenPool,
  AutoOpenPoolStore,
  AutoOpenStoreInclusion,
  AutoOpenStoreSummary,
} from '../../types';

const PAGE_SIZE = 25;

type InclusionFilter = '' | 'included' | 'emergency' | 'configuration';

const EMPTY_SUMMARY: AutoOpenStoreSummary = {
  totalStores: 0,
  includedStores: 0,
  emergencyProtectedStores: 0,
  configurationBlockedStores: 0,
};

function inclusionLabel(
  store: AutoOpenPoolStore,
  t: ReturnType<typeof useT>,
) {
  switch (store.inclusion) {
    case 'included':
      return t('pages.integrations.poolStores.included');
    case 'emergency':
      return store.emergency?.scope === 'brand'
        ? t('pages.integrations.poolStores.protectedBrand')
        : t('pages.integrations.poolStores.protectedStore');
    case 'configuration':
      return t('pages.integrations.poolStores.missingApplication');
  }
}

function inclusionClass(inclusion: AutoOpenStoreInclusion) {
  if (inclusion === 'included') return 'included';
  return inclusion;
}

function reasonLabel(store: AutoOpenPoolStore, t: ReturnType<typeof useT>) {
  if (store.reason === 'missing_active_application') {
    return t('pages.integrations.poolStores.reasonMissingApplication');
  }
  if (store.reason === 'live_brand_emergency') {
    return t('pages.integrations.poolStores.reasonBrandEmergency', {
      id: store.emergency?.id ?? '—',
      status: store.emergency?.status ?? '—',
    });
  }
  if (store.reason === 'live_store_emergency') {
    return t('pages.integrations.poolStores.reasonStoreEmergency', {
      id: store.emergency?.id ?? '—',
      status: store.emergency?.status ?? '—',
    });
  }
  return t('pages.integrations.poolStores.reasonIncluded');
}

function StoreIdentity({ store }: { store: AutoOpenPoolStore }) {
  return (
    <div className="auto-open-store-identity">
      <strong>{store.name || store.shopId}</strong>
      <span>{store.shopId} · {store.appShopId}</span>
    </div>
  );
}

interface Props {
  pool: AutoOpenPool;
}

export default function AutoOpenPoolStoresExplorer({ pool }: Props) {
  const t = useT();
  const { lang } = useLang();
  const [expanded, setExpanded] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [brandId, setBrandId] = useState('');
  const [inclusion, setInclusion] = useState<InclusionFilter>('');
  const [page, setPage] = useState(1);
  const regionId = `auto-open-pool-stores-${pool.id}`;
  const number = useMemo(() => new Intl.NumberFormat(lang === 'es' ? 'es-MX' : 'en-US'), [lang]);
  const membershipKey = useMemo(
    () => pool.brands.map(membership => membership.brandId).sort().join('|'),
    [pool.brands],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const storesQuery = useQuery({
    queryKey: ['auto-open-pool-stores', pool.id, membershipKey, page, search, brandId, inclusion],
    queryFn: () => integrationsApi.listPoolStores(pool.id, {
      page,
      limit: PAGE_SIZE,
      ...(search ? { search } : {}),
      ...(brandId ? { brandId } : {}),
      ...(inclusion ? { inclusion } : {}),
    }).then(response => response.data),
    enabled: expanded,
    placeholderData: previous => previous,
  });

  const response = storesQuery.data;
  const totalPages = Math.max(1, Math.ceil((response?.total ?? 0) / PAGE_SIZE));
  const hasFilters = Boolean(searchInput || brandId || inclusion);

  const clearFilters = () => {
    setSearchInput('');
    setSearch('');
    setBrandId('');
    setInclusion('');
    setPage(1);
  };

  const selectBrand = (nextBrandId: string) => {
    setBrandId(nextBrandId);
    setPage(1);
  };

  return (
    <div className="auto-open-pool-explorer">
      <button
        type="button"
        className="btn btn-ghost btn-sm auto-open-pool-expand"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => setExpanded(value => !value)}
      >
        {expanded
          ? t('pages.integrations.poolStores.hideStores')
          : t('pages.integrations.poolStores.viewStores')}
        <span aria-hidden="true">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <section id={regionId} className="auto-open-pool-detail" aria-label={t('pages.integrations.poolStores.regionLabel', { pool: pool.name })}>
          <div className="auto-open-pool-local-note">
            <span aria-hidden="true">ⓘ</span>
            <p>{t('pages.integrations.poolStores.localCatalogNote')}</p>
          </div>

          <details className="auto-open-brand-coverage">
            <summary>
              <span>{t('pages.integrations.poolStores.brandCoverage')}</span>
              <strong>{number.format(pool.brands.length)}</strong>
            </summary>
            <div className="auto-open-table-scroll">
              <table className="auto-open-coverage-table">
                <caption className="sr-only">{t('pages.integrations.poolStores.brandCoverageCaption', { pool: pool.name })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('pages.integrations.poolStores.brand')}</th>
                    <th scope="col">{t('pages.integrations.poolStores.total')}</th>
                    <th scope="col">{t('pages.integrations.poolStores.includedPlural')}</th>
                    <th scope="col">{t('pages.integrations.poolStores.protectedPlural')}</th>
                    <th scope="col">{t('pages.integrations.poolStores.configuration')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.brands.map(membership => {
                    const summary = membership.storeSummary ?? EMPTY_SUMMARY;
                    return (
                      <tr key={membership.brandId}>
                        <th scope="row">
                          <button type="button" onClick={() => selectBrand(membership.brandId)}>
                            <span>{membership.brand.brandName}</span>
                            <small>{membership.brand.brandId}</small>
                          </button>
                        </th>
                        <td>{number.format(summary.totalStores)}</td>
                        <td>{number.format(summary.includedStores)}</td>
                        <td>{number.format(summary.emergencyProtectedStores)}</td>
                        <td>{number.format(summary.configurationBlockedStores)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>

          <div className="auto-open-store-toolbar">
            <div className="auto-open-store-search">
              <label className="sr-only" htmlFor={`${regionId}-search`}>
                {t('pages.integrations.poolStores.searchLabel')}
              </label>
              <span aria-hidden="true">⌕</span>
              <input
                id={`${regionId}-search`}
                className="form-input"
                type="search"
                value={searchInput}
                onChange={event => setSearchInput(event.target.value)}
                placeholder={t('pages.integrations.poolStores.searchPlaceholder')}
              />
            </div>
            <label>
              <span>{t('pages.integrations.poolStores.brand')}</span>
              <select className="form-select" value={brandId} onChange={event => selectBrand(event.target.value)}>
                <option value="">{t('pages.integrations.poolStores.allBrands')}</option>
                {pool.brands.map(membership => (
                  <option key={membership.brandId} value={membership.brandId}>{membership.brand.brandName}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('pages.integrations.poolStores.inclusion')}</span>
              <select
                className="form-select"
                value={inclusion}
                onChange={event => {
                  setInclusion(event.target.value as InclusionFilter);
                  setPage(1);
                }}
              >
                <option value="">{t('pages.integrations.poolStores.allInclusions')}</option>
                <option value="included">{t('pages.integrations.poolStores.includedPlural')}</option>
                <option value="emergency">{t('pages.integrations.poolStores.protectedPlural')}</option>
                <option value="configuration">{t('pages.integrations.poolStores.configurationIssues')}</option>
              </select>
            </label>
            {hasFilters && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                {t('pages.integrations.poolStores.clearFilters')}
              </button>
            )}
          </div>

          <div className="auto-open-store-results" aria-busy={storesQuery.isFetching}>
            <div className="auto-open-store-results-heading" aria-live="polite">
              <strong>
                {response
                  ? t('pages.integrations.poolStores.resultCount', { count: number.format(response.total) })
                  : t('pages.integrations.poolStores.loading')}
              </strong>
              {storesQuery.isFetching && !storesQuery.isLoading && <span>{t('pages.integrations.poolStores.updating')}</span>}
              {response?.calculatedAt && (
                <span>{t('pages.integrations.poolStores.calculatedAt', {
                  date: new Date(response.calculatedAt).toLocaleString(lang === 'es' ? 'es-MX' : 'en-US'),
                })}</span>
              )}
            </div>

            {storesQuery.isLoading && (
              <div className="auto-open-state" role="status">{t('pages.integrations.poolStores.loading')}</div>
            )}
            {storesQuery.isError && (
              <div className="auto-open-state error" role="alert">
                <p>{t('pages.integrations.poolStores.loadError')}</p>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => storesQuery.refetch()}>
                  {t('pages.integrations.poolStores.retry')}
                </button>
              </div>
            )}
            {!storesQuery.isLoading && !storesQuery.isError && response?.data.length === 0 && (
              <div className="auto-open-state">
                <strong>{t('pages.integrations.poolStores.empty')}</strong>
                <p>{hasFilters ? t('pages.integrations.poolStores.emptyFiltered') : t('pages.integrations.poolStores.emptyPool')}</p>
              </div>
            )}

            {!storesQuery.isError && response && response.data.length > 0 && (
              <>
                <div className="auto-open-table-scroll auto-open-store-table-wrap">
                  <table className="auto-open-store-table">
                    <caption className="sr-only">{t('pages.integrations.poolStores.storesCaption', { pool: pool.name })}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('pages.integrations.poolStores.status')}</th>
                        <th scope="col">{t('pages.integrations.poolStores.store')}</th>
                        <th scope="col">{t('pages.integrations.poolStores.brand')}</th>
                        <th scope="col">{t('pages.integrations.poolStores.city')}</th>
                        <th scope="col">{t('pages.integrations.poolStores.reason')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {response.data.map(store => (
                        <tr key={store.id}>
                          <td><span className={`auto-open-inclusion ${inclusionClass(store.inclusion)}`}>{inclusionLabel(store, t)}</span></td>
                          <td><StoreIdentity store={store} /></td>
                          <td><strong>{store.brand.brandName}</strong><small>{store.brand.brandId}</small></td>
                          <td>{store.city || '—'}</td>
                          <td className="auto-open-store-reason">{reasonLabel(store, t)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="auto-open-store-cards">
                  {response.data.map(store => (
                    <article key={store.id} className="auto-open-store-card">
                      <div>
                        <StoreIdentity store={store} />
                        <span className={`auto-open-inclusion ${inclusionClass(store.inclusion)}`}>{inclusionLabel(store, t)}</span>
                      </div>
                      <dl>
                        <div><dt>{t('pages.integrations.poolStores.brand')}</dt><dd>{store.brand.brandName}</dd></div>
                        <div><dt>{t('pages.integrations.poolStores.city')}</dt><dd>{store.city || '—'}</dd></div>
                        <div><dt>{t('pages.integrations.poolStores.reason')}</dt><dd>{reasonLabel(store, t)}</dd></div>
                      </dl>
                    </article>
                  ))}
                </div>

                <nav className="auto-open-pagination" aria-label={t('pages.integrations.poolStores.paginationLabel')}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={page <= 1 || storesQuery.isFetching}
                    onClick={() => setPage(current => Math.max(1, current - 1))}
                  >
                    ← {t('common.previous')}
                  </button>
                  <span>{t('pages.integrations.poolStores.pageOf', {
                    page: number.format(page),
                    total: number.format(totalPages),
                  })}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={page >= totalPages || storesQuery.isFetching}
                    onClick={() => setPage(current => Math.min(totalPages, current + 1))}
                  >
                    {t('common.next')} →
                  </button>
                </nav>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
