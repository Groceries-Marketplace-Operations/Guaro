import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { StepFailureReason } from '@prisma/client';
import { TaskEngineService } from '../tasks/task-engine.service';

export interface HandlerJobData {
  stepInstanceId: string;
  handlerName: string;
}

// Registry of automatic handlers: name → function
// Add new handlers here without touching the processor.
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
    this.logger.log(`Running handler [${handlerName}] for step ${stepInstanceId}`);

    const fn = HANDLER_REGISTRY.get(handlerName);
    if (!fn) {
      this.logger.error(`Unknown handler: ${handlerName}`);
      await this.engine.failStep(stepInstanceId, StepFailureReason.error_handler, `Unknown handler: ${handlerName}`);
      return;
    }

    try {
      const result = await fn(job.data);
      await this.engine.completeStep(stepInstanceId, result);
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Handler [${handlerName}] failed: ${msg}`);
      // BullMQ will retry based on config; on last attempt failStep
      if (job.attemptsMade >= (job.opts.attempts ?? 1) - 1) {
        await this.engine.failStep(stepInstanceId, StepFailureReason.error_handler, msg);
      }
      throw err; // so BullMQ records the failure and retries
    }
  }
}
