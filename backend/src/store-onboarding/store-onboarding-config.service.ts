import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  KaType,
  Prisma,
  StoreOnboardingDeliveryStatus,
  StoreOnboardingNotificationFrequency,
  StoreOnboardingOutboxStatus,
  StoreOnboardingSource,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { isUUID } from 'class-validator';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import {
  PutStoreOnboardingNotificationProfileDto,
  PutStoreOnboardingRolloutDto,
  UpdateStoreOnboardingControlDto,
} from './dto/store-onboarding-config.dto';
import {
  notificationTemplateValidationErrors,
  STORE_ONBOARDING_DEFAULT_TEMPLATE_EVENT,
  STORE_ONBOARDING_NOTIFICATION_EVENT_TYPES,
  STORE_ONBOARDING_NOTIFICATION_TEMPLATE_VARIABLES,
} from './store-onboarding-notification-contract';

const CONTROL_ID = 'default';
const WORKFLOW_VERSION_BY_KA_TYPE: Record<KaType, string> = {
  [KaType.KA]: 'ka-v1',
  [KaType.CKA]: 'cka-v1',
  [KaType.SME]: 'sme-v1',
};

export const STORE_ONBOARDING_OPERATIONAL_READY = true;

@Injectable()
export class StoreOnboardingConfigService {
  private readonly logger = new Logger(StoreOnboardingConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  async status() {
    const [control, activationReadiness] = await Promise.all([
      this.readControlFailClosed(),
      this.activationReadiness(this.prisma),
    ]);
    return { ...this.statusPayload(control), activationReadiness };
  }

  async config() {
    const [control, rolloutDrafts, notificationProfileDrafts, activationReadiness, controlHistory] = await Promise.all([
      this.readControlFailClosed(),
      this.prisma.storeOnboardingRolloutRevision.count({ where: { enabled: false } }),
      this.prisma.storeOnboardingNotificationProfile.count({ where: { enabled: false } }),
      this.activationReadiness(this.prisma),
      this.prisma.storeOnboardingControlRevision.findMany({
        where: { controlId: CONTROL_ID },
        include: { actor: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    return {
      ...this.statusPayload(control),
      rolloutDrafts,
      notificationProfileDrafts,
      activationReadiness,
      controlHistory,
      control: control ? {
        id: control.id,
        globalEnabled: control.globalEnabled,
        notificationsEnabled: control.notificationsEnabled,
        updatedById: control.updatedById,
        createdAt: control.createdAt,
        updatedAt: control.updatedAt,
      } : null,
    };
  }

  async updateControl(dto: UpdateStoreOnboardingControlDto, user: JwtUser) {
    if (dto.notificationsEnabled && !dto.globalEnabled) {
      throw new BadRequestException('Store Onboarding notifications cannot be enabled while the master switch is OFF');
    }
    if ((dto.globalEnabled || dto.notificationsEnabled) && dto.activationConfirmed !== true) {
      throw new ConflictException({
        statusCode: 409,
        message: 'Enabling Store Onboarding requires activationConfirmed=true',
        operationalReady: STORE_ONBOARDING_OPERATIONAL_READY,
        activationAllowed: true,
      });
    }

    const control = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('store-onboarding-control'))`;
      const previous = await tx.storeOnboardingControl.findUnique({ where: { id: CONTROL_ID } });
      const now = new Date();
      if (dto.globalEnabled) {
        const readiness = await this.activationReadiness(tx, now);
        if (!readiness.ready) {
          throw new BadRequestException(
            readiness.reasons.join('; '),
          );
        }
      }
      const row = await tx.storeOnboardingControl.upsert({
        where: { id: CONTROL_ID },
        create: {
          id: CONTROL_ID,
          globalEnabled: dto.globalEnabled,
          notificationsEnabled: dto.notificationsEnabled,
          globalEnabledAt: dto.globalEnabled ? now : null,
          notificationsEnabledAt: dto.notificationsEnabled ? now : null,
          activationConfirmedAt: dto.activationConfirmed ? now : null,
          updatedById: user.id,
        },
        update: {
          globalEnabled: dto.globalEnabled,
          notificationsEnabled: dto.notificationsEnabled,
          globalEnabledAt: dto.globalEnabled
            ? (previous?.globalEnabled ? previous.globalEnabledAt : now)
            : null,
          notificationsEnabledAt: dto.notificationsEnabled
            ? (previous?.notificationsEnabled ? previous.notificationsEnabledAt : now)
            : null,
          activationConfirmedAt: dto.activationConfirmed
            ? now
            : previous?.activationConfirmedAt,
          updatedById: user.id,
        },
      });
      const beforeGlobalEnabled = previous?.globalEnabled ?? false;
      const beforeNotificationsEnabled = previous?.notificationsEnabled ?? false;
      if (
        beforeGlobalEnabled !== row.globalEnabled
        || beforeNotificationsEnabled !== row.notificationsEnabled
      ) {
        await tx.storeOnboardingControlRevision.create({
          data: {
            controlId: row.id,
            beforeGlobalEnabled,
            afterGlobalEnabled: row.globalEnabled,
            beforeNotificationsEnabled,
            afterNotificationsEnabled: row.notificationsEnabled,
            activationConfirmed: dto.activationConfirmed === true,
            actorId: user.id,
            reason: dto.reason?.trim() || null,
          },
        });
      }
      if (!row.globalEnabled || !row.notificationsEnabled) {
        await tx.storeOnboardingOutboxEvent.updateMany({
          where: { status: { in: [StoreOnboardingOutboxStatus.pending, StoreOnboardingOutboxStatus.processing] } },
          data: {
            status: StoreOnboardingOutboxStatus.suppressed,
            lastError: 'Notifications disabled before dispatch',
            processingStartedAt: null,
          },
        });
        await tx.storeOnboardingNotificationDelivery.updateMany({
          where: {
            status: {
              in: [
                StoreOnboardingDeliveryStatus.pending,
                StoreOnboardingDeliveryStatus.processing,
                StoreOnboardingDeliveryStatus.retry_wait,
              ],
            },
          },
          data: {
            status: StoreOnboardingDeliveryStatus.suppressed,
            lastError: 'Notifications disabled before delivery',
            processingStartedAt: null,
          },
        });
      }
      return row;
    });

    return {
      ...this.statusPayload(control),
      control,
    };
  }

  async listRollouts() {
    const [data, taskTypeOptions] = await Promise.all([
      this.prisma.storeOnboardingRolloutRevision.findMany({
        include: {
          sourceTaskTypes: {
            include: {
              taskType: {
                select: { id: true, name: true, active: true, deletedAt: true },
              },
            },
            orderBy: { source: 'asc' },
          },
          brandTaskType: {
            select: { id: true, name: true, active: true, deletedAt: true },
          },
          notificationProfile: {
            select: { id: true, logicalKey: true, revision: true, name: true, enabled: true },
          },
        },
        orderBy: [
          { country: 'asc' },
          { kaType: 'asc' },
          { revision: 'desc' },
        ],
      }),
      this.prisma.taskType.findMany({
        where: { active: true, deletedAt: null },
        select: {
          id: true,
          name: true,
          section: { select: { id: true, name: true } },
        },
        orderBy: [{ section: { order: 'asc' } }, { order: 'asc' }, { name: 'asc' }],
      }),
    ]);

    const now = new Date();
    const runtimeByScope = new Map<string, (typeof data)[number]>();
    const latestPublishedByScope = new Map<string, (typeof data)[number]>();
    for (const rollout of data) {
      const key = `${rollout.country}:${rollout.kaType}`;
      if (rollout.activatedAt && rollout.activatedAt <= now && !latestPublishedByScope.has(key)) {
        latestPublishedByScope.set(key, rollout);
      }
      if (!rollout.activatedAt || rollout.activatedAt > now || rollout.effectiveAt > now) continue;
      const current = runtimeByScope.get(key);
      if (
        !current
        || rollout.effectiveAt > current.effectiveAt
        || (rollout.effectiveAt.getTime() === current.effectiveAt.getTime() && rollout.revision > current.revision)
      ) runtimeByScope.set(key, rollout);
    }

    return {
      operationalReady: STORE_ONBOARDING_OPERATIONAL_READY,
      activationAllowed: true,
      data: data.map(rollout => {
        const scopeKey = `${rollout.country}:${rollout.kaType}`;
        const runtime = runtimeByScope.get(scopeKey);
        const latestPublished = latestPublishedByScope.get(scopeKey);
        const pendingActivation = Boolean(
          latestPublished?.enabled
          && latestPublished.effectiveAt > now,
        );
        return this.flattenRollout({
          ...rollout,
          published: rollout.activatedAt !== null,
          publishedAt: rollout.activatedAt,
          isRuntimeRevision: runtime?.id === rollout.id,
          runtimeRevisionId: runtime?.id ?? null,
          runtimeEnabled: runtime?.enabled ?? false,
          pendingActivation,
          pendingActivationRevisionId: pendingActivation ? latestPublished?.id ?? null : null,
          pendingActivationEffectiveAt: pendingActivation ? latestPublished?.effectiveAt ?? null : null,
        });
      }),
      taskTypeOptions,
    };
  }

  async putRollout(dto: PutStoreOnboardingRolloutDto, user: JwtUser) {
    this.assertActivationConfirmed(dto.enabled, dto.activationConfirmed, 'Store Onboarding rollout');
    this.validateTimezone(dto.timezone ?? 'America/Mexico_City');
    const expectedWorkflowVersion = WORKFLOW_VERSION_BY_KA_TYPE[dto.kaType];
    if (dto.workflowVersion.trim() !== expectedWorkflowVersion) {
      throw new BadRequestException(`Unsupported workflowVersion for ${dto.kaType}; expected ${expectedWorkflowVersion}`);
    }
    if (!dto.newRequestsOnly) {
      throw new BadRequestException('Store Onboarding rollouts must apply only to Tasks created after activation');
    }

    const sourceTaskTypes = this.normalizeSourceTaskTypes(dto);
    const sourceNames = sourceTaskTypes.map(item => item.source);
    this.assertSupportedSources(sourceNames);
    const malformedTaskTypeIds = sourceTaskTypes
      .filter(item => !isUUID(item.taskTypeId))
      .map(item => item.source);
    if (malformedTaskTypeIds.length) {
      throw new BadRequestException(`Task Type mapping must be a UUID for: ${malformedTaskTypeIds.join(', ')}`);
    }
    if (new Set(sourceNames).size !== sourceNames.length) {
      throw new BadRequestException('Each Store Onboarding source can be mapped only once');
    }
    const sourceTaskTypeIds = sourceTaskTypes.map(item => item.taskTypeId);
    if (new Set(sourceTaskTypeIds).size !== sourceTaskTypeIds.length) {
      throw new BadRequestException('Each source must map to a different Task Type');
    }
    if (dto.brandTaskTypeId && sourceTaskTypeIds.includes(dto.brandTaskTypeId)) {
      throw new BadRequestException('The Brand Task Type cannot also be a Create/Duplicate source Task Type');
    }

    const requestedTaskTypeIds = [...new Set([
      ...sourceTaskTypeIds,
      ...(dto.brandTaskTypeId ? [dto.brandTaskTypeId] : []),
    ])];
    const taskTypes = await this.prisma.taskType.findMany({
      where: { id: { in: requestedTaskTypeIds }, active: true, deletedAt: null },
      select: { id: true },
    });
    const foundTaskTypeIds = new Set(taskTypes.map(item => item.id));
    const missingTaskTypeIds = requestedTaskTypeIds.filter(id => !foundTaskTypeIds.has(id));
    if (missingTaskTypeIds.length) {
      throw new BadRequestException(`Unknown or inactive Task Type: ${missingTaskTypeIds.join(', ')}`);
    }

    if (dto.enabled && !dto.notificationProfileId) {
      throw new BadRequestException('An enabled rollout requires a published notification profile');
    }
    if (dto.notificationProfileId) {
      const profile = await this.prisma.storeOnboardingNotificationProfile.findUnique({
        where: { id: dto.notificationProfileId },
        select: { id: true, logicalKey: true },
      });
      if (!profile) throw new BadRequestException('Notification profile draft not found');
      if (dto.enabled) {
        const runtimeProfile = await this.prisma.storeOnboardingNotificationProfile.findFirst({
          where: { logicalKey: profile.logicalKey, activatedAt: { not: null, lte: new Date() } },
          orderBy: { revision: 'desc' },
        });
        if (!runtimeProfile?.enabled) {
          throw new BadRequestException('An enabled rollout requires an enabled published notification profile');
        }
        if (runtimeProfile.country && runtimeProfile.country !== dto.country) {
          throw new BadRequestException('Notification profile country is incompatible with the rollout');
        }
        if (runtimeProfile.kaType && runtimeProfile.kaType !== dto.kaType) {
          throw new BadRequestException('Notification profile KA type is incompatible with the rollout');
        }
        const unsupportedSources = sourceNames.filter(source => !runtimeProfile.sources.includes(source));
        if (unsupportedSources.length) {
          throw new BadRequestException(`Notification profile does not cover sources: ${unsupportedSources.join(', ')}`);
        }
      }
    }

    try {
      const rollout = await this.prisma.$transaction(async tx => {
        if (dto.activationConfirmed === true) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('store-onboarding-control'))`;
          const activeTaskTypes = await tx.taskType.findMany({
            where: { id: { in: requestedTaskTypeIds }, active: true, deletedAt: null },
            select: { id: true },
          });
          if (activeTaskTypes.length !== requestedTaskTypeIds.length) {
            throw new BadRequestException('A mapped Task Type became inactive before rollout publication');
          }
          if (dto.enabled) {
            const linkedProfile = dto.notificationProfileId
              ? await tx.storeOnboardingNotificationProfile.findUnique({
                where: { id: dto.notificationProfileId },
                select: { logicalKey: true },
              })
              : null;
            if (!linkedProfile) {
              throw new BadRequestException('An enabled rollout requires a published notification profile');
            }
            const runtimeProfile = await tx.storeOnboardingNotificationProfile.findFirst({
              where: {
                logicalKey: linkedProfile.logicalKey,
                activatedAt: { not: null, lte: new Date() },
              },
              orderBy: { revision: 'desc' },
            });
            if (!runtimeProfile?.enabled) {
              throw new BadRequestException('An enabled rollout requires an enabled published notification profile');
            }
            if (runtimeProfile.country && runtimeProfile.country !== dto.country) {
              throw new BadRequestException('Notification profile country is incompatible with the rollout');
            }
            if (runtimeProfile.kaType && runtimeProfile.kaType !== dto.kaType) {
              throw new BadRequestException('Notification profile KA type is incompatible with the rollout');
            }
            const unsupportedSources = sourceNames.filter(source => !runtimeProfile.sources.includes(source));
            if (unsupportedSources.length) {
              throw new BadRequestException(`Notification profile does not cover sources: ${unsupportedSources.join(', ')}`);
            }
          }
        }
        const latest = await tx.storeOnboardingRolloutRevision.findFirst({
          where: { country: dto.country, kaType: dto.kaType },
          select: { revision: true, effectiveAt: true },
          orderBy: { revision: 'desc' },
        });

        const effectiveAt = new Date(dto.effectiveAt);
        const latestPublished = dto.activationConfirmed === true && dto.enabled === false && latest
          ? await tx.storeOnboardingRolloutRevision.findFirst({
            where: {
              country: dto.country,
              kaType: dto.kaType,
              activatedAt: { not: null, lte: new Date() },
            },
            select: { revision: true, enabled: true, effectiveAt: true },
            orderBy: { revision: 'desc' },
          })
          : null;
        const cancelsFutureActivationExactly = Boolean(
          dto.activationConfirmed === true
          && dto.enabled === false
          && latestPublished?.enabled === true
          && latestPublished.effectiveAt.getTime() > Date.now()
          && effectiveAt.getTime() === latestPublished.effectiveAt.getTime(),
        );
        if (
          latest
          && effectiveAt.getTime() <= latest.effectiveAt.getTime()
          && !cancelsFutureActivationExactly
        ) {
          throw new ConflictException('effectiveAt must be later than the previous rollout revision');
        }
        return tx.storeOnboardingRolloutRevision.create({
          data: {
            country: dto.country,
            kaType: dto.kaType,
            revision: (latest?.revision ?? 0) + 1,
            enabled: dto.enabled,
            effectiveAt,
            workflowVersion: dto.workflowVersion,
            newRequestsOnly: true,
            timezone: dto.timezone ?? 'America/Mexico_City',
            notificationProfileId: dto.notificationProfileId ?? null,
            brandTaskTypeId: dto.brandTaskTypeId ?? null,
            activatedAt: dto.activationConfirmed === true ? new Date() : null,
            createdById: user.id,
            sourceTaskTypes: {
              create: sourceTaskTypes.map(item => ({
                source: item.source,
                taskTypeId: item.taskTypeId,
              })),
            },
          },
          include: {
            sourceTaskTypes: {
              include: { taskType: { select: { id: true, name: true } } },
              orderBy: { source: 'asc' },
            },
            brandTaskType: { select: { id: true, name: true } },
            notificationProfile: {
              select: { id: true, logicalKey: true, revision: true, name: true, enabled: true },
            },
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return this.flattenRollout(rollout);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) {
        throw new ConflictException('The rollout draft changed concurrently; reload and save again');
      }
      throw error;
    }
  }

  async listNotificationProfiles() {
    const [profiles, webhookOptions] = await Promise.all([
      this.prisma.storeOnboardingNotificationProfile.findMany({
        include: {
          webhook: { select: { id: true, name: true } },
          templates: { orderBy: { eventType: 'asc' } },
        },
        orderBy: [{ logicalKey: 'asc' }, { revision: 'desc' }],
      }),
      // Never return the URL: this endpoint exists specifically so the UI does
      // not need access to the secret-bearing webhook administration payload.
      this.prisma.webhook.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const now = new Date();
    const runtimeByLogicalKey = new Map<string, (typeof profiles)[number]>();
    for (const profile of profiles) {
      if (!profile.activatedAt || profile.activatedAt > now) continue;
      const current = runtimeByLogicalKey.get(profile.logicalKey);
      if (!current || profile.revision > current.revision) {
        runtimeByLogicalKey.set(profile.logicalKey, profile);
      }
    }

    return {
      operationalReady: STORE_ONBOARDING_OPERATIONAL_READY,
      activationAllowed: true,
      allowedVariables: [...STORE_ONBOARDING_NOTIFICATION_TEMPLATE_VARIABLES],
      data: profiles.map(profile => {
        const runtime = runtimeByLogicalKey.get(profile.logicalKey);
        return this.flattenProfile({
          ...profile,
          published: profile.activatedAt !== null,
          publishedAt: profile.activatedAt,
          isRuntimeRevision: runtime?.id === profile.id,
          runtimeRevisionId: runtime?.id ?? null,
          runtimeEnabled: runtime?.enabled ?? false,
        });
      }),
      webhookOptions,
    };
  }

  async putNotificationProfile(dto: PutStoreOnboardingNotificationProfileDto, user: JwtUser) {
    this.assertActivationConfirmed(dto.enabled, dto.activationConfirmed, 'Store Onboarding notification profile');
    this.validateFrequency(dto);
    this.validateTimezone(dto.timezone);

    const sources = [...new Set(dto.sources)];
    this.assertSupportedSources(sources);
    if (sources.length !== dto.sources.length) {
      throw new BadRequestException('Notification profile sources cannot be duplicated');
    }
    const profileName = dto.name.trim();
    if (!profileName) throw new BadRequestException('Notification profile name is required');
    const criticalEvents = [...new Set(dto.criticalEvents)];
    const unsupportedCriticalEvents = criticalEvents.filter(event => (
      !(STORE_ONBOARDING_NOTIFICATION_EVENT_TYPES as readonly string[]).includes(event)
    ));
    if (unsupportedCriticalEvents.length) {
      throw new BadRequestException(`Unsupported critical event: ${unsupportedCriticalEvents.join(', ')}`);
    }

    const templateErrors = notificationTemplateValidationErrors([{
      eventType: STORE_ONBOARDING_DEFAULT_TEMPLATE_EVENT,
      content: dto.template,
    }]);
    if (templateErrors.length) throw new BadRequestException(templateErrors);

    const webhook = await this.prisma.webhook.findUnique({
      where: { id: dto.webhookId },
      select: { id: true },
    });
    if (!webhook) throw new BadRequestException('Webhook not found');

    let logicalKey = dto.logicalKey;
    if (dto.id) {
      const previous = await this.prisma.storeOnboardingNotificationProfile.findUnique({
        where: { id: dto.id },
        select: { logicalKey: true },
      });
      if (!previous) throw new NotFoundException('Notification profile draft not found');
      if (logicalKey && logicalKey !== previous.logicalKey) {
        throw new BadRequestException('logicalKey cannot change between profile revisions');
      }
      logicalKey = previous.logicalKey;
    }
    logicalKey ??= `profile-${randomUUID()}`;

    try {
      const profile = await this.prisma.$transaction(async tx => {
        if (dto.activationConfirmed === true) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('store-onboarding-control'))`;
        }
        const latest = await tx.storeOnboardingNotificationProfile.findFirst({
          where: { logicalKey },
          select: { revision: true },
          orderBy: { revision: 'desc' },
        });
        return tx.storeOnboardingNotificationProfile.create({
          data: {
            logicalKey,
            revision: (latest?.revision ?? 0) + 1,
            name: profileName,
            country: dto.country ?? null,
            kaType: dto.kaType ?? null,
            sources,
            webhookId: dto.webhookId,
            enabled: dto.enabled,
            frequency: dto.frequency,
            intervalMinutes: dto.frequency === StoreOnboardingNotificationFrequency.digest
              ? dto.intervalMinutes
              : null,
            scheduledTime: dto.frequency === StoreOnboardingNotificationFrequency.scheduled
              ? dto.scheduledTime
              : null,
            timezone: dto.timezone,
            criticalEvents,
            activatedAt: dto.activationConfirmed === true ? new Date() : null,
            createdById: user.id,
            templates: {
              create: {
                eventType: STORE_ONBOARDING_DEFAULT_TEMPLATE_EVENT,
                content: dto.template,
              },
            },
          },
          include: {
            webhook: { select: { id: true, name: true } },
            templates: { orderBy: { eventType: 'asc' } },
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return this.flattenProfile(profile);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) {
        throw new ConflictException('The notification profile changed concurrently; reload and save again');
      }
      throw error;
    }
  }

  notificationTemplateContract() {
    return {
      syntax: '{{ variable }}',
      templateMode: 'single-default',
      variables: [...STORE_ONBOARDING_NOTIFICATION_TEMPLATE_VARIABLES],
      eventTypes: [...STORE_ONBOARDING_NOTIFICATION_EVENT_TYPES],
      maxTemplateLength: 10_000,
    };
  }

  private validateFrequency(dto: PutStoreOnboardingNotificationProfileDto) {
    if (dto.frequency === StoreOnboardingNotificationFrequency.immediate) {
      if (dto.intervalMinutes != null || dto.scheduledTime != null) {
        throw new BadRequestException('Immediate notifications cannot define intervalMinutes or scheduledTime');
      }
      return;
    }
    if (dto.frequency === StoreOnboardingNotificationFrequency.digest) {
      if (dto.intervalMinutes == null || dto.scheduledTime != null) {
        throw new BadRequestException('Digest notifications require intervalMinutes and cannot define scheduledTime');
      }
      return;
    }
    if (dto.scheduledTime == null || dto.intervalMinutes != null) {
      throw new BadRequestException('Scheduled notifications require scheduledTime and cannot define intervalMinutes');
    }
  }

  private validateTimezone(timezone: string) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    } catch {
      throw new BadRequestException(`Invalid IANA timezone: ${timezone}`);
    }
  }

  private flattenProfile<T extends { templates: Array<{ eventType: string; content: string }> }>(profile: T) {
    return {
      ...profile,
      template: profile.templates.find(item => item.eventType === STORE_ONBOARDING_DEFAULT_TEMPLATE_EVENT)?.content ?? '',
    };
  }

  private flattenRollout<T extends { sourceTaskTypes: Array<{ source: string }> }>(rollout: T) {
    return {
      ...rollout,
      sources: rollout.sourceTaskTypes.map(item => item.source),
    };
  }

  private statusPayload(control: {
    id: string;
    globalEnabled: boolean;
    notificationsEnabled: boolean;
    updatedById: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null) {
    return {
      operationalReady: STORE_ONBOARDING_OPERATIONAL_READY,
      activationAllowed: true,
      configured: control !== null,
      globalEnabled: control?.globalEnabled ?? false,
      notificationsEnabled: control?.notificationsEnabled ?? false,
      requestedGlobalEnabled: control?.globalEnabled ?? false,
      requestedNotificationsEnabled: control?.notificationsEnabled ?? false,
      reason: control?.globalEnabled
        ? null
        : 'Store Onboarding is OFF. Only an explicit confirmed activation can enroll new Tasks.',
      updatedAt: control?.updatedAt ?? null,
    };
  }

  private assertActivationConfirmed(enabled: boolean, confirmed: boolean | undefined, label: string) {
    if (!enabled) return;
    if (confirmed === true) return;
    throw new ConflictException({
      statusCode: 409,
      message: `${label} requires activationConfirmed=true`,
      operationalReady: STORE_ONBOARDING_OPERATIONAL_READY,
      activationAllowed: true,
    });
  }

  private normalizeSourceTaskTypes(dto: PutStoreOnboardingRolloutDto) {
    if (dto.sourceTaskTypes?.length) return dto.sourceTaskTypes;
    const sources = dto.sources ?? [];
    const mappings = sources.map(source => ({ source, taskTypeId: dto.taskTypeIds?.[source] ?? '' }));
    const missing = mappings.filter(item => !item.taskTypeId).map(item => item.source);
    if (missing.length) {
      throw new BadRequestException(`Task Type mapping is required for: ${missing.join(', ')}`);
    }
    return mappings as Array<{ source: StoreOnboardingSource; taskTypeId: string }>;
  }

  private assertSupportedSources(sources: StoreOnboardingSource[]) {
    const unsupported = sources.filter(source => (
      source !== StoreOnboardingSource.create && source !== StoreOnboardingSource.duplicate
    ));
    if (unsupported.length) {
      throw new BadRequestException(`Unsupported Store Onboarding source in v1: ${unsupported.join(', ')}`);
    }
  }

  private async readControlFailClosed() {
    try {
      return await this.prisma.storeOnboardingControl.findUnique({ where: { id: CONTROL_ID } });
    } catch (error) {
      this.logger.error(`Store Onboarding control could not be read; feature remains OFF: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async activationReadiness(client: PrismaService | Prisma.TransactionClient, now = new Date()) {
    try {
      const published = await client.storeOnboardingRolloutRevision.findMany({
        where: { activatedAt: { not: null, lte: now }, effectiveAt: { lte: now } },
        include: {
          sourceTaskTypes: { select: { source: true } },
          notificationProfile: { select: { logicalKey: true } },
        },
        orderBy: [
          { country: 'asc' },
          { kaType: 'asc' },
          { effectiveAt: 'desc' },
          { revision: 'desc' },
        ],
      });
      const runtimeByScope = new Map<string, (typeof published)[number]>();
      for (const revision of published) {
        const key = `${revision.country}:${revision.kaType}`;
        if (!runtimeByScope.has(key)) runtimeByScope.set(key, revision);
      }
      const enabledRuntime = [...runtimeByScope.values()].filter(revision => (
        revision.enabled
        && revision.sourceTaskTypes.length > 0
        && !!revision.notificationProfile?.logicalKey
      ));
      let readyScopeCount = 0;
      for (const revision of enabledRuntime) {
        const runtimeProfile = await client.storeOnboardingNotificationProfile.findFirst({
          where: {
            logicalKey: revision.notificationProfile!.logicalKey,
            activatedAt: { not: null, lte: now },
          },
          select: { enabled: true, country: true, kaType: true, sources: true },
          orderBy: { revision: 'desc' },
        });
        const sources = revision.sourceTaskTypes.map(item => item.source);
        if (
          runtimeProfile?.enabled
          && (!runtimeProfile.country || runtimeProfile.country === revision.country)
          && (!runtimeProfile.kaType || runtimeProfile.kaType === revision.kaType)
          && sources.every(source => runtimeProfile.sources.includes(source))
        ) readyScopeCount++;
      }
      const ready = readyScopeCount > 0;
      return {
        ready,
        readyScopeCount,
        runtimeScopeCount: runtimeByScope.size,
        reasons: ready
          ? []
          : ['Activate at least one published rollout with a compatible published notification profile before enabling Store Onboarding'],
      };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? 'unknown')
        : 'unknown';
      this.logger.warn(`Store Onboarding activation readiness unavailable (${code}); activation remains blocked`);
      return {
        ready: false,
        readyScopeCount: 0,
        runtimeScopeCount: 0,
        reasons: ['Store Onboarding activation configuration is unavailable'],
      };
    }
  }
}
