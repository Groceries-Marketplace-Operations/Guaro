import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SftpApiDto } from './sftp-api.dto';
import { resolveSftpApiApplications } from './sftp-api.credentials';
import { columnIndex, MAPPING_FIELDS, Mode, nextSchedule, regexMatches, Schedule } from './sftp-api.util';

export const RULE_SELECT = {
  id: true, brandId: true, brand: { select: { brandName: true, brandId: true } },
  applicationId: true, sftpApplicationId: true,
  application: { select: { id: true, appName: true, appId: true, country: true, deletedAt: true } },
  sftpApplication: { select: { id: true, name: true, host: true, port: true, username: true, rootPath: true, active: true, deletedAt: true } },
  fileRegex: true, maxFileAgeMinutes: true, delimiter: true,
  hasHeader: true, shopSource: true, shopRegex: true, mapping: true, schedules: true,
  active: true, nextRunAt: true, lastReadAt: true, lastUploadAt: true,
  createdAt: true, updatedAt: true,
} as const;
export const RUN_SELECT = {
  id: true, ruleId: true, mode: true, trigger: true, actorId: true, status: true, error: true,
  filesRead: true, filesSkipped: true, startedAt: true, finishedAt: true, createdAt: true,
  _count: { select: { uploads: true } },
} as const;
export const UPLOAD_SELECT = {
  id: true, runId: true, shopId: true, fileName: true, fileHash: true, endpoint: true,
  itemCount: true, httpStatus: true, taskId: true, status: true, error: true,
  sentAt: true, sentAtMx: true, durationMs: true,
} as const;

@Injectable()
export class SftpApiService {
  constructor(private readonly prisma: PrismaService,
    @InjectQueue('sftp-api') private readonly queue: Queue) {}

  brandOptions(q: string) {
    return this.prisma.brand.findMany({ where: { deletedAt: null, ...(q ? { OR: [
      { brandName: { contains: q, mode: 'insensitive' as const } }, { brandId: { contains: q, mode: 'insensitive' as const } },
    ] } : {}) }, select: { id: true, brandName: true, brandId: true }, orderBy: { brandName: 'asc' }, take: 30 });
  }

  async applicationOptions(brandId: string) {
    const brand = await this.prisma.brand.findFirst({ where: { id: brandId, deletedAt: null }, select: { country: true } });
    if (!brand) throw new BadRequestException('Selecciona una marca del catálogo');
    const [applications, sftpApplications] = await Promise.all([
      this.prisma.application.findMany({ where: { deletedAt: null, country: brand.country },
        select: { id: true, appName: true, appId: true, country: true }, orderBy: { appName: 'asc' } }),
      this.prisma.sftpApplication.findMany({ where: { active: true, deletedAt: null, OR: [{ brandId }, { brandId: null }] },
        select: { id: true, name: true, host: true, port: true, username: true, rootPath: true }, orderBy: { name: 'asc' } }),
    ]);
    return { applications, sftpApplications };
  }

