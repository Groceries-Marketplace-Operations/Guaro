import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { InvitationsModule } from './invitations/invitations.module';
import { HandlersModule } from './handlers/handlers.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { TaskTypesModule } from './task-types/task-types.module';
import { SectionsModule } from './sections/sections.module';
import { ApplicationsModule } from './applications/applications.module';
import { BrandsModule } from './brands/brands.module';
import { ShopsModule } from './shops/shops.module';
import { TasksModule } from './tasks/tasks.module';
import { QueueModule } from './queue/queue.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { BpoManagementModule } from './bpo-management/bpo-management.module';
import { AccountsModule } from './accounts/accounts.module';
import { AppConfigModule } from './app-config/app-config.module';
import { DevModule } from './dev/dev.module';

const devModules = process.env.NODE_ENV !== 'production' ? [DevModule] : [];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../.env'] }),
    PrismaModule,
    AuthModule,
    InvitationsModule,
    HandlersModule,
    WebhooksModule,
    TaskTypesModule,
    SectionsModule,
    ApplicationsModule,
    BrandsModule,
    ShopsModule,
    TasksModule,
    QueueModule,
    SchedulerModule,
    BpoManagementModule,
    AccountsModule,
    AppConfigModule,
    ...devModules,
  ],
})
export class AppModule {}
