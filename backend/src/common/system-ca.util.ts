import * as tls from 'node:tls';

type SystemCaRuntime = {
  getCACertificates?: (type: 'default' | 'system') => string[];
  setDefaultCACertificates?: (certificates: string[]) => void;
};

/**
 * Add operating-system certificate authorities to Node's default TLS trust.
 *
 * Node 24 exposes this API directly. Older runtimes (including the Node 20
 * production image) safely keep their existing trust store when the API is
 * unavailable.
 */
export function enableSystemCertificateAuthorities(): number {
  const runtime = tls as unknown as SystemCaRuntime;
  if (!runtime.getCACertificates || !runtime.setDefaultCACertificates) return 0;

  const systemCertificates = runtime.getCACertificates('system');
  if (!systemCertificates.length) return 0;

  const defaultCertificates = runtime.getCACertificates('default');
  runtime.setDefaultCACertificates([...new Set([...defaultCertificates, ...systemCertificates])]);
  return systemCertificates.length;
}
