import { Global, Module } from '@nestjs/common';
import { AccessControlController } from './access-control.controller';
import { AccessControlService } from './access-control.service';
import { PermissionAccessService } from './permission-access.service';

@Global()
@Module({
  controllers: [AccessControlController],
  providers: [AccessControlService, PermissionAccessService],
  exports: [PermissionAccessService],
})
export class AccessControlModule {}
