/**
 * Bulk application import from Excel.
 *
 * Usage:
 *   node dist/scripts/import-applications.js <path-to-excel>
 *
 * Expected columns (order doesn't matter, matched by header name):
 *   Country | Brand | App_Name | App_Id | App_Secret
 *
 * - Looks up brand by name + country to satisfy the composite FK constraint.
 * - App_Secret is encrypted with AES-256-GCM before being stored.
 *   The raw secret is never written to any log or output.
 * - Upserts on App_Id (idempotent re-runs).
 * - After upserting the application, links the brand → application.
 */

import * as ExcelJS from 'exceljs';
import * as path from 'path';
import { PrismaClient, Country } from '@prisma/client';
import { encrypt } from '../common/crypto.util';

const prisma = new PrismaClient();

// ── Country mapper ────────────────────────────────────────────────────────────

function mapCountry(raw: string): Country | null {
  const v = raw.trim().toUpperCase();
  const MAP: Record<string, Country> = {
    CO: 'CO', COLOMBIA: 'CO',
    MX: 'MX', MEXICO: 'MX', 'MÉXICO': 'MX',
    CR: 'CR', 'COSTA RICA': 'CR', COSTARICA: 'CR',
  };
  return MAP[v] ?? null;
}

// ── Cell helper ───────────────────────────────────────────────────────────────

function cellStr(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'result' in v)
    return String((v as ExcelJS.CellFormulaValue).result ?? '');
  return String(v).trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const encKey = process.env.APP_SECRET_ENCRYPTION_KEY;
  if (!encKey) {
    console.error('ERROR: APP_SECRET_ENCRYPTION_KEY env variable is not set.');
    process.exit(1);
  }

  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node dist/scripts/import-applications.js <path-to-excel>');
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
    const h = cellStr(cell).toLowerCase().trim().replace(/\s+/g, '_');
    colIdx[h] = colNumber;
  });

  const get = (row: ExcelJS.Row, header: string) => {
    const key = header.toLowerCase().replace(/\s+/g, '_');
    const idx = colIdx[key];
    return idx ? cellStr(row.getCell(idx)) : '';
  };

  console.log('\nDetected columns:', Object.keys(colIdx).join(' | '));
  console.log(`Total rows (excl. header): ${ws.rowCount - 1}\n`);

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const skippedRows: { row: number; reason: string; data: string }[] = [];

  for (let rowNum = 2; rowNum <= ws.rowCount; rowNum++) {
    const row = ws.getRow(rowNum);

    const countryRaw = get(row, 'country');
    const brandRaw   = get(row, 'brand');
    const appName    = get(row, 'app_name');
    const appId      = get(row, 'app_id');
    const appSecret  = get(row, 'app_secret');

    // Skip completely empty rows
    if (!countryRaw && !brandRaw && !appId) continue;

    // Validate required fields
    if (!appId) {
      skipped++;
      skippedRows.push({ row: rowNum, reason: 'Missing App_Id', data: brandRaw || '(no brand)' });
      continue;
    }
    if (!appName) {
      skipped++;
      skippedRows.push({ row: rowNum, reason: 'Missing App_Name', data: appId });
      continue;
    }
    if (!appSecret) {
      skipped++;
      skippedRows.push({ row: rowNum, reason: 'Missing App_Secret', data: appId });
      continue;
    }

    const country = mapCountry(countryRaw);
    if (!country) {
      skipped++;
      skippedRows.push({ row: rowNum, reason: `Unknown country: "${countryRaw}"`, data: appId });
      continue;
    }

    // Look up brand by name + country (composite FK requires same country)
    const brand = await prisma.brand.findFirst({
      where: {
        brandName: { equals: brandRaw, mode: 'insensitive' },
        country,
        deletedAt: null,
      },
      select: { id: true, brandName: true, country: true },
    });

    if (!brand) {
      skipped++;
      skippedRows.push({
        row: rowNum,
        reason: `Brand not found: "${brandRaw}" [${country}]`,
        data: appId,
      });
      continue;
    }

    // Encrypt secret — never log the plaintext
    const encryptedSecret = encrypt(appSecret, encKey);

    try {
      const existing = await prisma.application.findUnique({ where: { appId } });

      const app = await prisma.application.upsert({
        where: { appId },
        create: {
          appId,
          appName,
          country,
          appSecret: encryptedSecret,
        },
        update: {
          appName,
          country,
          appSecret: encryptedSecret,
        },
        select: { id: true },
      });

      // Link brand → application
      await prisma.brand.update({
        where: { id: brand.id },
        data: { applicationId: app.id },
      });

      if (existing) {
        updated++;
        console.log(`  ↺ [${rowNum}] Updated:  ${appName} (${appId}) → ${brand.brandName} [${country}]`);
      } else {
        imported++;
        console.log(`  ✓ [${rowNum}] Imported: ${appName} (${appId}) → ${brand.brandName} [${country}]`);
      }
    } catch (e) {
      skipped++;
      const msg = e instanceof Error ? e.message : String(e);
      skippedRows.push({ row: rowNum, reason: `DB error: ${msg}`, data: appId });
      console.error(`  ✗ [${rowNum}] Error:    ${appId} — ${msg}`);
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
