import { Module } from '@nestjs/common';
import { SftpApplicationsController } from './sftp-applications.controller';
import { SftpApplicationsService } from './sftp-applications.service';

@Module({
  controllers: [SftpApplicationsController],
  providers: [SftpApplicationsService],
})
export class SftpApplicationsModule {}
