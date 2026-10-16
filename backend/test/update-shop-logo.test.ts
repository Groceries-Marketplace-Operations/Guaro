import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { HandlerContext } from '../src/queue/handler.processor';
import { updateShopHeadImage, updateShopLogo } from '../src/queue/handlers/store-operations.handler';

const originalFetch = global.fetch;
const originalFrontendUrl = process.env.FRONTEND_URL;

afterEach(() => {
  global.fetch = originalFetch;
  if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = originalFrontendUrl;
});

test('Update Store Logo sends shop_logo without changing the head image', async () => {
  const updateBodies: Array<Record<string, unknown>> = [];
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/v1/auth/authtoken/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh-token' } }));
    }
    if (url.includes('/v1/auth/authtoken/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth-token' } }));
    }
    if (url.endsWith('/v1/shop/shop/update')) {
      updateBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ errno: 0, data: {} }));
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  process.env.FRONTEND_URL = 'https://workspace.example.test/guaro/';

  const notes: string[] = [];
  const context = {
    brand: {
      id: 'brand-id',
      brandId: 'brand-reference',
      brandName: 'Example Brand',
      country: 'MX',
      kaType: null,
      category: null,
      application: {
        id: 'application-id',
        appId: 'app-id',
        appName: 'Example Application',
        appSecret: 'app-secret',
      },
    },
    field: (label: string) => ({
      'Shop Logo': '123e4567-e89b-12d3-a456-426614174000.png',
      'Target Shop IDs': 'store-alpha',
    })[label] ?? null,
    addNote: (note: string) => notes.push(note),
  } as unknown as HandlerContext;

  const result = await updateShopLogo(context);

  assert.equal(updateBodies.length, 1);
  assert.deepEqual(updateBodies[0], {
    auth_token: 'auth-token',
    shop_logo: 'https://workspace.example.test/guaro/api/uploads/task-assets/123e4567-e89b-12d3-a456-426614174000.png',
  });
  assert.equal('shop_head_img' in updateBodies[0], false);
  assert.equal(result.field, 'shop_logo');
  assert.equal(result.success, 1);
  assert.match(notes.join('\n'), /shop_logo updated/);
});

test('Update Store Head Image still sends shop_head_img after the shared image refactor', async () => {
  const updateBodies: Array<Record<string, unknown>> = [];
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/v1/auth/authtoken/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: 'refresh-token' } }));
    }
    if (url.includes('/v1/auth/authtoken/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: 'auth-token' } }));
    }
    if (url.endsWith('/v1/shop/shop/update')) {
      updateBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ errno: 0, data: {} }));
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  process.env.FRONTEND_URL = 'https://workspace.example.test/guaro/';

  const context = {
    brand: {
      id: 'brand-id',
      brandId: 'brand-reference',
      brandName: 'Example Brand',
      country: 'MX',
      kaType: null,
      category: null,
      application: {
        id: 'application-id',
        appId: 'app-id',
        appName: 'Example Application',
        appSecret: 'app-secret',
      },
    },
    field: (label: string) => ({
      'Shop Head Image': '123e4567-e89b-12d3-a456-426614174000.jpg',
      'Target Shop IDs': 'store-alpha',
    })[label] ?? null,
    addNote: () => undefined,
  } as unknown as HandlerContext;

  const result = await updateShopHeadImage(context);

  assert.deepEqual(updateBodies[0], {
    auth_token: 'auth-token',
    shop_head_img: 'https://workspace.example.test/guaro/api/uploads/task-assets/123e4567-e89b-12d3-a456-426614174000.jpg',
  });
  assert.equal('shop_logo' in updateBodies[0], false);
  assert.equal(result.field, 'shop_head_img');
});

test('a partial store image update rejects the handler and records a useful summary', async () => {
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const appShopId = url.searchParams.get('app_shop_id') ?? '';
    if (url.pathname.endsWith('/v1/auth/authtoken/refresh')) {
      return new Response(JSON.stringify({ errno: 0, data: { refresh_token: `refresh-${appShopId}` } }));
    }
    if (url.pathname.endsWith('/v1/auth/authtoken/get')) {
      return new Response(JSON.stringify({ errno: 0, data: { auth_token: `auth-${appShopId}` } }));
    }
    if (url.pathname.endsWith('/v1/shop/shop/update')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.auth_token === 'auth-store-beta') {
        return new Response(JSON.stringify({ errno: 30001, errmsg: 'shop rejected the image' }));
      }
      return new Response(JSON.stringify({ errno: 0, data: {} }));
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  process.env.FRONTEND_URL = 'https://workspace.example.test/guaro';

  const notes: string[] = [];
  const context = {
    brand: {
      id: 'brand-id',
      brandId: 'brand-reference',
      brandName: 'Example Brand',
      country: 'MX',
      kaType: null,
      category: null,
      application: {
        id: 'application-id',
        appId: 'app-id',
        appName: 'Example Application',
        appSecret: 'app-secret',
      },
    },
    field: (label: string) => ({
      'Shop Logo': '123e4567-e89b-12d3-a456-426614174000.png',
      'Target Shop IDs': 'store-alpha store-beta',
    })[label] ?? null,
    addNote: (note: string) => notes.push(note),
  } as unknown as HandlerContext;

  await assert.rejects(
    () => updateShopLogo(context),
    /shop_logo update incomplete: 1\/2 stores updated and 1 failed/,
  );
  assert.match(notes.join('\n'), /store-alpha: shop_logo updated/);
  assert.match(notes.join('\n'), /store-beta: POST \/v1\/shop\/shop\/update failed/);
  assert.match(notes.join('\n'), /Summary: 1\/2 stores updated; 1 failed/);
});

test('store image updates reject a non-public FRONTEND_URL before contacting DiDi', async () => {
  let contactedDidi = false;
  global.fetch = (async () => {
    contactedDidi = true;
    throw new Error('DiDi should not be contacted');
  }) as typeof fetch;
  process.env.FRONTEND_URL = 'http://localhost:5173/guaro';

  const context = {
    brand: {
      brandName: 'Example Brand',
      application: { appId: 'app-id', appSecret: 'app-secret' },
    },
    field: (label: string) => ({
      'Shop Logo': '123e4567-e89b-12d3-a456-426614174000.png',
      'Target Shop IDs': 'store-alpha',
    })[label] ?? null,
  } as unknown as HandlerContext;

  await assert.rejects(() => updateShopLogo(context), /absolute public HTTPS URL/);
  assert.equal(contactedDidi, false);
});
