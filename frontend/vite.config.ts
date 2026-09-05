import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const LOCAL_PRODUCTION_MODE = 'local-production';
const LOCAL_PRODUCTION_API_PREFIX = '/guaro/api';
const LOCAL_PRODUCTION_STOP_PATH = '/guaro/__local-production/stop';
const LOCAL_PRODUCTION_TARGET = 'https://workspace.didi-shop.com';
const LOCAL_PRODUCTION_NONCE_HEADER = 'x-guaro-local-session';

type LocalProductionConfig = {
  accessToken: string;
  expiresAt: string;
  nonce: string;
  port: number;
};

function requiredServerSecret(name: string, value: string | undefined, minimumLength: number) {
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} is required for local-production mode`);
  }
  return value;
}

function localProductionConfig(): LocalProductionConfig {
  const accessToken = requiredServerSecret(
    'GUARO_LOCAL_PROD_ACCESS_TOKEN',
    process.env.GUARO_LOCAL_PROD_ACCESS_TOKEN,
    32,
  );
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)) {
    throw new Error('GUARO_LOCAL_PROD_ACCESS_TOKEN must be a JWT');
  }

  const nonce = requiredServerSecret(
    'GUARO_LOCAL_PROD_NONCE',
    process.env.GUARO_LOCAL_PROD_NONCE,
    32,
  );
  const expiresAt = requiredServerSecret(
    'GUARO_LOCAL_PROD_EXPIRES_AT',
    process.env.GUARO_LOCAL_PROD_EXPIRES_AT,
    16,
  );
  const expiration = Date.parse(expiresAt);
  if (!Number.isFinite(expiration) || expiration <= Date.now()) {
    throw new Error('GUARO_LOCAL_PROD_EXPIRES_AT must be a future ISO timestamp');
  }
  if (expiration - Date.now() > 16 * 60 * 1000) {
    throw new Error('GUARO_LOCAL_PROD_EXPIRES_AT exceeds the temporary-session limit');
  }

  const port = Number(process.env.GUARO_LOCAL_PROD_PORT);
  if (!Number.isInteger(port) || port < 49152 || port > 65535) {
    throw new Error('GUARO_LOCAL_PROD_PORT must be a high dynamic port between 49152 and 65535');
  }

  return { accessToken, expiresAt, nonce, port };
}

function headerValue(request: IncomingMessage, name: string) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function reject(response: ServerResponse, statusCode: number, message: string) {
  response.statusCode = statusCode;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ statusCode, message }));
}

function decodedPathname(rawPathname: string) {
  try {
    return new URL(decodeURIComponent(rawPathname), 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
}

function localProductionGuard(config: LocalProductionConfig): Plugin {
  const allowedOrigins = new Set([
    `http://127.0.0.1:${config.port}`,
  ]);
  const allowedHosts = new Set([
    `127.0.0.1:${config.port}`,
  ]);

  return {
    name: 'guaro-local-production-guard',
    enforce: 'pre',
    configResolved(resolved) {
      if (resolved.command !== 'serve') {
        throw new Error('local-production mode may only run as a development server');
      }
      if (resolved.server.host !== '127.0.0.1' || resolved.server.cors !== false) {
        throw new Error('local-production mode must remain bound to 127.0.0.1 with CORS disabled');
      }
    },
    configureServer(server) {
      let closing = false;
      const closeLocalServer = (exitCode: number) => {
        if (closing) return;
        closing = true;
        // ViteDevServer.close() also closes HMR WebSockets. Closing only
        // httpServer can wait forever while the browser remains open.
        void server.close()
          .then(() => process.exit(exitCode))
          .catch(() => process.exit(1));
      };
      const expirationTimer = setTimeout(
        () => closeLocalServer(0),
        Math.max(1, Date.parse(config.expiresAt) - Date.now()),
      );
      server.httpServer?.once('close', () => clearTimeout(expirationTimer));

      server.middlewares.use((request, response, next) => {
        const requestTarget = request.url ?? '/';
        const rawPathname = requestTarget.split(/[?#]/, 1)[0];
        const pathname = new URL(requestTarget, 'http://127.0.0.1').pathname;
        const isApiRequest = pathname === LOCAL_PRODUCTION_API_PREFIX
          || pathname.startsWith(`${LOCAL_PRODUCTION_API_PREFIX}/`);
        const isApiProxyCandidate = rawPathname.startsWith(LOCAL_PRODUCTION_API_PREFIX);
        const isStopRequest = pathname === LOCAL_PRODUCTION_STOP_PATH;

        // Vite's proxy context is a prefix match. Reject non-canonical lookalike
        // and traversal paths before they can inherit the production bearer.
        if (isApiProxyCandidate) {
          const decoded = decodedPathname(rawPathname);
          if (decoded === null) {
            reject(response, 400, 'Local production proxy rejected this API path');
            return;
          }
          const decodedIsApiRequest = decoded === LOCAL_PRODUCTION_API_PREFIX
            || decoded.startsWith(`${LOCAL_PRODUCTION_API_PREFIX}/`);
          if (!isApiRequest || !decodedIsApiRequest || rawPathname.includes('\\')) {
            reject(response, 400, 'Local production proxy rejected this API path');
            return;
          }
        }
        if (!isApiRequest && !isStopRequest) {
          next();
          return;
        }

        const host = headerValue(request, 'host');
        const origin = headerValue(request, 'origin');
        const referer = headerValue(request, 'referer');
        const fetchSite = headerValue(request, 'sec-fetch-site');
        const nonce = headerValue(request, LOCAL_PRODUCTION_NONCE_HEADER);

        if (!host || !allowedHosts.has(host.toLowerCase())) {
          reject(response, 403, 'Local production proxy rejected this Host');
          return;
        }
        if (origin && !allowedOrigins.has(origin)) {
          reject(response, 403, 'Local production proxy rejected this Origin');
          return;
        }
        if (referer) {
          let refererOrigin: string;
          try {
            refererOrigin = new URL(referer).origin;
          } catch {
            reject(response, 403, 'Local production proxy rejected this Referer');
            return;
          }
          if (!allowedOrigins.has(refererOrigin)) {
            reject(response, 403, 'Local production proxy rejected this Referer');
            return;
          }
        }
        if (fetchSite && fetchSite !== 'same-origin') {
          reject(response, 403, 'Local production proxy only accepts same-origin browser requests');
          return;
        }
        if (nonce !== config.nonce) {
          reject(response, 403, 'Local production proxy rejected this session nonce');
          return;
        }

        if (isStopRequest) {
          if (request.method !== 'POST') {
            reject(response, 405, 'Method not allowed');
            return;
          }
          response.statusCode = 202;
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ stopping: true }));
          setTimeout(() => closeLocalServer(0), 50);
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const isLocalProduction = mode === LOCAL_PRODUCTION_MODE;
  if (!isLocalProduction) {
    return {
      plugins: [react()],
      base: '/guaro/',
      define: {
        'import.meta.env.GUARO_LOCAL_PRODUCTION': JSON.stringify('false'),
        'import.meta.env.GUARO_LOCAL_PRODUCTION_NONCE': JSON.stringify(''),
        'import.meta.env.GUARO_LOCAL_PRODUCTION_EXPIRES_AT': JSON.stringify(''),
      },
    };
  }

  if (command !== 'serve') {
    throw new Error('local-production mode cannot be used for builds or previews');
  }
  const local = localProductionConfig();

  return {
    plugins: [localProductionGuard(local), react()],
    base: '/guaro/',
    define: {
      // The per-launch nonce is deliberately browser-visible. It protects the
      // loopback proxy from cross-origin requests and is not a production JWT.
      'import.meta.env.GUARO_LOCAL_PRODUCTION': JSON.stringify('true'),
      'import.meta.env.GUARO_LOCAL_PRODUCTION_NONCE': JSON.stringify(local.nonce),
      'import.meta.env.GUARO_LOCAL_PRODUCTION_EXPIRES_AT': JSON.stringify(local.expiresAt),
    },
    server: {
      host: '127.0.0.1',
      port: local.port,
      strictPort: true,
      cors: false,
      allowedHosts: ['127.0.0.1'],
      headers: {
        'Cache-Control': 'no-store',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      },
      proxy: {
        [LOCAL_PRODUCTION_API_PREFIX]: {
          target: LOCAL_PRODUCTION_TARGET,
          changeOrigin: true,
          secure: true,
          configure(proxy) {
            proxy.on('proxyReq', (proxyRequest) => {
              proxyRequest.removeHeader(LOCAL_PRODUCTION_NONCE_HEADER);
              proxyRequest.removeHeader('authorization');
              proxyRequest.removeHeader('cookie');
              proxyRequest.removeHeader('origin');
              proxyRequest.removeHeader('referer');
              proxyRequest.setHeader('Authorization', `Bearer ${local.accessToken}`);
            });
            proxy.on('proxyRes', (proxyResponse) => {
              proxyResponse.headers['cache-control'] = 'no-store';
              delete proxyResponse.headers.authorization;
              delete proxyResponse.headers['set-cookie'];
              delete proxyResponse.headers['access-control-allow-origin'];
              delete proxyResponse.headers['access-control-allow-credentials'];
            });
          },
        },
      },
    },
  };
});
