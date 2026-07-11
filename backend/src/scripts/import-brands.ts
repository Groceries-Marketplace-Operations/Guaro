/**
 * Bulk brand import from Excel.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/import-brands.ts ./data/brands.xlsx
 *
 * Expected columns (order doesn't matter, matched by header name):
 *   Brand Name | Country | Business Type | Business Category | Brand Id |
 *   Menu Method | Checkout Mode | Picking Mode
 *
 * Skipped columns (no direct field in schema):
 *   BD/KAM | OP | Created | Grocery Mode | item Library |
 *   Num Stores | Stores Link | Logo | Banner
 */

import * as ExcelJS from 'exceljs';
import * as path from 'path';
import {
  PrismaClient,
  Country,
  KaType,
  MenuIntegration,
  PickingMode,
  PaymentMode,
} from '@prisma/client';

const prisma = new PrismaClient();

// ── Enum mappers ──────────────────────────────────────────────────────────────

function mapCountry(raw: string): Country | null {
  const v = raw.trim().toUpperCase();
  const MAP: Record<string, Country> = {
    CO: 'CO', COLOMBIA: 'CO',
    MX: 'MX', MEXICO: 'MX', 'MÉXICO': 'MX',
    CR: 'CR', 'COSTA RICA': 'CR', COSTARICA: 'CR',
  };
  return MAP[v] ?? null;
}

function mapKaType(raw: string): KaType | null {
  const v = raw.trim().toUpperCase();
  const MAP: Record<string, KaType> = {
    KA: 'KA',
    CKA: 'CKA',
    SME: 'SME',
  };
  return MAP[v] ?? null;
}

function mapMenuIntegration(raw: string): MenuIntegration | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]/g, '_');
  const MAP: Record<string, MenuIntegration> = {
    bapp: 'bapp',
    b_app: 'bapp',
    api: 'api',
    sftp: 'sftp',
    api_whitelist: 'api_whitelist',
    whitelist: 'api_whitelist',
    spreadsheets: 'spreadsheets',
    spreadsheet: 'spreadsheets',
    sheets: 'spreadsheets',
  };
  return MAP[v] ?? null;
}

function mapPickingMode(raw: string): PickingMode | null {
  const v = raw.trim().toLowerCase().replace(/[\s\-+&]/g, '_').replace(/_+/g, '_');
  const MAP: Record<string, PickingMode> = {
    // Excel values
    merchant_picking: 'merchant_picking_bapp',
    merchant_picking_bapp: 'merchant_picking_bapp',
    merchant_picking_dapp: 'merchant_picking_dapp',
    '2in1': 'dos_en_uno',
    '2_in_1': 'dos_en_uno',
    dos_en_uno: 'dos_en_uno',
    '1_1': 'merchant_picking_dapp',  // "1+1" = picker + delivery separately
    '1_1___2in1': 'dos_en_uno',       // "1+1 & 2in1" → most permissive mode
    '1_1___2_in_1': 'dos_en_uno',
  };
  return MAP[v] ?? null;
}

function mapPaymentMode(raw: string): PaymentMode | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]/g, '_');
  const MAP: Record<string, PaymentMode> = {
    food_mode: 'food_mode',
    food: 'food_mode',
    prepaid_card: 'prepaid_card',
    prepaid: 'prepaid_card',
    // "DiDi Payless (QR)" → qr_code
    'didi_payless_(qr)': 'qr_code',
    didi_payless: 'qr_code',
    qr_code: 'qr_code',
    qr: 'qr_code',
  };
  return MAP[v] ?? null;
}

// ── Cell helpers ──────────────────────────────────────────────────────────────

