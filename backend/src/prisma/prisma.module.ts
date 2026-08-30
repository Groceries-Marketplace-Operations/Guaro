import { Global, Module } from '@nestjs/common';
import { OperationalLeaseService } from './operational-lease.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, OperationalLeaseService],
  exports: [PrismaService, OperationalLeaseService],
})
export class PrismaModule {}
