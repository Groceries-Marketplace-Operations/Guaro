import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountRol, Prisma, TaskEstado, TipoEjecucion } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskEngineService } from './task-engine.service';
import { CreateTaskDto } from './dto/create-task.dto';

const TASK_INCLUDE = {
  taskType: { select: { id: true, nombre: true, sectionId: true } },
  brand: { select: { id: true, brandId: true, brandName: true, country: true } },
  createdBy: { select: { id: true, nombre: true, email: true } },
  stepInstances: {
    orderBy: { stepDefinition: { orden: 'asc' as const } },
    include: {
      stepDefinition: { select: { id: true, nombre: true, orden: true, tipoEjecucion: true } },
      asignado: { select: { id: true, nombre: true, email: true } },
    },
  },
  formValues: { include: { formField: { select: { id: true, etiqueta: true, tipo: true } } } },
  taskShops: { include: { shop: { select: { id: true, shopId: true, appShopId: true } } } },
} as const;

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private engine: TaskEngineService,
  ) {}

  // ── Crear tarea ───────────────────────────────────────────────────────────

  async create(dto: CreateTaskDto, createdById: string) {
    const taskType = await this.prisma.taskType.findUnique({
      where: { id: dto.taskTypeId },
      include: { stepDefinitions: { orderBy: { orden: 'asc' } } },
    });
    if (!taskType || taskType.deletedAt) throw new NotFoundException('TaskType no encontrado');

    const isProgramada = !!dto.programadoInicio;
    if (isProgramada && !taskType.programable) {
      throw new BadRequestException('Este TaskType no es programable');
    }

    const task = await this.prisma.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: {
          taskTypeId: dto.taskTypeId,
          brandId: dto.brandId ?? null,
          createdById,
          estado: isProgramada ? TaskEstado.scheduled : TaskEstado.pending,
          programadoInicio: dto.programadoInicio ? new Date(dto.programadoInicio) : null,
          programadoFin: dto.programadoFin ? new Date(dto.programadoFin) : null,
        },
      });

      // StepInstances
      if (taskType.stepDefinitions.length > 0) {
        await tx.stepInstance.createMany({
          data: taskType.stepDefinitions.map((sd) => ({
            taskId: created.id,
            stepDefinitionId: sd.id,
          })),
        });
      }

      // FormValues
      if (dto.formValues?.length) {
        await tx.formValue.createMany({
          data: dto.formValues.map((fv) => ({ taskId: created.id, ...fv })),
        });
      }

      // TaskShops
      if (dto.shopIds?.length) {
        await tx.taskShop.createMany({
          data: dto.shopIds.map((shopId) => ({ taskId: created.id, shopId })),
        });
      }

      return created;
    });

    // Activar primer step si no es programada
    if (!isProgramada && taskType.stepDefinitions.length > 0) {
      const firstStep = await this.prisma.stepInstance.findFirst({
        where: { taskId: task.id },
        include: { stepDefinition: true },
        orderBy: { stepDefinition: { orden: 'asc' } },
      });
      if (firstStep) {
        await this.engine.activateStep(firstStep.id);
        if (firstStep.stepDefinition.tipoEjecucion === TipoEjecucion.automatico) {
          this.engine.emitAutoStep(firstStep.id, firstStep.stepDefinition.handlerId!);
        }
      }
    }

    return this.findOne(task.id);
  }

  // ── Consultas ─────────────────────────────────────────────────────────────

  findAll(roles: AccountRol[], accountId: string, sectionId: string | null) {
    const where: Prisma.TaskWhereInput = { deletedAt: null };

    if (roles.includes(AccountRol.user) && !roles.includes(AccountRol.admin) && !roles.includes(AccountRol.super_admin)) {
      where.createdById = accountId;
    } else if (roles.includes(AccountRol.bpo) && !roles.includes(AccountRol.admin) && !roles.includes(AccountRol.super_admin)) {
      where.stepInstances = { some: { asignadoId: accountId } };
    } else if (roles.includes(AccountRol.admin) && !roles.includes(AccountRol.super_admin)) {
      where.taskType = { sectionId: sectionId ?? undefined };
    }

    return this.prisma.task.findMany({ where, include: TASK_INCLUDE, orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string) {
    const task = await this.prisma.task.findUnique({ where: { id }, include: TASK_INCLUDE });
    if (!task || task.deletedAt) throw new NotFoundException('Tarea no encontrada');
    return task;
  }

  // ── Acciones sobre steps ──────────────────────────────────────────────────

  async completeStep(taskId: string, stepId: string, resultado?: unknown, nota?: string) {
    await this.assertStepOfTask(taskId, stepId);
    await this.engine.completeStep(stepId, resultado, nota);
    return this.findOne(taskId);
  }

  async failStep(taskId: string, stepId: string, motivoFallo: any, nota?: string) {
    await this.assertStepOfTask(taskId, stepId);
    await this.engine.failStep(stepId, motivoFallo, nota);
    return this.findOne(taskId);
  }

  async blockStep(taskId: string, stepId: string, nota?: string) {
    await this.assertStepOfTask(taskId, stepId);
    await this.engine.blockStep(stepId, nota);
    return this.findOne(taskId);
  }

  async retryStep(taskId: string, stepId: string) {
    await this.assertStepOfTask(taskId, stepId);
    await this.engine.retryStep(stepId);
    return this.findOne(taskId);
  }

  private async assertStepOfTask(taskId: string, stepId: string) {
    const step = await this.prisma.stepInstance.findUnique({ where: { id: stepId } });
    if (!step || step.taskId !== taskId) throw new NotFoundException('Step no encontrado en esta tarea');
  }
}
