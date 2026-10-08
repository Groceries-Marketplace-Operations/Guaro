import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { Prisma, SftpApiRule } from '@prisma/client';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Writable } from 'node:stream';
import SftpClient = require('ssh2-sftp-client');
import { decrypt, encrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { DIDI_BASE, parseJsonKeepingIds } from '../queue/handlers/didi-food.util';
import { resolveSftpApiApplications } from './sftp-api.credentials';
import { groceryPayload, Item, Mode, mxDate, parseFile, ParseConfig, redact, regexMatches } from './sftp-api.util';

const FULL_ENDPOINT = '/v3/item/item/uploadGrocery';
const STOCK_ENDPOINT = '/v1/item/item/setStock';
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Parsed = { name: string; hash: string; modified: number; stores: Map<string, Map<string, Item>> };

@Injectable()
@Processor('sftp-api', { concurrency: 2 })
export class SftpApiProcessor extends WorkerHost {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) { super(); }

  async process(job: Job<{ runId: string }>) {
    const id = job.data.runId;
    const claimed = await this.prisma.sftpApiRun.updateMany({ where: { id, status: 'pending' }, data: { status: 'running', startedAt: new Date() } });
    if (!claimed.count) {
      const previous = await this.prisma.sftpApiRun.findUnique({ where: { id } });
      if (previous?.status === 'running') await this.review(id, previous.ruleId, 'La ejecución se interrumpió. Revisa los envíos antes de reactivar los horarios.');
      return;
    }
    const run = await this.prisma.sftpApiRun.findUniqueOrThrow({ where: { id } });
    const rule = run.snapshot as unknown as SftpApiRule;
    let secret = '';
    let password = '';
    const safeError = (error: unknown) => {
      let message = error instanceof Error ? error.message : 'Error de integración';
      for (const sensitive of [secret, password]) if (sensitive) message = message.split(sensitive).join('<redacted>');
      return message.replace(/(auth_token|app_secret|password)["'\s:=]+[^\s,;&"']+/gi, '$1=<redacted>').slice(0, 1200);
    };
    const client = new SftpClient(`sftp-api-${id}`);
    let failed = 0;
    let skipped = 0;
    try {
      const { application, sftpApplication } = await resolveSftpApiApplications(this.prisma, rule);
      const rootPath = posix.normalize(sftpApplication.rootPath?.trim() || '/upload');
      if (!rootPath.startsWith('/') || rootPath.includes('\0')) throw new Error('La ruta raíz de la aplicación SFTP debe ser una ruta absoluta válida');
      const key = this.config.getOrThrow<string>('APP_SECRET_ENCRYPTION_KEY');
      secret = decrypt(application.appSecret, key);
      password = decrypt(sftpApplication.password, key);
      await client.connect({ host: sftpApplication.host, port: sftpApplication.port, username: sftpApplication.username, password, readyTimeout: 30_000,
        keepaliveInterval: 10_000, keepaliveCountMax: 3, retries: 0 });
      const entries = (await client.list(rootPath)).filter(e => e.type === '-' && !/[\\/\0]/.test(e.name));
      const matches = regexMatches(rule.fileRegex, entries.map(e => e.name));
      const selectionTime = Date.now();
      const maxAge = (rule.maxFileAgeMinutes ?? 30) * 60_000;
      const eligible = entries.filter((entry, index) => matches[index] && Number.isFinite(entry.modifyTime)
        && selectionTime - entry.modifyTime >= 0 && selectionTime - entry.modifyTime <= maxAge);
      const known = await this.prisma.sftpApiProcessedFile.findMany({
        where: { ruleId: rule.id, fileName: { in: eligible.map(e => e.name) } }, select: { fileName: true },
      });
      const knownNames = new Set(known.map(file => file.fileName));
      const selected = eligible.filter(entry => !knownNames.has(entry.name));
      skipped = eligible.length - selected.length;
      await this.prisma.sftpApiRun.update({ where: { id }, data: { filesSkipped: skipped } });
      if (!selected.length) {
        await this.prisma.sftpApiRule.update({ where: { id: rule.id }, data: { lastReadAt: new Date() } });
        await this.finish(id, 'no_files', 'No hay archivos nuevos que cumplan el regex y la antigüedad configurada.');
        return;
      }
      // Full uses the latest snapshot per store, delta applies files oldest first.
      selected.sort((a, b) => a.modifyTime - b.modifyTime || a.name.localeCompare(b.name));
      if (selected.length > 500 || selected.reduce((sum, f) => sum + f.size, 0) > 100 * 1024 * 1024) {
        throw new Error('La lectura supera 500 archivos o 100 MB. Ajusta el regex o la carpeta.');
      }
      const parsed: Parsed[] = [];
      for (const entry of selected) {
        await this.ensureRunning(id);
        const marker = await this.prisma.sftpApiProcessedFile.createMany({ data: [{ ruleId: rule.id, runId: id, fileName: entry.name,
          modifiedAt: new Date(entry.modifyTime), status: 'processing' }], skipDuplicates: true });
        if (!marker.count) { skipped++; continue; }
        try {
          if (entry.size > MAX_FILE_BYTES) throw new Error(`${entry.name} supera 25 MB`);
          const chunks: Buffer[] = [];
          let bytes = 0;
          const destination = new Writable({ write(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > MAX_FILE_BYTES) callback(new Error('Archivo mayor a 25 MB'));
            else { chunks.push(Buffer.from(chunk)); callback(); }
          } });
          const path = posix.join(rootPath, entry.name);
          await client.get(path, destination);
          const after = await client.stat(path);
          if (after.size !== entry.size || after.modifyTime !== entry.modifyTime || bytes !== entry.size) throw new Error(`${entry.name} cambió durante la lectura`);
          const buffer = Buffer.concat(chunks);
          const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
          const stores = parseFile(content, entry.name, rule as unknown as ParseConfig, run.mode as Mode);
          const fileHash = hash(buffer);
          await this.prisma.sftpApiProcessedFile.update({ where: { ruleId_fileName: { ruleId: rule.id, fileName: entry.name } }, data: { fileHash } });
          await this.prisma.sftpApiRun.update({ where: { id }, data: { filesRead: { increment: 1 } } });
          await this.prisma.sftpApiRule.update({ where: { id: rule.id }, data: { lastReadAt: new Date() } });
          parsed.push({ name: entry.name, hash: fileHash, modified: entry.modifyTime, stores });
        } catch (error) {
          failed++;
          await this.completeFile(rule.id, entry.name, 'failed', safeError(error));
        }
      }
      await client.end().catch(() => undefined);
      // Validate the entire selection before replacing any remote menu.
      const latestByShop = new Map<string, Parsed>();
      for (const file of parsed) for (const shop of file.stores.keys()) latestByShop.set(shop, file);
      const configHash = hash(JSON.stringify({ version: 2, base: DIDI_BASE, appId: application.appId, sftpApplicationId: rule.sftpApplicationId, mode: run.mode, mapping: rule.mapping, shopSource: rule.shopSource, shopRegex: rule.shopRegex }));
      for (const file of parsed) {
        const fileErrors: string[] = [];
        let fileUncertain = false;
        let attempted = false;
        for (const [shop, map] of file.stores) {
          if (run.mode === 'full' && latestByShop.get(shop) !== file) continue;
          await this.ensureRunning(id);
          attempted = true;
          const items = [...map.values()];
          const batches: Item[][] = [];
          if (run.mode === 'full') batches.push(items);
          else for (let offset = 0; offset < items.length; offset += 100) batches.push(items.slice(offset, offset + 100));
          let token: string | undefined;
          for (const batch of batches) {
            await this.ensureRunning(id);
            const batchConfigHash = hash(configHash + JSON.stringify(batch));
            if (!token) {
              try { token = await this.auth(application.appId, secret, shop); }
              catch (error) {
                const message = `Tienda ${shop}: ${safeError(error)}`;
                const sentAt = new Date();
                const payload = { app_id: application.appId, app_shop_id: shop };
                await this.prisma.sftpApiUpload.create({ data: { runId: id, shopId: shop, fileName: file.name, fileHash: file.hash,
                  configHash: batchConfigHash, endpoint: '/v1/auth/authtoken/get', itemCount: 0, payload,
                  encryptedBody: encrypt(JSON.stringify(payload), key), status: 'failed', error: message, sentAt, sentAtMx: mxDate(sentAt) } });
                failed++; fileErrors.push(message);
                break;
              }
            }
            const endpoint = run.mode === 'full' ? FULL_ENDPOINT : STOCK_ENDPOINT;
            const payload = { auth_token: token, ...(run.mode === 'full' ? groceryPayload(shop, batch) : { stock_list: batch }) };
            const body = JSON.stringify(payload);
            const sentAt = new Date();
            // The exact request is encrypted; UI/export receive the same JSON with the token masked.
            const audit = await this.prisma.sftpApiUpload.create({ data: {
              runId: id, shopId: shop, fileName: file.name, fileHash: file.hash, configHash: batchConfigHash, endpoint, itemCount: batch.length,
              payload: redact(payload) as Prisma.InputJsonValue, encryptedBody: encrypt(body, key), sentAt, sentAtMx: mxDate(sentAt),
            } });
            let response: Response;
            let result: Record<string, any>;
            try {
              await this.ensureRunning(id);
              response = await fetch(DIDI_BASE + endpoint, { method: 'POST', signal: AbortSignal.timeout(60_000),
                headers: { 'content-type': 'application/json; charset=utf-8', 'didi-header-sign': createHash('md5').update(body + secret).digest('hex') }, body });
              result = parseJsonKeepingIds(await response.text());
              if (!result || typeof result !== 'object' || typeof result.errno !== 'number') throw new Error('Respuesta API no válida');
            } catch {
              await this.prisma.sftpApiUpload.update({ where: { id: audit.id }, data: { status: 'unknown', error: 'No se pudo confirmar la respuesta; revisa la tienda antes de repetir', durationMs: Date.now() - sentAt.getTime() } });
              failed++; fileUncertain = true;
              fileErrors.push(`Tienda ${shop}: respuesta no confirmada; revisa el reporte antes de reprocesar`);
              break;
            }
            const ok = response.ok && result.errno === 0;
            const taskId = result.data?.taskID ?? result.data?.taskId ?? result.taskID;
            let cleanText = JSON.stringify(redact(result));
            for (const sensitive of [secret, password, token]) if (sensitive) cleanText = cleanText.split(JSON.stringify(sensitive).slice(1, -1)).join('<redacted>');
            const cleanResult = JSON.parse(cleanText) as Prisma.InputJsonValue;
            await this.prisma.sftpApiUpload.update({ where: { id: audit.id }, data: {
              status: ok ? (run.mode === 'full' ? 'accepted' : 'succeeded') : 'failed', httpStatus: response.status,
              response: cleanResult, taskId: taskId == null ? null : String(taskId),
              error: ok ? null : `API errno=${result.errno}; HTTP ${response.status}`, durationMs: Date.now() - sentAt.getTime(),
            } });
            if (ok) await this.prisma.sftpApiRule.update({ where: { id: rule.id }, data: { lastUploadAt: sentAt } });
            else {
              failed++;
              fileErrors.push(`Tienda ${shop}: API errno=${result.errno}; HTTP ${response.status}`);
              break; // Stop only this shop's remaining batches; continue with other stores.
            }
          }
        }
        await this.completeFile(rule.id, file.name, fileUncertain ? 'needs_review' : fileErrors.length ? 'partial_failure' : attempted ? 'processed' : 'superseded', fileErrors.join('\n') || undefined);
      }
      await this.prisma.sftpApiRun.update({ where: { id }, data: { filesSkipped: skipped } });
      await this.finish(id, failed ? 'partial_failure' : run.mode === 'full' ? 'accepted' : 'succeeded', failed ? `${failed} errores de archivo o tienda; las demás tiendas continuaron. Consulta los reportes.` : undefined);
    } catch (error) {
      const uncertain = await this.prisma.sftpApiUpload.count({ where: { runId: id, status: 'sending' } });
      if (uncertain) await this.review(id, rule.id, 'Ejecución interrumpida tras preparar un envío; requiere revisión.');
      else {
        await this.prisma.sftpApiProcessedFile.updateMany({ where: { runId: id, status: 'processing' }, data: { status: 'failed', error: safeError(error), processedAt: new Date() } });
        await this.finish(id, 'failed', safeError(error));
      }
    } finally { await client.end().catch(() => undefined); }
  }

  private async completeFile(ruleId: string, fileName: string, status: string, error?: string) {
    await this.prisma.sftpApiProcessedFile.update({ where: { ruleId_fileName: { ruleId, fileName } }, data: { status, error: error?.slice(0, 12000) ?? null, processedAt: new Date() } });
  }

  private async auth(appId: string, secret: string, shop: string): Promise<string> {
    const url = new URL(DIDI_BASE + '/v1/auth/authtoken/get');
    url.searchParams.set('app_id', appId);
    url.searchParams.set('app_secret', secret);
    url.searchParams.set('app_shop_id', shop);
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const result = parseJsonKeepingIds(await response.text());
    if (!response.ok || result?.errno !== 0 || !result?.data?.auth_token) throw new Error(`Autenticación API rechazada (HTTP ${response.status})`);
    return result.data.auth_token;
  }
  private async ensureRunning(id: string) {
    if (!await this.prisma.sftpApiRun.count({ where: { id, status: 'running' } })) throw new Error('La ejecución ya no está activa');
  }
  private async finish(id: string, status: string, error?: string) {
    await this.prisma.sftpApiRun.updateMany({ where: { id, status: 'running' }, data: { status, error: error ?? null, finishedAt: new Date() } });
  }
  private async review(id: string, ruleId: string, error: string) {
    await this.prisma.$transaction([
      this.prisma.sftpApiUpload.updateMany({ where: { runId: id, status: 'sending' }, data: { status: 'unknown', error } }),
      this.prisma.sftpApiProcessedFile.updateMany({ where: { runId: id, status: 'processing' }, data: { status: 'needs_review', error, processedAt: new Date() } }),
      this.prisma.sftpApiRule.update({ where: { id: ruleId }, data: { active: false, nextRunAt: null } }),
      this.prisma.sftpApiRun.updateMany({ where: { id, status: 'running' }, data: { status: 'needs_review', error, finishedAt: new Date() } }),
    ]);
  }
}
