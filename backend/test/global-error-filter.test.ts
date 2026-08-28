import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ArgumentsHost } from '@nestjs/common';
import { GlobalErrorFilter } from '../src/common/filters/global-error.filter';

function createHttpHost() {
  const state: { status?: number; body?: unknown } = {};
  const response = {
    status(status: number) {
      state.status = status;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', url: '/integrations/didi-store-bindings/executions' }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { host, state };
}

test('global error filter preserves Express payload-too-large as HTTP 413', async () => {
  let alerts = 0;
  const filter = new GlobalErrorFilter({
    sendAlert: async () => { alerts += 1; },
  } as never);
  const { host, state } = createHttpHost();
  const error = Object.assign(new Error('request entity too large'), {
    status: 413,
    statusCode: 413,
    type: 'entity.too.large',
  });

  await filter.catch(error, host);

  assert.equal(state.status, 413);
  assert.deepEqual(state.body, { statusCode: 413, message: 'Payload Too Large' });
  assert.equal(alerts, 0);
});

test('global error filter preserves other parser 4xx statuses without alerting', async () => {
  let alerts = 0;
  const filter = new GlobalErrorFilter({
    sendAlert: async () => { alerts += 1; },
  } as never);
  const { host, state } = createHttpHost();
  const error = Object.assign(new SyntaxError('invalid json'), {
    status: 400,
    type: 'entity.parse.failed',
  });

  await filter.catch(error, host);

  assert.equal(state.status, 400);
  assert.deepEqual(state.body, { statusCode: 400, message: 'Bad Request' });
  assert.equal(alerts, 0);
});
