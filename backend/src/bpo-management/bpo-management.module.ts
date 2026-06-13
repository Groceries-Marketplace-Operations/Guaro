import { Module } from '@nestjs/common';
import { BpoManagementController } from './bpo-management.controller';
import { BpoManagementService } from './bpo-management.service';

@Module({
  controllers: [BpoManagementController],
  providers: [BpoManagementService],
})
export class BpoManagementModule {}