function cellStr(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'result' in v) return String((v as ExcelJS.CellFormulaValue).result ?? '');
  return String(v).trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: npx ts-node src/scripts/import-brands.ts <path-to-excel>');
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(filePath));

  const ws = wb.worksheets[0];
  if (!ws) {
    console.error('No worksheet found in file.');
    process.exit(1);
  }

  // Build column index from header row
  const headerRow = ws.getRow(1);
  const colIdx: Record<string, number> = {};
  headerRow.eachCell((cell, colNumber) => {
    const h = cellStr(cell).toLowerCase().trim();
    colIdx[h] = colNumber;
  });

  const get = (row: ExcelJS.Row, header: string) => {
    const idx = colIdx[header.toLowerCase()];
    return idx ? cellStr(row.getCell(idx)) : '';
  };

  console.log('\nDetected columns:', Object.keys(colIdx).join(' | '));
  console.log(`Total rows (excl. header): ${ws.rowCount - 1}\n`);

  // Pre-load all accounts into a map email → id to avoid N+1 queries
  const accounts = await prisma.account.findMany({ select: { id: true, email: true } });
  const accountByEmail = new Map(accounts.map(a => [a.email.toLowerCase(), a.id]));
  console.log(`Loaded ${accounts.length} accounts for OP lookup.\n`);

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const skippedRows: { row: number; reason: string; data: string }[] = [];

  for (let rowNum = 2; rowNum <= ws.rowCount; rowNum++) {
    const row = ws.getRow(rowNum);

    const brandName    = get(row, 'Brand Name');
    const brandIdRaw   = get(row, 'Brand Id');
    const countryRaw   = get(row, 'Country');
    const kaTypeRaw    = get(row, 'Business Type');
    const category     = get(row, 'Business Category') || undefined;
    const opRaw        = get(row, 'OP');
    const menuRaw      = get(row, 'Menu Method');
    const checkoutRaw  = get(row, 'Checkout Mode');
    const pickingRaw   = get(row, 'Picking Mode');

    // Resolve OP → account id (username + @didi-labs.com)
    const opEmail  = opRaw ? `${opRaw.trim().toLowerCase()}@didi-labs.com` : null;
    const ownerId  = opEmail ? (accountByEmail.get(opEmail) ?? null) : null;
    if (opRaw && !ownerId)
      console.warn(`  Row ${rowNum}: OP "${opRaw}" not found in accounts — owner will be null`);

    // Skip completely empty rows
    if (!brandName && !brandIdRaw && !countryRaw) continue;

    // Validate required fields
    if (!brandName) {
      skipped++;
      skippedRows.push({ row: rowNum, reason: 'Missing Brand Name', data: `brandId=${brandIdRaw}` });
      continue;
    }
    if (!brandIdRaw) {
      skipped++;
      skippedRows.push({ row: rowNum, reason: 'Missing Brand Id', data: brandName });
      continue;
    }

    const country = mapCountry(countryRaw);
    if (!country) {
      skipped++;
      skippedRows.push({ row: rowNum, reason: `Unknown country: "${countryRaw}"`, data: brandName });
      continue;
    }

    const kaType = mapKaType(kaTypeRaw);
    if (!kaType) {
      skipped++;
      skippedRows.push({ row: rowNum, reason: `Unknown business type: "${kaTypeRaw}"`, data: brandName });
      continue;
    }

    const menuIntegration = menuRaw  ? mapMenuIntegration(menuRaw)  : null;
    const paymentMode     = checkoutRaw ? mapPaymentMode(checkoutRaw) : null;
    const pickingMode     = pickingRaw  ? mapPickingMode(pickingRaw)  : null;

    // Warn about unmapped optional enums (don't skip, just note)
    if (menuRaw && !menuIntegration)
      console.warn(`  Row ${rowNum}: Unknown menu method "${menuRaw}" for "${brandName}" — will be null`);
    if (checkoutRaw && !paymentMode)
      console.warn(`  Row ${rowNum}: Unknown checkout mode "${checkoutRaw}" for "${brandName}" — will be null`);
    if (pickingRaw && !pickingMode)
      console.warn(`  Row ${rowNum}: Unknown picking mode "${pickingRaw}" for "${brandName}" — will be null`);

    try {
      const existing = await prisma.brand.findUnique({ where: { brandId: brandIdRaw } });

      await prisma.brand.upsert({
        where: { brandId: brandIdRaw },
        create: {
          brandId: brandIdRaw,
          brandName,
          country,
          kaType,
          category: category || null,
          menuIntegration: menuIntegration ?? undefined,
          paymentMode:     paymentMode     ?? undefined,
          pickingMode:     pickingMode     ?? undefined,
          ownerId:         ownerId         ?? undefined,
        },
        update: {
          brandName,
          country,
          kaType,
          category: category || null,
          menuIntegration: menuIntegration ?? undefined,
          paymentMode:     paymentMode     ?? undefined,
          pickingMode:     pickingMode     ?? undefined,
          ownerId:         ownerId         ?? undefined,
        },
      });

      if (existing) {
        updated++;
        console.log(`  ↺ [${rowNum}] Updated:  ${brandName} (${brandIdRaw}) [${country}]`);
      } else {
        imported++;
        console.log(`  ✓ [${rowNum}] Imported: ${brandName} (${brandIdRaw}) [${country}]`);
      }
    } catch (e) {
      skipped++;
      const msg = e instanceof Error ? e.message : String(e);
      skippedRows.push({ row: rowNum, reason: `DB error: ${msg}`, data: brandName });
      console.error(`  ✗ [${rowNum}] Error:    ${brandName} — ${msg}`);
    }
  }

  console.log('\n──────────────────────────────────────');
  console.log(`  Imported (new):   ${imported}`);
  console.log(`  Updated (exist):  ${updated}`);
  console.log(`  Skipped (errors): ${skipped}`);
  console.log('──────────────────────────────────────');

  if (skippedRows.length > 0) {
    console.log('\nSkipped rows:');
    skippedRows.forEach(r => console.log(`  Row ${r.row}: ${r.reason} — ${r.data}`));
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
