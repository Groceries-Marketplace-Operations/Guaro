import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { StepMotivoFallo } from '@prisma/client';
import { TaskEngineService } from '../tasks/task-engine.service';

export interface HandlerJobData {
  stepInstanceId: string;
  handlerName: string;
}

// Registro de handlers automáticos: nombre → función
// Agregar nuevos handlers aquí sin tocar el procesador.
type HandlerFn = (data: HandlerJobData) => Promise<unknown>;
const HANDLER_REGISTRY = new Map<string, HandlerFn>();

export function registerHandler(name: string, fn: HandlerFn) {
  HANDLER_REGISTRY.set(name, fn);
}

@Processor('handlers', { concurrency: 5 })
export class HandlerProcessor extends WorkerHost {
  private readonly logger = new Logger(HandlerProcessor.name);

  constructor(private engine: TaskEngineService) {
    super();
  }

  async process(job: Job<HandlerJobData>): Promise<void> {
    const { stepInstanceId, handlerName } = job.data;
    this.logger.log(`Ejecutando handler [${handlerName}] para step ${stepInstanceId}`);

    const fn = HANDLER_REGISTRY.get(handlerName);
    if (!fn) {
      this.logger.error(`Handler desconocido: ${handlerName}`);
      await this.engine.failStep(stepInstanceId, StepMotivoFallo.error_handler, `Handler desconocido: ${handlerName}`);
      return;
    }

    try {
      const resultado = await fn(job.data);
      await this.engine.completeStep(stepInstanceId, resultado);
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Handler [${handlerName}] falló: ${msg}`);
      // BullMQ reintentará según la config; en el último intento failStep
      if (job.attemptsMade >= (job.opts.attempts ?? 1) - 1) {
        await this.engine.failStep(stepInstanceId, StepMotivoFallo.error_handler, msg);
      }
      throw err; // para que BullMQ registre el fallo y reintente
    }
  }
}
