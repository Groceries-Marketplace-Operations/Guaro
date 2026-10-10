import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SftpApiController } from './sftp-api.controller';
import { SftpApiService } from './sftp-api.service';
import { SftpApiScheduler } from './sftp-api.scheduler';
import { SftpApiProcessor } from './sftp-api.processor';
import { SftpApiStockLimiter } from './sftp-api-stock-limiter';
@Module({
  imports: [BullModule.registerQueue({ name: 'sftp-api' })],
  controllers: [SftpApiController],
  providers: [SftpApiService, SftpApiScheduler, SftpApiProcessor, SftpApiStockLimiter],
})
export class SftpApiModule {}
