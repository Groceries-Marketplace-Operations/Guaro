import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validate } from 'class-validator';
import {
  Country,
  DidiOrderWebhookProfitMode,
  Prisma,
} from '@prisma/client';
import {
  calculateDidiOrderFinancialSnapshot,
  minorUnitsToMajorString,
} from '../src/didi-order-webhooks/didi-order-webhook-finance.util';
import { UpdateOrderWebhookFinanceDto } from '../src/applications/dto/update-order-webhook-finance.dto';

const decimal = (value: string | number) => new Prisma.Decimal(value);

function assertProfitIsNull(snapshot: ReturnType<typeof calculateDidiOrderFinancialSnapshot>) {
  assert.equal(snapshot.profitMode, null);
  assert.equal(snapshot.profitValue, null);
  assert.equal(snapshot.nativeToMxnRate, null);
  assert.equal(snapshot.mxnPerUsdRate, null);
  assert.equal(snapshot.profitMxn, null);
  assert.equal(snapshot.profitUsd, null);
}

test('fixed MXN profit is explicit and does not depend on an order amount', () => {
  const snapshot = calculateDidiOrderFinancialSnapshot(Country.MX, null, {
    orderWebhookProfitMode: DidiOrderWebhookProfitMode.fixed_mxn,
    orderWebhookProfitValue: decimal('8.50'),
    orderWebhookNativeToMxn: null,
    orderWebhookMxnPerUsd: decimal('17.00'),
  });

  assert.equal(snapshot.orderCurrency, 'MXN');
  assert.equal(snapshot.profitMxn?.toString(), '8.5');
  assert.equal(snapshot.profitUsd?.toString(), '0.5');
  assert.equal(snapshot.nativeToMxnRate, null);
});

test('percentage profit uses real_pay_price minor units and configured FX only', () => {
  const snapshot = calculateDidiOrderFinancialSnapshot(Country.CO, 100_000n, {
    orderWebhookProfitMode: DidiOrderWebhookProfitMode.percentage,
    orderWebhookProfitValue: decimal('10'),
    orderWebhookNativeToMxn: decimal('0.004'),
    orderWebhookMxnPerUsd: decimal('20'),
  });

  assert.equal(snapshot.orderCurrency, 'COP');
  assert.equal(snapshot.profitMxn?.toString(), '0.4');
  assert.equal(snapshot.profitUsd?.toString(), '0.02');
  assert.equal(snapshot.nativeToMxnRate?.toString(), '0.004');
});

test('incomplete configuration or missing percentage base stays unconfigured', () => {
  const missingRate = calculateDidiOrderFinancialSnapshot(Country.CR, 25_000n, {
    orderWebhookProfitMode: DidiOrderWebhookProfitMode.percentage,
    orderWebhookProfitValue: decimal('5'),
    orderWebhookNativeToMxn: null,
    orderWebhookMxnPerUsd: decimal('20'),
  });
  assert.equal(missingRate.profitMode, null);
  assert.equal(missingRate.profitMxn, null);
  assert.equal(missingRate.profitUsd, null);

  const missingAmount = calculateDidiOrderFinancialSnapshot(Country.MX, null, {
    orderWebhookProfitMode: DidiOrderWebhookProfitMode.percentage,
    orderWebhookProfitValue: decimal('5'),
    orderWebhookNativeToMxn: null,
    orderWebhookMxnPerUsd: decimal('20'),
  });
  assert.equal(missingAmount.profitMode, null);
  assert.equal(missingAmount.profitMxn, null);
});

test('minor unit formatting remains exact beyond JavaScript safe integers', () => {
  assert.equal(minorUnitsToMajorString(9_007_199_254_740_993n), '90071992547409.93');
  assert.equal(minorUnitsToMajorString(null), null);
});

test('non-finite configuration returns a null profit snapshot without throwing', () => {
  const infiniteValue = calculateDidiOrderFinancialSnapshot(Country.MX, null, {
    orderWebhookProfitMode: DidiOrderWebhookProfitMode.fixed_mxn,
    orderWebhookProfitValue: decimal('Infinity'),
    orderWebhookNativeToMxn: null,
    orderWebhookMxnPerUsd: decimal('20'),
  });
  assertProfitIsNull(infiniteValue);

  const nanExchangeRate = calculateDidiOrderFinancialSnapshot(Country.CO, 10_000n, {
    orderWebhookProfitMode: DidiOrderWebhookProfitMode.percentage,
    orderWebhookProfitValue: decimal('10'),
    orderWebhookNativeToMxn: decimal('NaN'),
    orderWebhookMxnPerUsd: decimal('20'),
  });
  assertProfitIsNull(nanExchangeRate);
});

test('rounded MXN profit outside DECIMAL(20,4) returns a null profit snapshot', () => {
  const snapshot = calculateDidiOrderFinancialSnapshot(Country.MX, null, {
    orderWebhookProfitMode: DidiOrderWebhookProfitMode.fixed_mxn,
    orderWebhookProfitValue: decimal('9999999999999999.99995'),
    orderWebhookNativeToMxn: null,
    orderWebhookMxnPerUsd: decimal('20'),
  });

  assertProfitIsNull(snapshot);
});

test('rounded USD profit outside DECIMAL(20,4) returns a null profit snapshot', () => {
  const snapshot = calculateDidiOrderFinancialSnapshot(Country.MX, null, {
    orderWebhookProfitMode: DidiOrderWebhookProfitMode.fixed_mxn,
    orderWebhookProfitValue: decimal('999999999999.999999'),
    orderWebhookNativeToMxn: null,
    orderWebhookMxnPerUsd: decimal('0.0000000001'),
  });

  assertProfitIsNull(snapshot);
});

test('extreme percentage calculations degrade to null instead of blocking order processing', () => {
  const snapshot = calculateDidiOrderFinancialSnapshot(
    Country.CO,
    9_223_372_036_854_775_807n,
    {
      orderWebhookProfitMode: DidiOrderWebhookProfitMode.percentage,
      orderWebhookProfitValue: decimal('100'),
      orderWebhookNativeToMxn: decimal('9999999999.9999999999'),
      orderWebhookMxnPerUsd: decimal('20'),
    },
  );

  assert.equal(snapshot.realPayPriceMinor, 9_223_372_036_854_775_807n);
  assert.equal(snapshot.orderCurrency, 'COP');
  assertProfitIsNull(snapshot);
});

test('finance DTO keeps decimal inputs as exact strings', async () => {
  const exact = Object.assign(new UpdateOrderWebhookFinanceDto(), {
    mode: DidiOrderWebhookProfitMode.percentage,
    value: '12.345678',
    nativeToMxnRate: '0.0000000001',
    mxnPerUsdRate: '17.1234567890',
  });
  assert.equal((await validate(exact)).length, 0);

  const lossyNumber = Object.assign(new UpdateOrderWebhookFinanceDto(), {
    mode: DidiOrderWebhookProfitMode.percentage,
    value: 12.345678,
    nativeToMxnRate: 0.0000000001,
    mxnPerUsdRate: 17.123456789,
  });
  assert.ok((await validate(lossyNumber)).length > 0);
});