  list() {
    return this.prisma.sftpApiRule.findMany({ where: { brand: { deletedAt: null } }, select: { ...RULE_SELECT,
      runs: { select: RUN_SELECT, orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: { brand: { brandName: 'asc' } } });
  }

  async detail(id: string) {
    const rule = await this.prisma.sftpApiRule.findUnique({ where: { id }, select: RULE_SELECT });
    if (!rule) throw new NotFoundException('Configuración no encontrada');
    return rule;
  }

  async save(dto: SftpApiDto, actorId: string, id?: string) {
    this.validate(dto);
    const existing = id ? await this.prisma.sftpApiRule.findUnique({ where: { id } }) : null;
    if (id && !existing) throw new NotFoundException('Configuración no encontrada');
    if (existing && existing.brandId !== dto.brandId) throw new BadRequestException('La marca de una integración no puede cambiar');
    await resolveSftpApiApplications(this.prisma, dto);
    const data = {
      ...dto,
      schedules: dto.schedules as unknown as Prisma.InputJsonValue,
      mapping: dto.mapping as Prisma.InputJsonValue,
      nextRunAt: dto.active ? nextSchedule(dto.schedules).at : null,
    };
    try {
      return id
        ? await this.prisma.sftpApiRule.update({ where: { id }, data, select: RULE_SELECT })
        : await this.prisma.sftpApiRule.create({ data: { ...data, createdById: actorId }, select: RULE_SELECT });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('Esta marca ya tiene una configuración SFTP to API');
      throw error;
    }
  }

  private validate(dto: SftpApiDto) {
    try {
      // Compile through the same bounded path used to match SFTP filenames.
      regexMatches(dto.fileRegex, []);
      regexMatches(dto.shopRegex, []);
      if (['"', '\r', '\n', '\0'].includes(dto.delimiter)) throw new Error('Separador inválido');
      if (new Set(dto.schedules.map(s => s.time)).size !== dto.schedules.length) throw new Error('No repitas horarios de lectura');
      for (const [field, column] of Object.entries(dto.mapping)) {
        if (!MAPPING_FIELDS.includes(field as typeof MAPPING_FIELDS[number])) throw new Error(`Campo API desconocido: ${field}`);
        if (typeof column !== 'string') throw new Error('El mapeo debe contener letras de columnas');
        if (column) columnIndex(column);
      }
      for (const field of ['app_item_id', 'stock', 'upc', 'item_name', 'price', ...(dto.shopSource === 'column' ? ['app_shop_id'] : [])]) {
        if (!dto.mapping[field]) throw new Error(`Selecciona una columna para ${field}`);
      }
    } catch (error) { throw new BadRequestException((error as Error).message); }
  }

  async run(id: string, mode: Mode, actorId?: string, dueAt?: Date) {
    try {
      const execution = await this.prisma.$transaction(async tx => {
        // Row lock serializes manual starts, scheduled starts, and config snapshots.
        await tx.$queryRaw`SELECT id FROM sftp_api_rule WHERE id = ${id}::uuid FOR UPDATE`;
        const rule = await tx.sftpApiRule.findUnique({ where: { id } });
        if (!rule) throw new NotFoundException('Configuración no encontrada');
        if (dueAt && (!rule.active || rule.nextRunAt?.getTime() !== dueAt.getTime())) return null;
        await resolveSftpApiApplications(tx, rule);
        const busy = await tx.sftpApiRun.count({ where: { ruleId: id, status: { in: ['pending', 'running'] } } });
        if (busy) throw new ConflictException('La marca ya tiene una ejecución pendiente o en curso');
        if (dueAt) await tx.sftpApiRule.update({ where: { id }, data: { nextRunAt: nextSchedule(rule.schedules as Schedule[]).at } });
        return tx.sftpApiRun.create({ data: { ruleId: id, mode, trigger: dueAt ? 'scheduled' : 'manual', actorId,
          snapshot: JSON.parse(JSON.stringify(rule)) as Prisma.InputJsonValue }, select: RUN_SELECT });
      });
      if (!execution) return null;
      // Persist first: the scheduler reconciles this row if Redis is unavailable.
      const queued = await this.enqueue(execution.id).then(() => true).catch(() => false);
      return { ...execution, queued };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('La marca ya tiene una ejecución activa');
      throw error;
    }
  }

  async enqueue(id: string) {
    const previous = await this.queue.getJob(id);
    if (previous) {
      const state = await previous.getState();
      if (state === 'failed' || state === 'completed') await previous.remove();
      else return;
    }
    await this.queue.add('read-and-upload', { runId: id }, { jobId: id, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
  }

  async history(id: string, page: number) {
    await this.detail(id);
    const where = { ruleId: id };
    const [data, total] = await Promise.all([
      this.prisma.sftpApiRun.findMany({ where, select: RUN_SELECT, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 20, take: 20 }),
      this.prisma.sftpApiRun.count({ where }),
    ]);
    return { data, total, page };
  }

  async uploads(runId: string, page: number) {
    if (!await this.prisma.sftpApiRun.findUnique({ where: { id: runId }, select: { id: true } })) throw new NotFoundException();
    const where = { runId };
    const [data, total] = await Promise.all([
      this.prisma.sftpApiUpload.findMany({ where, select: UPLOAD_SELECT, orderBy: { sentAt: 'asc' }, skip: (page - 1) * 20, take: 20 }),
      this.prisma.sftpApiUpload.count({ where }),
    ]);
    return { data, total, page };
  }

  async processedFiles(id: string, page: number, runId?: string) {
    await this.detail(id);
    if (runId && !await this.prisma.sftpApiRun.findFirst({ where: { id: runId, ruleId: id }, select: { id: true } })) throw new NotFoundException('Ejecución no encontrada');
    const where = { ruleId: id, ...(runId ? { runId } : {}) };
    const [data, total] = await Promise.all([
      this.prisma.sftpApiProcessedFile.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 20, take: 20 }),
      this.prisma.sftpApiProcessedFile.count({ where }),
    ]);
    return { data, total, page };
  }

  async forgetProcessedFiles(id: string, fileId?: string, runId?: string) {
    return this.prisma.$transaction(async tx => {
      // Share the run-start lock: deleting a marker must not race a worker.
      await tx.$queryRaw`SELECT id FROM sftp_api_rule WHERE id = ${id}::uuid FOR UPDATE`;
      if (!await tx.sftpApiRule.findUnique({ where: { id }, select: { id: true } })) throw new NotFoundException('Configuración no encontrada');
      if (await tx.sftpApiRun.count({ where: { ruleId: id, status: { in: ['pending', 'running'] } } })) {
        throw new ConflictException('Espera a que termine la ejecución antes de borrar registros de archivos');
      }
      if (runId && !await tx.sftpApiRun.findFirst({ where: { id: runId, ruleId: id }, select: { id: true } })) throw new NotFoundException('Ejecución no encontrada');
      const result = await tx.sftpApiProcessedFile.deleteMany({ where: { ruleId: id, ...(runId ? { runId } : {}), ...(fileId ? { id: fileId } : {}) } });
      if (fileId && !result.count) throw new NotFoundException('Registro de archivo no encontrado');
      return { deleted: result.count };
    });
  }

  async upload(id: string) {
    const result = await this.prisma.sftpApiUpload.findUnique({ where: { id }, select: { ...UPLOAD_SELECT, payload: true, response: true } });
    if (!result) throw new NotFoundException();
    return result;
  }
}
