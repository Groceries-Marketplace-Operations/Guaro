import {
  Country,
  DidiOrderWebhookProfitMode,
  Prisma,
} from '@prisma/client';

export const ORDER_CURRENCY_BY_COUNTRY: Record<Country, 'MXN' | 'COP' | 'CRC'> = {
  [Country.MX]: 'MXN',
  [Country.CO]: 'COP',
  [Country.CR]: 'CRC',
};

export interface DidiOrderWebhookProfitConfig {
  orderWebhookProfitMode: DidiOrderWebhookProfitMode | null;
  orderWebhookProfitValue: Prisma.Decimal | null;
  orderWebhookNativeToMxn: Prisma.Decimal | null;
  orderWebhookMxnPerUsd: Prisma.Decimal | null;
}

export interface DidiOrderFinancialSnapshot {
  realPayPriceMinor: bigint | null;
  orderCurrency: 'MXN' | 'COP' | 'CRC';
  profitMode: DidiOrderWebhookProfitMode | null;
  profitValue: Prisma.Decimal | null;
  nativeToMxnRate: Prisma.Decimal | null;
  mxnPerUsdRate: Prisma.Decimal | null;
  profitMxn: Prisma.Decimal | null;
  profitUsd: Prisma.Decimal | null;
}

const MAX_DECIMAL_20_4 = new Prisma.Decimal('9999999999999999.9999');

function isFinitePositive(value: Prisma.Decimal | null): value is Prisma.Decimal {
  return value !== null && value.isFinite() && value.gt(0);
}

function fitsDecimal20Scale4(value: Prisma.Decimal) {
  return value.isFinite() && value.abs().lte(MAX_DECIMAL_20_4);
}

/**
 * Calculates an auditable estimate from an explicit application-level rule.
 * No commission or FX default is assumed. MXN->MXN is the only identity rate.
 */
export function calculateDidiOrderFinancialSnapshot(
  country: Country,
  realPayPriceMinor: bigint | null,
  config: DidiOrderWebhookProfitConfig,
): DidiOrderFinancialSnapshot {
  const orderCurrency = ORDER_CURRENCY_BY_COUNTRY[country];
  const empty = {
    realPayPriceMinor,
    orderCurrency,
    profitMode: null,
    profitValue: null,
    nativeToMxnRate: null,
    mxnPerUsdRate: null,
    profitMxn: null,
    profitUsd: null,
  } satisfies DidiOrderFinancialSnapshot;

  try {
    const mode = config.orderWebhookProfitMode;
    const value = config.orderWebhookProfitValue;
    const mxnPerUsd = config.orderWebhookMxnPerUsd;
    if (!mode || !isFinitePositive(value) || !isFinitePositive(mxnPerUsd)) {
      return empty;
    }

    let nativeToMxn: Prisma.Decimal | null = null;
    let profitMxn: Prisma.Decimal;
    if (mode === DidiOrderWebhookProfitMode.fixed_mxn) {
      profitMxn = value;
    } else {
      if (realPayPriceMinor === null) return empty;
      nativeToMxn = country === Country.MX
        ? new Prisma.Decimal(1)
        : config.orderWebhookNativeToMxn;
      if (!isFinitePositive(nativeToMxn)) return empty;
      const orderAmount = new Prisma.Decimal(realPayPriceMinor.toString()).div(100);
      profitMxn = orderAmount.mul(value).div(100).mul(nativeToMxn);
    }

    const roundedMxn = profitMxn.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    if (!fitsDecimal20Scale4(roundedMxn)) return empty;

    const roundedUsd = roundedMxn
      .div(mxnPerUsd)
      .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    if (!fitsDecimal20Scale4(roundedUsd)) return empty;

    return {
      realPayPriceMinor,
      orderCurrency,
      profitMode: mode,
      profitValue: value,
      nativeToMxnRate: nativeToMxn,
      mxnPerUsdRate: mxnPerUsd,
      profitMxn: roundedMxn,
      profitUsd: roundedUsd,
    };
  } catch {
    return empty;
  }
}

export function decimalString(value: Prisma.Decimal | null | undefined) {
  return value?.toString() ?? null;
}

export function minorUnitsToMajorString(value: bigint | null | undefined) {
  if (value === null || value === undefined) return null;
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const cents = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${cents}`;
}
