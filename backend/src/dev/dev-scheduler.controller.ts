import { Controller, Post } from '@nestjs/common';
import { SchedulerService } from '../scheduler/scheduler.service';

/**
 * Dev-only: manually fire the scheduler crons without waiting for the 5-min interval.
 *
 * POST /dev/scheduler/activate   — activates all scheduled tasks whose window has opened
 * POST /dev/scheduler/bpo-timeout — checks for expired manual steps
 * POST /dev/scheduler/auto-timeout — checks for timed-out automatic steps
 */
@Controller('dev/scheduler')
export class DevSchedulerController {
  constructor(private scheduler: SchedulerService) {}

  @Post('activate')
  async activate() {
    await this.scheduler.activateScheduledTasks();
    return { ok: true, ran: 'activateScheduledTasks' };
  }

  @Post('bpo-timeout')
  async bpoTimeout() {
    await this.scheduler.checkBpoTimeouts();
    return { ok: true, ran: 'checkBpoTimeouts' };
  }

  @Post('auto-timeout')
  async autoTimeout() {
    await this.scheduler.checkAutoTimeouts();
    return { ok: true, ran: 'checkAutoTimeouts' };
  }

  @Post('archive')
  async archive() {
    // Pass "now" as cutoff so ALL existing tasks get archived (dev only)
    await this.scheduler.archiveOldTasks(new Date());
    return { ok: true, ran: 'archiveOldTasks' };
  }
}
