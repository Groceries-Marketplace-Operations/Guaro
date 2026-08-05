import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { FileIntegrationProcessor } from './file-integration.processor';
import { FileIntegrationScheduler } from './file-integration.scheduler';
import { FileIntegrationsController } from './file-integrations.controller';
import { FileIntegrationsService } from './file-integrations.service';
import { PromotionApiController } from './promotion-api.controller';
import { PromotionApiService } from './promotion-api.service';
import { SftpConnectionService } from './sftp-connection.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'file-integrations' })],
  controllers: [FileIntegrationsController, PromotionApiController],
  providers: [FileIntegrationsService, FileIntegrationProcessor, FileIntegrationScheduler, SftpConnectionService, PromotionApiService],
})
export class FileIntegrationsModule {}
