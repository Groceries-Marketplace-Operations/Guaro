import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AutoTurnOffCoordinator } from './auto-turn-off.processor';

abstract class CountryCoordinatorProcessor extends WorkerHost {
  constructor(protected readonly coordinator: AutoTurnOffCoordinator) { super(); }

  process(job: Job<{ executionId: string }>) {
    return this.coordinator.process(job.data.executionId);
  }

  async handleFailure(job: Job<{ executionId: string }> | undefined, error: Error) {
    if (job?.data.executionId) await this.coordinator.failExecution(job.data.executionId, error.message);
  }
}

@Processor('auto-turn-off-MX', { concurrency: 1 })
export class AutoTurnOffMexicoProcessor extends CountryCoordinatorProcessor {
  constructor(coordinator: AutoTurnOffCoordinator) { super(coordinator); }

  @OnWorkerEvent('failed')
  failed(job: Job<{ executionId: string }> | undefined, error: Error) { return this.handleFailure(job, error); }
}

@Processor('auto-turn-off-CO', { concurrency: 1 })
export class AutoTurnOffColombiaProcessor extends CountryCoordinatorProcessor {
  constructor(coordinator: AutoTurnOffCoordinator) { super(coordinator); }

  @OnWorkerEvent('failed')
  failed(job: Job<{ executionId: string }> | undefined, error: Error) { return this.handleFailure(job, error); }
}

@Processor('auto-turn-off-CR', { concurrency: 1 })
export class AutoTurnOffCostaRicaProcessor extends CountryCoordinatorProcessor {
  constructor(coordinator: AutoTurnOffCoordinator) { super(coordinator); }

  @OnWorkerEvent('failed')
  failed(job: Job<{ executionId: string }> | undefined, error: Error) { return this.handleFailure(job, error); }
}
