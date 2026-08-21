import { useQuery } from '@tanstack/react-query';
import { storeOnboardingApi } from '../../api';
import type { StoreOnboardingOperationalStatus } from '../../types';

/**
 * The status endpoint is the single frontend source of truth for exposure.
 * Loading, errors and older responses are fail-closed: OFF.
 */
export function useStoreOnboardingFeature(enabled = true) {
  const query = useQuery<StoreOnboardingOperationalStatus>({
    queryKey: ['store-onboarding-status'],
    queryFn: () => storeOnboardingApi.status().then(response => response.data),
    enabled,
    retry: false,
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
  const trusted = query.isSuccess && !query.isError;
  return {
    ...query,
    operationalReady: trusted && query.data?.operationalReady === true,
    activationAllowed: trusted && query.data?.activationAllowed === true,
    globalEnabled: trusted && query.data?.globalEnabled === true,
    notificationsEnabled: trusted && query.data?.notificationsEnabled === true,
    activationReadiness: trusted ? query.data?.activationReadiness ?? null : null,
    reason: trusted ? query.data?.reason ?? null : null,
  };
}
