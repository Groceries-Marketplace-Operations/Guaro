import { lookup } from 'dns/promises';
import { LookupAddress } from 'dns';
import { isIP } from 'net';

export class ForwardingUrlError extends Error {}

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.google',
  'instance-data',
  'metadata.azure.internal',
]);

function normalizedHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
}

function isDidiApiHostname(hostname: string) {
  return hostname === 'openapi.didi-food.com'
    || hostname.endsWith('.openapi.didi-food.com');
}

function ipv4Octets(address: string) {
  if (isIP(address) !== 4) return null;
  return address.split('.').map(part => Number(part));
}

function ipv6Bytes(address: string): number[] | null {
  const withoutZone = address.split('%', 1)[0].toLowerCase();
  if (isIP(withoutZone) !== 6) return null;

  let normalized = withoutZone;
  const ipv4Tail = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const octets = ipv4Octets(ipv4Tail);
    if (!octets) return null;
    const replacement = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    normalized = normalized.slice(0, -ipv4Tail.length) + replacement;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = halves.length === 2
    ? [...left, ...Array.from({ length: missing }, () => '0'), ...right]
    : left;
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    const value = Number.parseInt(group || '0', 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) return null;
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

export function isPrivateOrLocalAddress(address: string): boolean {
  const v4 = ipv4Octets(address);
  if (v4) {
    const [a, b] = v4;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 2)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && v4[2] === 100)
      || (a === 203 && b === 0 && v4[2] === 113)
      || a >= 224;
  }

  const v6 = ipv6Bytes(address);
  if (!v6) return true;
  const allZero = v6.every(byte => byte === 0);
  const loopback = v6.slice(0, 15).every(byte => byte === 0) && v6[15] === 1;
  const uniqueLocal = (v6[0] & 0xfe) === 0xfc;
  const linkLocal = v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80;
  const siteLocal = v6[0] === 0xfe && (v6[1] & 0xc0) === 0xc0;
  const multicast = v6[0] === 0xff;
  const ipv4Mapped = v6.slice(0, 10).every(byte => byte === 0)
    && v6[10] === 0xff
    && v6[11] === 0xff;
  const mappedPrivate: boolean = ipv4Mapped
    && isPrivateOrLocalAddress(v6.slice(12).join('.'));
  const ipv4Compatible = v6.slice(0, 12).every(byte => byte === 0);
  const globalUnicast = (v6[0] & 0xe0) === 0x20;
  const protocolAssignments = v6[0] === 0x20
    && v6[1] === 0x01
    && v6[2] <= 0x01;
  const sixToFour = v6[0] === 0x20 && v6[1] === 0x02;
  const documentation = v6[0] === 0x3f && v6[1] === 0xff;
  return allZero
    || loopback
    || uniqueLocal
    || linkLocal
    || siteLocal
    || multicast
    || mappedPrivate
    || ipv4Compatible
    || !globalUnicast
    || protocolAssignments
    || sixToFour
    || documentation;
}

export function validateForwardingUrl(value: string, production: boolean) {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ForwardingUrlError('Forwarding URL is invalid');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ForwardingUrlError('Forwarding URL must use HTTP or HTTPS');
  }
  if (production && url.protocol !== 'https:') {
    throw new ForwardingUrlError('Forwarding URL must use HTTPS in production');
  }
  if (url.username || url.password) {
    throw new ForwardingUrlError('Forwarding URL cannot contain user credentials');
  }
  if (url.hash) {
    throw new ForwardingUrlError('Forwarding URL cannot contain a fragment');
  }

  const hostname = normalizedHostname(url.hostname);
  if (!hostname || isDidiApiHostname(hostname)) {
    throw new ForwardingUrlError('Forwarding URL hostname is not allowed');
  }
  if (production) {
    if (
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || BLOCKED_HOSTNAMES.has(hostname)
      || (isIP(hostname) !== 0 && isPrivateOrLocalAddress(hostname))
    ) {
      throw new ForwardingUrlError('Forwarding URL hostname is not allowed');
    }
  }

  if (isIP(hostname) !== 6) url.hostname = hostname;
  return { url: url.toString(), hostname };
}

export async function resolveForwardingAddress(
  url: URL,
  production: boolean,
  timeoutMs = 5_000,
) {
  const hostname = normalizedHostname(url.hostname);
  let addresses: LookupAddress[];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ForwardingUrlError('Forwarding hostname could not be resolved')),
          timeoutMs,
        );
      }),
    ]);
  } catch {
    throw new ForwardingUrlError('Forwarding hostname could not be resolved');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (addresses.length === 0) {
    throw new ForwardingUrlError('Forwarding hostname could not be resolved');
  }
  if (production && addresses.some(result => isPrivateOrLocalAddress(result.address))) {
    throw new ForwardingUrlError('Forwarding hostname resolved to a private or local address');
  }
  return addresses[0];
}
