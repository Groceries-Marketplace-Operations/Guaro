import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'handlers' }),
    BullModule.registerQueue({ name: 'forced-open' }),
    PrismaModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
