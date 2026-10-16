import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const UPDATE_STORE_LOGO_TASK_TYPE_ID = '1ea33da2-92cd-4ef3-b81e-2fcd764001f1';
export const UPDATE_STORE_LOGO_TASK_TYPE_NAME = 'Update Store Logo';
export const UPDATE_STORE_LOGO_RELEASE_GATE_MARKER = 'GUARO_RELEASE_GATE:update_shop_logo:backend-ready:v1';
export const UPDATE_STORE_LOGO_RELEASE_GATE_DELETED_AT = new Date('2999-01-01T00:00:00.000Z');
export const UPDATE_STORE_LOGO_DESCRIPTION =
  'Upload one secure shop_logo and apply it to selected stores of the chosen brand.';

/**
 * Consumes release-gated TaskTypes after the compatible backend is running.
 *
 * The migration deliberately creates the TaskType as inactive and soft-deleted
 * so the previous backend cannot expose or execute it while a rolling deploy is
 * in progress. The exact marker is consumed in the same conditional update that
 * activates the TaskType. Once consumed, a later admin disable, delete, or edit
 * cannot be undone by a subsequent application restart.
 */
@Injectable()
export class TaskTypeReleaseActivationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TaskTypeReleaseActivationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    const result = await this.prisma.taskType.updateMany({
      where: {
        id: UPDATE_STORE_LOGO_TASK_TYPE_ID,
        name: UPDATE_STORE_LOGO_TASK_TYPE_NAME,
        descripcion: UPDATE_STORE_LOGO_RELEASE_GATE_MARKER,
        schedulable: false,
        active: false,
        deletedAt: UPDATE_STORE_LOGO_RELEASE_GATE_DELETED_AT,
      },
      data: {
        descripcion: UPDATE_STORE_LOGO_DESCRIPTION,
        active: true,
        deletedAt: null,
      },
    });

    if (result.count === 1) {
      this.logger.log(`${UPDATE_STORE_LOGO_TASK_TYPE_NAME} activated for this backend release`);
    }
  }
}
