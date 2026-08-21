import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  AccountRole,
  KaType,
  Prisma,
  StoreOnboardingAuditStatus,
  StoreOnboardingGoLiveSource,
  StoreOnboardingGoLiveStatus,
  StoreOnboardingStage,
  StoreOnboardingStatus,
  ShopStatus,
} from '@prisma/client';
import { createHash } from 'crypto';
import { PermissionAccessService } from '../access-control/permission-access.service';
import { JwtUser } from '../auth/types/jwt-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import {
  AssignStoreOnboardingConfigurationBriefDto,
  AssignStoreOnboardingUnitDto,
  AuditStoreOnboardingUnitDto,
  GoLiveStoreOnboardingDto,
  StoreOnboardingListQueryDto,
  SubmitStoreOnboardingShopIdsDto,
  TransitionStoreOnboardingUnitDto,
  UpdateStoreOnboardingBriefDto,
  UpdateStoreOnboardingChecklistDto,
} from './dto/store-onboarding-operation.dto';
import {
  StoreOnboardingAmbiguousGoLiveError,
  StoreOnboardingGoLiveGateway,
  StoreOnboardingRemoteOfflineError,
  StoreOnboardingRemoteRejectedError,
} from './store-onboarding-go-live.gateway';
import { StoreOnboardingLifecycleService, StoreOnboardingTx } from './store-onboarding-lifecycle.service';

const PERSON = { select: { id: true, name: true, email: true } } as const;

const REQUIRED_RTBO_CHECKLIST_KEYS = [
  'application_linked',
  'credentials_valid',
  'shop_list_verified',
  'business_hours',
  'picking_payment',
  'driver_cash_block',
  'menu_ready',
] as const;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
}

function commandHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex').slice(0, 24);
}

const DETAIL_INCLUDE = {
  brand: {
    select: {
      id: true,
      brandId: true,
      brandName: true,
      country: true,
      kaType: true,
      ownerId: true,
      owner: PERSON,
    },
  },
  createdBy: PERSON,
  configurationBriefAssignee: PERSON,
  configurationPreparedBy: PERSON,
  batches: { orderBy: { ordinal: 'asc' as const } },
  units: {
    orderBy: { createdAt: 'asc' as const },
    include: {
      configurationAssignee: PERSON,
      commercialAssignee: PERSON,
      goLiveAssignee: PERSON,
      auditedBy: PERSON,
      transitions: {
        orderBy: { createdAt: 'asc' as const },
        include: { actor: PERSON },
      },
    },
  },
  forecastSnapshots: { orderBy: { calculatedAt: 'desc' as const }, take: 1 },
} satisfies Prisma.StoreOnboardingRequestInclude;

type RequestWithDetail = Prisma.StoreOnboardingRequestGetPayload<{ include: typeof DETAIL_INCLUDE }>;

const ACTION_INCLUDE = {
  brand: { select: { ownerId: true } },
  units: true,
} satisfies Prisma.StoreOnboardingRequestInclude;

type RequestForAction = Prisma.StoreOnboardingRequestGetPayload<{ include: typeof ACTION_INCLUDE }>;

@Injectable()
export class StoreOnboardingService {
  private readonly logger = new Logger(StoreOnboardingService.name);
  private recoveringGoLive = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionAccessService,
    private readonly lifecycle: StoreOnboardingLifecycleService,
    private readonly goLiveGateway: StoreOnboardingGoLiveGateway,
  ) {}

  async list(query: StoreOnboardingListQueryDto, user?: JwtUser) {
    await this.assertOperationalReadEnabled();
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const visibility = await this.visibilityFilter(user);
    const where: Prisma.StoreOnboardingRequestWhereInput = {
      AND: [visibility],
      ...(query.brandId ? { brandId: query.brandId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.stage ? { currentStage: query.stage } : {}),
      ...(query.kaType ? { kaTypeSnapshot: query.kaType } : {}),
      ...(query.country ? { countrySnapshot: query.country } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.storeOnboardingRequest.findMany({
        where,
        include: DETAIL_INCLUDE,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.storeOnboardingRequest.count({ where }),
    ]);
    return { data: await Promise.all(data.map(row => this.decorate(row, user))), total, page, limit };
  }

  async findOne(id: string, user?: JwtUser) {
    await this.assertOperationalReadEnabled();
    const request = await this.prisma.storeOnboardingRequest.findUnique({
      where: { id },
      include: DETAIL_INCLUDE,
    });
    if (!request) throw new NotFoundException('Store Onboarding request not found');
    await this.assertRequestReadable(request, user);
    return this.decorate(request, user);
  }

  async assigneeOptions(user: JwtUser) {
    await this.assertOperationalReadEnabled();
    await this.assertManage(user, 'Only system.manage can list Store Onboarding assignees');
    const superAdmin = user.roles.includes(AccountRole.super_admin);
    const where: Prisma.AccountWhereInput = {
      deletedAt: null,
      ...(!superAdmin
        ? user.sectionId
          ? { sectionId: user.sectionId }
          : { id: user.id }
        : {}),
    };
    const data = await this.prisma.account.findMany({
      where,
      select: { id: true, name: true, email: true, roles: true, sectionId: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
    });
    return { data };
  }

  async submitShopIds(id: string, dto: SubmitStoreOnboardingShopIdsDto, user: JwtUser) {
    await this.assertOperationalWriteEnabled();
    const request = await this.requestForAction(id, user);
    await this.assertOwnerAssignmentOrManage(request, null, user, 'configuration');
    const normalizedUnits = dto.units
      .map(unit => ({
        externalShopId: unit.externalShopId.trim(),
        appShopId: unit.appShopId?.trim() ?? '',
        shopId: unit.shopId ?? null,
      }))
      .sort((left, right) => left.externalShopId.localeCompare(right.externalShopId));
    if (normalizedUnits.some(unit => !unit.externalShopId || !unit.appShopId)) {
      throw new BadRequestException('Every store handoff requires a non-empty Shop ID and App Shop ID');
    }
    const alreadyApplied = !!request.shopIdsValidatedAt
      && normalizedUnits.length === request.units.length
      && normalizedUnits.every(input => {
        const unit = request.units.find(item => item.externalShopId === input.externalShopId);
        return !!unit
          && unit.appShopId === input.appShopId
          && (!input.shopId || unit.shopId === input.shopId);
      });
    if (alreadyApplied) return this.findOne(id, user);
    if (request.currentStage !== StoreOnboardingStage.awaiting_shop_ids) {
      throw new ConflictException('Shop IDs can only be submitted while the request is awaiting_shop_ids');
    }
    const externalIds = dto.units.map(unit => unit.externalShopId.trim()).filter(Boolean);
    if (!externalIds.length || new Set(externalIds).size !== externalIds.length) {
      throw new BadRequestException('Each shop_id must be non-empty and unique');
    }
    const explicitShopIds = dto.units.flatMap(unit => unit.shopId ? [unit.shopId] : []);
    const localShops = await this.prisma.shop.findMany({
      where: {
        brandId: request.brandId,
        deletedAt: null,
        OR: [
          ...(explicitShopIds.length ? [{ id: { in: explicitShopIds } }] : []),
          { shopId: { in: externalIds } },
        ],
      },
      select: { id: true, shopId: true, appShopId: true },
    });
    if (explicitShopIds.some(shopId => !localShops.some(shop => shop.id === shopId))) {
      throw new BadRequestException('One or more local stores do not belong to this Brand');
    }
    for (const input of normalizedUnits) {
      const local = input.shopId
        ? localShops.find(shop => shop.id === input.shopId)
        : localShops.find(shop => shop.shopId === input.externalShopId);
      if (!local) {
        throw new BadRequestException('Every submitted store must match an existing local store for this Brand');
      }
      if (input.shopId && local?.shopId !== input.externalShopId) {
        throw new BadRequestException('The selected local store does not match the submitted Shop ID');
      }
      if (local?.appShopId && local.appShopId !== input.appShopId) {
        throw new BadRequestException('The selected local store does not match the submitted App Shop ID');
      }
    }
    const stage = request.kaTypeSnapshot === KaType.KA
      ? StoreOnboardingStage.awaiting_configuration_brief
      : StoreOnboardingStage.audit_preparing;
    await this.prisma.$transaction(async tx => {
      await this.lifecycle.assertEnabledInTransaction(tx);
      const lockedRequest = await this.lockedRequestForAction(tx, id, undefined, user);
      await this.assertOwnerAssignmentOrManage(lockedRequest, null, user, 'configuration');
      if (
        lockedRequest.currentStage !== StoreOnboardingStage.awaiting_shop_ids
        || lockedRequest.shopIdsValidatedAt !== null
      ) {
        throw new ConflictException('Shop IDs can only be submitted once while the request is awaiting_shop_ids');
      }
      const lockedShops = await tx.$queryRaw<Array<{ id: string; shopId: string; appShopId: string }>>(Prisma.sql`
        SELECT "id", "shop_id" AS "shopId", "app_shop_id" AS "appShopId"
        FROM "shop"
        WHERE "brand_id" = ${lockedRequest.brandId}::uuid
          AND "deleted_at" IS NULL
          AND (
            ${explicitShopIds.length
              ? Prisma.sql`"id" = ANY(${explicitShopIds}::uuid[])`
              : Prisma.sql`FALSE`}
            OR "shop_id" IN (${Prisma.join(externalIds)})
          )
        ORDER BY "id"
        FOR SHARE
      `);
      if (explicitShopIds.some(shopId => !lockedShops.some(shop => shop.id === shopId))) {
        throw new BadRequestException('One or more local stores do not belong to this Brand');
      }
      for (const input of normalizedUnits) {
        const local = input.shopId
          ? lockedShops.find(shop => shop.id === input.shopId)
          : lockedShops.find(shop => shop.shopId === input.externalShopId);
        if (!local) {
          throw new BadRequestException('Every submitted store must match an existing local store for this Brand');
        }
        if (local.shopId !== input.externalShopId) {
          throw new BadRequestException('The selected local store does not match the submitted Shop ID');
        }
        if (local.appShopId && local.appShopId !== input.appShopId) {
          throw new BadRequestException('The selected local store does not match the submitted App Shop ID');
        }
      }
      const batch = await tx.storeOnboardingBatch.findFirst({
        where: { requestId: id },
        orderBy: { ordinal: 'asc' },
      });
      if (!batch) throw new ConflictException('Store Onboarding batch is missing');
      for (const input of dto.units) {
        const externalShopId = input.externalShopId.trim();
        const local = lockedShops.find(shop => shop.id === input.shopId || shop.shopId === externalShopId);
        const existing = await tx.storeOnboardingUnit.findUnique({
          where: { requestId_externalShopId: { requestId: id, externalShopId } },
        });
        if (existing) {
          await tx.storeOnboardingUnit.update({
            where: { id: existing.id },
            data: {
              shopId: local?.id ?? existing.shopId,
              appShopId: input.appShopId.trim(),
            },
          });
          if (existing.stage !== stage) {
            await this.transitionTx(tx, existing, stage, user.id, 'Shop IDs confirmed', {
              source: 'structured_shop_id_handoff',
            });
          }
        } else {
          await tx.storeOnboardingUnit.create({
            data: {
              requestId: id,
              batchId: batch.id,
              shopId: local?.id ?? null,
              externalShopId,
              appShopId: input.appShopId.trim(),
              stage,
              configurationAssigneeId: lockedRequest.brand.ownerId,
              goLiveAssigneeId: lockedRequest.brand.ownerId,
              transitions: {
                create: {
                  fromStage: StoreOnboardingStage.awaiting_shop_ids,
                  toStage: stage,
                  actorId: user.id,
                  metadata: { source: 'structured_shop_id_handoff' },
                },
              },
            },
          });
        }
      }
      const now = new Date();
      await tx.storeOnboardingRequest.update({
        where: { id },
        data: {
          currentStage: stage,
          totalUnits: dto.units.length,
          shopIdsValidatedAt: now,
          shopIdsValidationSource: 'structured_manual',
        },
      });
      await this.lifecycle.enqueueDomainEvent(tx, {
        eventKey: `request:${id}:shop-ids:${commandHash(normalizedUnits)}`,
        eventType: 'stores.created',
        aggregateType: 'store_onboarding_request',
        aggregateId: id,
        requestId: id,
        taskId: lockedRequest.taskId,
        actorId: user.id,
        payload: { requestId: id, totalUnits: dto.units.length, stage },
      });
    });
    return this.findOne(id, user);
  }

  async updateConfigurationBrief(id: string, dto: UpdateStoreOnboardingBriefDto, user: JwtUser) {
    await this.assertOperationalWriteEnabled();
    const request = await this.requestForAction(id, user);
    await this.assertConfigurationBriefActor(request, user, 'publish the KA configuration brief');
    if (request.kaTypeSnapshot !== KaType.KA) {
      throw new ConflictException('The Beverly configuration brief step only applies to KA');
    }
    if (!request.shopIdsValidatedAt) throw new ConflictException('Shop IDs must be confirmed first');
    const instructions = dto.instructions.trim();
    if (!instructions) throw new BadRequestException('Configuration brief instructions are required');
    const normalizedBrief = {
      instructions,
      fields: dto.fields ?? [],
      units: [...(dto.units ?? [])].sort((left, right) => left.unitId.localeCompare(right.unitId)),
    };
    const currentBrief = {
      instructions: request.configurationBrief ?? '',
      fields: request.configurationBriefFields ?? [],
      units: request.units
        .filter(unit => unit.configurationInput != null)
        .map(unit => ({ unitId: unit.id, input: unit.configurationInput }))
        .sort((left, right) => left.unitId.localeCompare(right.unitId)),
    };
    if (commandHash(normalizedBrief) === commandHash(currentBrief)) return this.findOne(id, user);
    if (
      request.currentStage !== StoreOnboardingStage.awaiting_configuration_brief
      || !request.units.some(unit => unit.stage === StoreOnboardingStage.awaiting_configuration_brief)
    ) {
      throw new ConflictException('The KA configuration brief can only be published before configuration starts');
    }
    const now = new Date();
    await this.prisma.$transaction(async tx => {
      await this.lifecycle.assertEnabledInTransaction(tx);
      const lockedRequest = await this.lockedRequestForAction(tx, id, undefined, user);
      await this.assertConfigurationBriefActor(lockedRequest, user, 'publish the KA configuration brief');
      if (lockedRequest.kaTypeSnapshot !== KaType.KA) {
        throw new ConflictException('The Beverly configuration brief step only applies to KA');
      }
      if (!lockedRequest.shopIdsValidatedAt) throw new ConflictException('Shop IDs must be confirmed first');
      if (
        lockedRequest.currentStage !== StoreOnboardingStage.awaiting_configuration_brief
        || !lockedRequest.units.some(unit => unit.stage === StoreOnboardingStage.awaiting_configuration_brief)
      ) {
        throw new ConflictException('The KA configuration brief can only be published before configuration starts');
      }
      const lockedCurrentBrief = {
        instructions: lockedRequest.configurationBrief ?? '',
        fields: lockedRequest.configurationBriefFields ?? [],
        units: lockedRequest.units
          .filter(unit => unit.configurationInput != null)
          .map(unit => ({ unitId: unit.id, input: unit.configurationInput }))
          .sort((left, right) => left.unitId.localeCompare(right.unitId)),
      };
      if (commandHash(normalizedBrief) === commandHash(lockedCurrentBrief)) return;
      await tx.storeOnboardingRequest.update({
        where: { id },
        data: {
          configurationBrief: instructions,
          configurationBriefFields: (dto.fields ?? []) as unknown as Prisma.InputJsonValue,
          configurationPreparedById: user.id,
          configurationPreparedAt: now,
        },
      });
      for (const input of dto.units ?? []) {
        const owned = lockedRequest.units.some(unit => unit.id === input.unitId);
        if (!owned) throw new BadRequestException(`Unit ${input.unitId} does not belong to the request`);
        await tx.storeOnboardingUnit.update({
          where: { id: input.unitId },
          data: { configurationInput: input.input as Prisma.InputJsonValue },
        });
      }
      const candidates = lockedRequest.units.filter(unit => unit.stage === StoreOnboardingStage.awaiting_configuration_brief);
      for (const unit of candidates) {
        await this.transitionTx(tx, unit, StoreOnboardingStage.configuring, user.id, 'Configuration brief published', {
          role: 'beverly_configuration_brief',
        });
      }
      await this.updateAggregate(tx, id);
      await this.lifecycle.enqueueDomainEvent(tx, {
        eventKey: `request:${id}:brief:${commandHash(normalizedBrief)}`,
        eventType: 'configuration.brief_published',
        aggregateType: 'store_onboarding_request',
        aggregateId: id,
        requestId: id,
        taskId: lockedRequest.taskId,
        actorId: user.id,
        payload: { requestId: id, affectedUnits: candidates.length },
      });
    });
    return this.findOne(id, user);
  }

  async assignConfigurationBrief(
    id: string,
    dto: AssignStoreOnboardingConfigurationBriefDto,
    user: JwtUser,
  ) {
    await this.assertOperationalWriteEnabled();
    const request = await this.requestForAction(id, user);
    await this.assertManage(user, 'Only system.manage can assign the KA configuration brief');
    if (request.kaTypeSnapshot !== KaType.KA) {
      throw new ConflictException('The configuration brief assignee only applies to KA');
    }
    const immutableBriefStages: StoreOnboardingStage[] = [
      StoreOnboardingStage.rtbo,
      StoreOnboardingStage.awaiting_go_live,
      StoreOnboardingStage.going_online,
      StoreOnboardingStage.online,
      StoreOnboardingStage.online_failed,
      StoreOnboardingStage.cancelled,
    ];
    if (request.units.some(unit => immutableBriefStages.includes(unit.stage))) {
      throw new ConflictException('The configuration brief assignee cannot change after RTBO has started');
    }
    const accountId = dto.accountId ?? null;
    await this.assertAssignableAccounts(accountId ? [accountId] : [], user);
    if (request.configurationBriefAssigneeId === accountId) return this.findOne(id, user);
    await this.prisma.$transaction(async tx => {
      await this.lifecycle.assertEnabledInTransaction(tx);
      const lockedRequest = await this.lockedRequestForAction(tx, id, undefined, user);
      await this.assertManage(user, 'Only system.manage can assign the KA configuration brief');
      if (lockedRequest.kaTypeSnapshot !== KaType.KA) {
        throw new ConflictException('The configuration brief assignee only applies to KA');
      }
      if (lockedRequest.units.some(unit => immutableBriefStages.includes(unit.stage))) {
        throw new ConflictException('The configuration brief assignee cannot change after RTBO has started');
      }
      await this.assertAssignableAccountsInTransaction(tx, accountId ? [accountId] : [], user);
      if (lockedRequest.configurationBriefAssigneeId === accountId) return;
      const previousAssigneeId = lockedRequest.configurationBriefAssigneeId;
      await tx.storeOnboardingRequest.update({
        where: { id },
        data: { configurationBriefAssigneeId: accountId },
      });
      await this.lifecycle.enqueueDomainEvent(tx, {
        eventKey: `request:${id}:brief-assignment:${commandHash({
          from: previousAssigneeId,
          to: accountId,
        })}`,
        eventType: 'process.changed',
        aggregateType: 'store_onboarding_request',
        aggregateId: id,
        requestId: id,
        taskId: lockedRequest.taskId,
        actorId: user.id,
        payload: {
          requestId: id,
          change: 'configuration_brief_assignment',
          previousConfigurationBriefAssigneeId: previousAssigneeId,
          configurationBriefAssigneeId: accountId,
        },
      });
    });
    return this.findOne(id, user);
  }

  async updateChecklist(
    requestId: string,
    unitId: string,
    dto: UpdateStoreOnboardingChecklistDto,
    user: JwtUser,
  ) {
    await this.assertOperationalWriteEnabled();
    const request = await this.requestForAction(requestId, user);
    const unit = this.unitFromRequest(request, unitId);
    if (request.kaTypeSnapshot === KaType.KA) {
      await this.assertConfigurationBriefActor(request, user, 'complete the KA RTBO checklist');
    } else {
      await this.assertRtboActor(request, unit, user);
    }
    if (unit.stage !== StoreOnboardingStage.audit_approved) {
      throw new ConflictException('The RTBO checklist can only be edited after Audit approval');
    }
    const checklist = dto.checklist as Prisma.InputJsonValue;
    const nextNote = dto.note ?? unit.lastNote;
    if (commandHash({ checklist, note: nextNote }) === commandHash({ checklist: unit.checklist, note: unit.lastNote })) {
      return this.findOne(requestId, user);
    }
    await this.prisma.$transaction(async tx => {
      await this.lifecycle.assertEnabledInTransaction(tx);
      const lockedRequest = await this.lockedRequestForAction(tx, requestId, unitId, user);
      const lockedUnit = this.unitFromRequest(lockedRequest, unitId);
      if (lockedRequest.kaTypeSnapshot === KaType.KA) {
        await this.assertConfigurationBriefActor(lockedRequest, user, 'complete the KA RTBO checklist');
      } else {
        await this.assertRtboActor(lockedRequest, lockedUnit, user);
      }
      if (lockedUnit.stage !== StoreOnboardingStage.audit_approved) {
        throw new ConflictException('The RTBO checklist can only be edited after Audit approval');
      }
      const lockedNextNote = dto.note ?? lockedUnit.lastNote;
      if (
        commandHash({ checklist, note: lockedNextNote })
        === commandHash({ checklist: lockedUnit.checklist, note: lockedUnit.lastNote })
      ) return;
      const previousChecklist = lockedUnit.checklist;
      const previousNote = lockedUnit.lastNote;
      await tx.storeOnboardingUnit.update({
        where: { id: unitId },
        data: { checklist, lastNote: lockedNextNote },
      });
      await this.lifecycle.enqueueDomainEvent(tx, {
        eventKey: `unit:${unitId}:checklist:${commandHash({
          from: { checklist: previousChecklist, note: previousNote },
          to: { checklist, note: lockedNextNote },
        })}`,
        eventType: 'process.changed',
        aggregateType: 'store_onboarding_unit',
        aggregateId: unitId,
        requestId,
        taskId: lockedRequest.taskId,
        unitId,
        actorId: user.id,
        payload: {
          requestId,
          unitId,
          change: 'rtbo_checklist',
          previousChecklist,
          previousNote,
        },
      });
    });
    return this.findOne(requestId, user);
  }

  async assignUnit(requestId: string, unitId: string, dto: AssignStoreOnboardingUnitDto, user: JwtUser) {
    await this.assertOperationalWriteEnabled();
    const request = await this.requestForAction(requestId, user);
    await this.assertManage(user, 'Only system.manage can assign Store Onboarding work');
    const unit = this.unitFromRequest(request, unitId);
    const immutableAssignmentStages: StoreOnboardingStage[] = [
      StoreOnboardingStage.rtbo,
      StoreOnboardingStage.awaiting_go_live,
      StoreOnboardingStage.going_online,
      StoreOnboardingStage.online,
      StoreOnboardingStage.online_failed,
      StoreOnboardingStage.cancelled,
    ];
    if (immutableAssignmentStages.includes(unit.stage)) {
      throw new ConflictException('Assignments are immutable after RTBO has started');
    }
    const ids = [...new Set([
      dto.configurationAssigneeId,
      dto.commercialAssigneeId,
      dto.goLiveAssigneeId,
    ].filter((value): value is string => !!value))];
    await this.assertAssignableAccounts(ids, user);
    await this.prisma.$transaction(async tx => {
      await this.lifecycle.assertEnabledInTransaction(tx);
      const lockedRequest = await this.lockedRequestForAction(tx, requestId, unitId, user);
      await this.assertManage(user, 'Only system.manage can assign Store Onboarding work');
      const lockedUnit = this.unitFromRequest(lockedRequest, unitId);
      const immutableAssignmentStages: StoreOnboardingStage[] = [
        StoreOnboardingStage.rtbo,
        StoreOnboardingStage.awaiting_go_live,
        StoreOnboardingStage.going_online,
        StoreOnboardingStage.online,
        StoreOnboardingStage.online_failed,
        StoreOnboardingStage.cancelled,
      ];
      if (immutableAssignmentStages.includes(lockedUnit.stage)) {
        throw new ConflictException('Assignments are immutable after RTBO has started');
      }
      const assignment = {
        configurationAssigneeId: dto.configurationAssigneeId === undefined
          ? lockedUnit.configurationAssigneeId
          : dto.configurationAssigneeId,
        commercialAssigneeId: dto.commercialAssigneeId === undefined
          ? lockedUnit.commercialAssigneeId
          : dto.commercialAssigneeId,
        goLiveAssigneeId: dto.goLiveAssigneeId === undefined
          ? lockedUnit.goLiveAssigneeId
          : dto.goLiveAssigneeId,
      };
      await this.assertAssignableAccountsInTransaction(tx, [...new Set([
        assignment.configurationAssigneeId,
        assignment.commercialAssigneeId,
        assignment.goLiveAssigneeId,
      ].filter((value): value is string => !!value))], user);
      const unchanged = lockedUnit.configurationAssigneeId === assignment.configurationAssigneeId
        && lockedUnit.commercialAssigneeId === assignment.commercialAssigneeId
        && lockedUnit.goLiveAssigneeId === assignment.goLiveAssigneeId;
      if (unchanged) return;
      const previousAssignment = {
        configurationAssigneeId: lockedUnit.configurationAssigneeId,
        commercialAssigneeId: lockedUnit.commercialAssigneeId,
        goLiveAssigneeId: lockedUnit.goLiveAssigneeId,
      };
      await tx.storeOnboardingUnit.update({ where: { id: unitId }, data: assignment });
      await this.lifecycle.enqueueDomainEvent(tx, {
        eventKey: `unit:${unitId}:assignment:${commandHash({ from: previousAssignment, to: assignment })}`,
        eventType: 'process.changed',
        aggregateType: 'store_onboarding_unit',
        aggregateId: unitId,
        requestId,
        taskId: lockedRequest.taskId,
        unitId,
        actorId: user.id,
        payload: { requestId, unitId, change: 'assignment', previousAssignment, assignment },
      });
    });
    return this.findOne(requestId, user);
  }

  async transitionUnit(
    requestId: string,
    unitId: string,
    dto: TransitionStoreOnboardingUnitDto,
    user: JwtUser,
  ) {
    await this.assertOperationalWriteEnabled();
    const request = await this.requestForAction(requestId, user);
    const unit = this.unitFromRequest(request, unitId);
    await this.authorizeTransition(request, unit, dto.stage, user);
    this.assertAllowedTransition(request.kaTypeSnapshot, unit.stage, dto.stage);
    if (dto.stage === StoreOnboardingStage.rtbo) this.assertRtboChecklist(unit.checklist);
    const transition = await this.prisma.$transaction(async tx => {
      await this.lifecycle.assertEnabledInTransaction(tx);
      const lockedRequest = await this.lockedRequestForAction(tx, requestId, unitId, user);
      const lockedUnit = this.unitFromRequest(lockedRequest, unitId);
      await this.authorizeTransition(lockedRequest, lockedUnit, dto.stage, user);
      this.assertAllowedTransition(lockedRequest.kaTypeSnapshot, lockedUnit.stage, dto.stage);
      if (dto.stage === StoreOnboardingStage.rtbo) this.assertRtboChecklist(lockedUnit.checklist);
      const row = await this.transitionTx(tx, lockedUnit, dto.stage, user.id, dto.note, {
        kaType: lockedRequest.kaTypeSnapshot,
      });
      if (dto.stage === StoreOnboardingStage.configuration_validated) {
        await tx.storeOnboardingUnit.update({
          where: { id: lockedUnit.id },
          data: { configurationCompletedAt: new Date() },
        });
      }
      if (dto.stage === StoreOnboardingStage.rtbo) {
        await tx.storeOnboardingUnit.update({ where: { id: lockedUnit.id }, data: { rtboAt: new Date() } });
      }
      await this.updateAggregate(tx, requestId);
      await this.lifecycle.enqueueDomainEvent(tx, {
        eventKey: `transition:${row.id}`,
        eventType: this.notificationEventForStage(dto.stage),
        aggregateType: 'store_onboarding_unit',
        aggregateId: lockedUnit.id,
        requestId,
        taskId: lockedRequest.taskId,
        unitId: lockedUnit.id,
        actorId: user.id,
        payload: { requestId, unitId, fromStage: lockedUnit.stage, toStage: dto.stage, note: dto.note ?? null },
      });
      return row;
    });
    return { transition, request: await this.findOne(requestId, user) };
  }

  async auditUnit(requestId: string, unitId: string, dto: AuditStoreOnboardingUnitDto, user: JwtUser) {
    await this.assertOperationalWriteEnabled();
    const request = await this.requestForAction(requestId, user);
    const unit = this.unitFromRequest(request, unitId);
    await this.assertCommercialAssignmentOrManage(unit, user, 'register the audit result');
    if (unit.stage !== StoreOnboardingStage.awaiting_audit) {
      throw new ConflictException('Audit results can only be recorded while awaiting_audit');
    }
    const decision = dto.decision as StoreOnboardingAuditStatus;
    if (
      (decision === StoreOnboardingAuditStatus.rejected || decision === StoreOnboardingAuditStatus.needs_information)
      && !dto.note?.trim()
    ) {
      throw new BadRequestException('A note is required when Audit rejects or requests information');
    }
    const target = decision === StoreOnboardingAuditStatus.approved
      ? StoreOnboardingStage.audit_approved
      : decision === StoreOnboardingAuditStatus.rejected
        ? StoreOnboardingStage.audit_rejected
        : StoreOnboardingStage.audit_needs_information;
    const now = new Date();
    await this.prisma.$transaction(async tx => {
      await this.lifecycle.assertEnabledInTransaction(tx);
      const lockedRequest = await this.lockedRequestForAction(tx, requestId, unitId, user);
      const lockedUnit = this.unitFromRequest(lockedRequest, unitId);
      await this.assertCommercialAssignmentOrManage(lockedUnit, user, 'register the audit result');
      if (lockedUnit.stage !== StoreOnboardingStage.awaiting_audit) {
        throw new ConflictException('Audit results can only be recorded while awaiting_audit');
      }
      await tx.storeOnboardingUnit.update({
        where: { id: unitId },
        data: {
          auditStatus: decision,
          auditNote: dto.note ?? null,
          auditEvidence: (dto.evidence ?? []) as Prisma.InputJsonValue,
          auditedById: user.id,
          auditedAt: now,
          blockedFromStage: target === StoreOnboardingStage.audit_needs_information
            ? StoreOnboardingStage.awaiting_audit
            : null,
        },
      });
      const transition = await this.transitionTx(tx, lockedUnit, target, user.id, dto.note, {
        auditDecision: decision,
        evidenceCount: dto.evidence?.length ?? 0,
        correctionOwner: decision === StoreOnboardingAuditStatus.rejected
          ? (lockedRequest.kaTypeSnapshot === KaType.KA ? 'configuration' : 'commercial')
          : null,
      });
      await this.updateAggregate(tx, requestId);
      await this.lifecycle.enqueueDomainEvent(tx, {
        eventKey: `audit:${transition.id}`,
        eventType: `audit.${decision}`,
        aggregateType: 'store_onboarding_unit',
        aggregateId: unitId,
        requestId,
        taskId: lockedRequest.taskId,
        unitId,
        actorId: user.id,
        payload: { requestId, unitId, decision, note: dto.note ?? null, evidence: dto.evidence ?? [] },
      });
    });
    return this.findOne(requestId, user);
  }

  async forecast(requestId: string, user?: JwtUser) {
    await this.assertOperationalReadEnabled();
    const request = await this.prisma.storeOnboardingRequest.findUnique({
      where: { id: requestId },
      include: { units: { select: { stage: true } }, forecastSnapshots: { orderBy: { calculatedAt: 'desc' }, take: 1 } },
    });
    if (!request) throw new NotFoundException('Store Onboarding request not found');
    await this.assertRequestIdReadable(requestId, user);
    return request.forecastSnapshots[0] ?? this.forecastProjection(request);
  }

  async timeline(requestId: string, query: { page?: number; limit?: number; unitId?: string }, user?: JwtUser) {
    await this.assertOperationalReadEnabled();
    await this.assertRequestIdReadable(requestId, user);
    return this.lifecycle.timeline(requestId, query);
  }

  async recalculateForecast(requestId: string, user: JwtUser) {
    await this.assertOperationalWriteEnabled();
    return this.prisma.$transaction(async tx => {
      await this.lifecycle.assertEnabledInTransaction(tx);
      const lockedRequest = await this.lockedRequestForAction(tx, requestId, undefined, user);
      const projection = this.forecastProjection(lockedRequest);
      const snapshot = await tx.storeOnboardingForecastSnapshot.create({
        data: {
          requestId,
          estimatedCompletionAt: projection.estimatedCompletionAt,
          confidence: projection.confidence,
          stageEstimates: projection.stageEstimates as Prisma.InputJsonValue,
          queueUnits: projection.queueUnits,
          explanation: projection.explanation,
        },
      });
      await tx.storeOnboardingRequest.update({
        where: { id: requestId },
        data: {
          estimatedCompletionAt: snapshot.estimatedCompletionAt,
          etaConfidence: snapshot.confidence,
          etaCalculatedAt: snapshot.calculatedAt,
        },
      });
      return snapshot;
    });
  }

  async goLive(requestId: string, dto: GoLiveStoreOnboardingDto, user: JwtUser) {
    await this.assertOperationalWriteEnabled();
    const request = await this.requestForAction(requestId, user);
    const selected = request.units.filter(unit => dto.unitIds.includes(unit.id));
    for (const unit of selected) {
      await this.assertOwnerAssignmentOrManage(request, unit, user, 'go_live');
    }
    if (selected.length !== new Set(dto.unitIds).size) throw new BadRequestException('One or more units do not belong to the request');
    for (const unit of selected) {
      if (
        unit.stage !== StoreOnboardingStage.rtbo
        && unit.stage !== StoreOnboardingStage.awaiting_go_live
        && unit.stage !== StoreOnboardingStage.online_failed
      ) {
        throw new ConflictException(`Unit ${unit.externalShopId} is not ready for Go-Live`);
      }
    }
    const results: Array<{ unitId: string; externalShopId: string; status: string; error?: string }> = [];
    for (const unit of selected) {
      const attempt = await this.prisma.$transaction(async tx => {
        await this.lifecycle.assertEnabledInTransaction(tx);
        const lockedRequest = await this.lockedRequestForAction(tx, requestId, unit.id, user);
        const currentUnit = this.unitFromRequest(lockedRequest, unit.id);
        await this.assertOwnerAssignmentOrManage(lockedRequest, currentUnit, user, 'go_live');
        if (
          currentUnit.rtboAt === null
          || (
            currentUnit.stage !== StoreOnboardingStage.rtbo
            && currentUnit.stage !== StoreOnboardingStage.awaiting_go_live
            && currentUnit.stage !== StoreOnboardingStage.online_failed
          )
        ) {
          throw new ConflictException(`Unit ${unit.externalShopId} changed concurrently and is not ready for Go-Live`);
        }
        const created = await tx.storeOnboardingGoLiveAttempt.create({
          data: { unitId: unit.id, source: StoreOnboardingGoLiveSource.manual, actorId: user.id },
        });
        let currentStage = currentUnit.stage;
        let readinessTransitionId: string | null = null;
        if (currentStage === StoreOnboardingStage.rtbo || currentStage === StoreOnboardingStage.online_failed) {
          const readiness = await this.transitionTx(
            tx,
            currentUnit,
            StoreOnboardingStage.awaiting_go_live,
            user.id,
            'RTBO confirmed; Go-Live ready',
            { attemptId: created.id, technical: true },
          );
          readinessTransitionId = readiness.id;
          currentStage = StoreOnboardingStage.awaiting_go_live;
        }
        const goingOnline = await this.transitionTx(tx, { ...currentUnit, stage: currentStage }, StoreOnboardingStage.going_online, user.id, 'Go-Live requested', {
          attemptId: created.id,
          technical: true,
        });
        await this.updateAggregate(tx, requestId);
        await this.lifecycle.enqueueDomainEvent(tx, {
          eventKey: `go-live:${created.id}:started`,
          eventType: 'go_live.started',
          aggregateType: 'store_onboarding_unit',
          aggregateId: unit.id,
          requestId,
          taskId: lockedRequest.taskId,
          unitId: unit.id,
          actorId: user.id,
          payload: {
            requestId,
            unitId: unit.id,
            attemptId: created.id,
            readinessTransitionId,
            goingOnlineTransitionId: goingOnline.id,
          },
        });
        return created;
      });
      let remoteConfirmedByGateway = false;
      try {
        await this.prisma.$transaction(async tx => {
          // The shared domain lock is intentionally held through the bounded
          // remote call. An OFF update takes the exclusive lock, so no new
          // external side effect can begin after the kill-switch commits.
          await this.lifecycle.assertEnabledInTransaction(tx);
          const activeRequest = await this.lockedRequestForAction(tx, requestId, unit.id, user);
          const activeUnit = this.unitFromRequest(activeRequest, unit.id);
          await this.assertOwnerAssignmentOrManage(activeRequest, activeUnit, user, 'go_live');
          const activeAttempt = await tx.storeOnboardingGoLiveAttempt.findUnique({ where: { id: attempt.id } });
          if (activeAttempt?.status !== StoreOnboardingGoLiveStatus.running || activeUnit?.stage !== StoreOnboardingStage.going_online) {
            throw new ConflictException('Go-Live attempt changed concurrently; reload and retry');
          }
          const freshCredentials = await tx.brand.findUnique({
            where: { id: activeRequest.brandId },
            select: { application: { select: { appId: true, appSecret: true } } },
          });
          const activeApplication = freshCredentials?.application;
          if (!activeApplication) {
            throw new BadRequestException('The Brand has no linked application credentials');
          }
          if (!activeUnit.appShopId) throw new BadRequestException('app_shop_id is required for Go-Live');
          const response = await this.goLiveGateway.open({
            appId: activeApplication.appId,
            encryptedAppSecret: activeApplication.appSecret,
            appShopId: activeUnit.appShopId!,
          });
          remoteConfirmedByGateway = true;
          const now = new Date();
          await tx.storeOnboardingGoLiveAttempt.update({
            where: { id: attempt.id },
            data: {
              status: StoreOnboardingGoLiveStatus.done,
              endpoint: response.endpoint,
              remoteBizStatus: response.remoteBizStatus,
              response: response.response as Prisma.InputJsonValue,
              finishedAt: now,
            },
          });
          await tx.storeOnboardingUnit.update({
            where: { id: unit.id },
            data: { onlineAt: now, onlineSource: StoreOnboardingGoLiveSource.manual, lastError: null },
          });
          if (activeUnit.shopId) {
            await tx.shop.update({ where: { id: activeUnit.shopId }, data: { status: ShopStatus.online } });
          }
          const transition = await this.transitionTx(tx, activeUnit, StoreOnboardingStage.online, user.id, 'Online verified', {
            attemptId: attempt.id,
          });
          await this.updateAggregate(tx, requestId);
          await this.lifecycle.enqueueDomainEvent(tx, {
            eventKey: `go-live:${attempt.id}:done`,
            eventType: 'store.online',
            aggregateType: 'store_onboarding_unit',
            aggregateId: unit.id,
            requestId,
            taskId: activeRequest.taskId,
            unitId: unit.id,
            actorId: user.id,
            payload: { requestId, unitId: unit.id, transitionId: transition.id, attemptId: attempt.id },
          });
        }, { maxWait: 5_000, timeout: 30_000 });
        results.push({ unitId: unit.id, externalShopId: unit.externalShopId, status: 'online' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ConflictException && message.includes('Store Onboarding is disabled')) {
          results.push({ unitId: unit.id, externalShopId: unit.externalShopId, status: 'paused', error: message });
          continue;
        }
        if (
          error instanceof StoreOnboardingAmbiguousGoLiveError
          || (
            remoteConfirmedByGateway
            && !(error instanceof StoreOnboardingRemoteOfflineError)
            && !(error instanceof StoreOnboardingRemoteRejectedError)
          )
        ) {
          results.push({
            unitId: unit.id,
            externalShopId: unit.externalShopId,
            status: 'verification_pending',
            error: message,
          });
          continue;
        }
        try {
          results.push(await this.finishFailedGoLive(requestId, unit.id, user, message, attempt.id));
        } catch (finishError) {
          const finishMessage = finishError instanceof Error ? finishError.message : String(finishError);
          if (finishError instanceof ConflictException && finishMessage.includes('Store Onboarding is disabled')) {
            results.push({ unitId: unit.id, externalShopId: unit.externalShopId, status: 'paused', error: finishMessage });
            continue;
          }
          throw finishError;
        }
      }
    }
    return {
      total: results.length,
      succeeded: results.filter(result => result.status === 'online').length,
      pending: results.filter(result => result.status === 'verification_pending' || result.status === 'paused').length,
      failed: results.filter(result => result.status === 'online_failed').length,
      results,
    };
  }

  /** External Auto Open/Forced Open can call this idempotent hook. */
  async reconcileOnline(shopId: string, source: StoreOnboardingGoLiveSource) {
    const control = await this.lifecycle.control();
    if (!control.globalEnabled) return { changed: 0 };
    const units = await this.prisma.storeOnboardingUnit.findMany({
      where: {
        stage: {
          in: [
            StoreOnboardingStage.awaiting_go_live,
            StoreOnboardingStage.online_failed,
          ],
        },
        rtboAt: { not: null },
        OR: [{ shopId }, { externalShopId: shopId }],
      },
      include: { request: true },
    });
    let changed = 0;
    for (const unit of units) {
      const reconciled = await this.prisma.$transaction(async tx => {
        const lockedControl = await this.lifecycle.assertEnabledInTransaction(tx);
        const lockedRequest = await this.lockedRequestForAction(tx, unit.requestId, unit.id);
        const currentUnit = this.unitFromRequest(lockedRequest, unit.id);
        if (
          currentUnit.rtboAt === null
          || (
            currentUnit.stage !== StoreOnboardingStage.awaiting_go_live
            && currentUnit.stage !== StoreOnboardingStage.online_failed
          )
        ) return false;
        const now = new Date();
        const attempt = await tx.storeOnboardingGoLiveAttempt.create({
          data: {
            unitId: unit.id,
            source,
            status: StoreOnboardingGoLiveStatus.done,
            endpoint: 'external-reconciliation',
            externalRef: shopId,
            finishedAt: now,
          },
        });
        await tx.storeOnboardingUnit.update({
          where: { id: unit.id },
          data: { onlineAt: now, onlineSource: source, onlineExternalRef: shopId, lastError: null },
        });
        if (currentUnit.shopId) {
          await tx.shop.update({ where: { id: currentUnit.shopId }, data: { status: ShopStatus.online } });
        }
        const transition = await this.transitionTx(tx, currentUnit, StoreOnboardingStage.online, null, 'Online reconciled', {
          attemptId: attempt.id,
          source,
        });
        await this.updateAggregate(tx, unit.requestId);
        await this.lifecycle.enqueueDomainEvent(tx, {
          eventKey: `go-live:${attempt.id}:reconciled`,
          eventType: 'store.online',
          aggregateType: 'store_onboarding_unit',
          aggregateId: unit.id,
          requestId: unit.requestId,
          taskId: unit.request.taskId,
          unitId: unit.id,
          payload: { requestId: unit.requestId, unitId: unit.id, transitionId: transition.id, source },
        }, lockedControl);
        return true;
      });
      if (reconciled) changed++;
    }
    return { changed };
  }

  /**
   * Recovers only attempts that already reached going_online. It never repeats
   * the mutating setStatus call; it performs remote verification and closes the
   * local transaction idempotently.
   */
  @Cron('15,45 * * * * *')
  async recoverGoingOnlineAttempts() {
    if (this.recoveringGoLive) return;
    const control = await this.lifecycle.control();
    if (!control.globalEnabled) return;
    this.recoveringGoLive = true;
    try {
      const staleBefore = new Date(Date.now() - 90_000);
      const attempts = await this.prisma.storeOnboardingGoLiveAttempt.findMany({
        where: {
          status: StoreOnboardingGoLiveStatus.running,
          startedAt: { lte: staleBefore },
          unit: { stage: StoreOnboardingStage.going_online },
        },
        include: {
          unit: {
            include: {
              request: {
                include: { brand: { select: { application: { select: { appId: true, appSecret: true } } } } },
              },
            },
          },
        },
        orderBy: { startedAt: 'asc' },
        take: 20,
      });
      for (const attempt of attempts) {
        try {
          await this.prisma.$transaction(async tx => {
            await this.lifecycle.assertEnabledInTransaction(tx);
            await tx.$queryRaw`SELECT "id" FROM "store_onboarding_go_live_attempt" WHERE "id" = ${attempt.id}::uuid FOR UPDATE`;
            const lockedRequest = await this.lockedRequestForAction(tx, attempt.unit.requestId, attempt.unitId);
            const currentUnit = this.unitFromRequest(lockedRequest, attempt.unitId);
            const currentAttempt = await tx.storeOnboardingGoLiveAttempt.findUnique({ where: { id: attempt.id } });
            if (
              currentAttempt?.status !== StoreOnboardingGoLiveStatus.running
              || currentUnit.stage !== StoreOnboardingStage.going_online
            ) return;
            const credentials = await tx.brand.findUnique({
              where: { id: lockedRequest.brandId },
              select: { application: { select: { appId: true, appSecret: true } } },
            });
            const application = credentials?.application;
            const missingPrerequisiteError = !application
              ? 'Go-Live recovery cannot continue because the Brand has no application credentials'
              : !currentUnit.appShopId
                ? 'Go-Live recovery cannot continue because the unit has no App Shop ID'
                : null;
            if (missingPrerequisiteError) {
              const now = new Date();
              await tx.storeOnboardingGoLiveAttempt.update({
                where: { id: attempt.id },
                data: {
                  status: StoreOnboardingGoLiveStatus.failed,
                  endpoint: 'local-precondition',
                  error: missingPrerequisiteError,
                  finishedAt: now,
                },
              });
              await tx.storeOnboardingUnit.update({
                where: { id: attempt.unitId },
                data: { lastError: missingPrerequisiteError },
              });
              const transition = await this.transitionTx(
                tx,
                currentUnit,
                StoreOnboardingStage.online_failed,
                attempt.actorId,
                missingPrerequisiteError,
                { attemptId: attempt.id, recovery: true, missingPrerequisite: true },
              );
              await this.updateAggregate(tx, lockedRequest.id);
              await this.lifecycle.enqueueDomainEvent(tx, {
                eventKey: `go-live:${attempt.id}:failed`,
                eventType: 'store.online_failed',
                aggregateType: 'store_onboarding_unit',
                aggregateId: attempt.unitId,
                requestId: lockedRequest.id,
                taskId: lockedRequest.taskId,
                unitId: attempt.unitId,
                actorId: attempt.actorId ?? undefined,
                payload: {
                  requestId: lockedRequest.id,
                  unitId: attempt.unitId,
                  transitionId: transition.id,
                  attemptId: attempt.id,
                  recovered: true,
                  missingPrerequisite: true,
                },
              });
              return;
            }
            const response = await this.goLiveGateway.verify({
              appId: application!.appId,
              encryptedAppSecret: application!.appSecret,
              appShopId: currentUnit.appShopId!,
            });
            const now = new Date();
            await tx.storeOnboardingGoLiveAttempt.update({
              where: { id: attempt.id },
              data: {
                status: StoreOnboardingGoLiveStatus.done,
                endpoint: response.endpoint,
                remoteBizStatus: response.remoteBizStatus,
                response: response.response as Prisma.InputJsonValue,
                finishedAt: now,
                error: null,
              },
            });
            await tx.storeOnboardingUnit.update({
              where: { id: attempt.unitId },
              data: { onlineAt: now, onlineSource: attempt.source, lastError: null },
            });
            if (currentUnit.shopId) {
              await tx.shop.update({ where: { id: currentUnit.shopId }, data: { status: ShopStatus.online } });
            }
            const transition = await this.transitionTx(
              tx,
              currentUnit,
              StoreOnboardingStage.online,
              attempt.actorId,
              'Online verified after recovery',
              { attemptId: attempt.id, recovery: true },
            );
            await this.updateAggregate(tx, lockedRequest.id);
            await this.lifecycle.enqueueDomainEvent(tx, {
              eventKey: `go-live:${attempt.id}:done`,
              eventType: 'store.online',
              aggregateType: 'store_onboarding_unit',
              aggregateId: attempt.unitId,
              requestId: lockedRequest.id,
              taskId: lockedRequest.taskId,
              unitId: attempt.unitId,
              actorId: attempt.actorId ?? undefined,
              payload: {
                requestId: lockedRequest.id,
                unitId: attempt.unitId,
                transitionId: transition.id,
                attemptId: attempt.id,
                recovered: true,
              },
            });
          }, { maxWait: 5_000, timeout: 30_000 });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof StoreOnboardingRemoteOfflineError) {
            await this.prisma.$transaction(async tx => {
              await this.lifecycle.assertEnabledInTransaction(tx);
              await tx.$queryRaw`SELECT "id" FROM "store_onboarding_go_live_attempt" WHERE "id" = ${attempt.id}::uuid FOR UPDATE`;
              const lockedRequest = await this.lockedRequestForAction(tx, attempt.unit.requestId, attempt.unitId);
              const currentUnit = this.unitFromRequest(lockedRequest, attempt.unitId);
              const currentAttempt = await tx.storeOnboardingGoLiveAttempt.findUnique({ where: { id: attempt.id } });
              if (
                currentAttempt?.status !== StoreOnboardingGoLiveStatus.running
                || currentUnit.stage !== StoreOnboardingStage.going_online
              ) return;
              const now = new Date();
              await tx.storeOnboardingGoLiveAttempt.update({
                where: { id: attempt.id },
                data: {
                  status: StoreOnboardingGoLiveStatus.failed,
                  endpoint: 'GET /v1/shop/shop/detail',
                  remoteBizStatus: error.remoteBizStatus,
                  error: message,
                  finishedAt: now,
                },
              });
              await tx.storeOnboardingUnit.update({ where: { id: attempt.unitId }, data: { lastError: message } });
              const transition = await this.transitionTx(
                tx,
                currentUnit,
                StoreOnboardingStage.online_failed,
                attempt.actorId,
                message,
                { attemptId: attempt.id, recovery: true, remoteBizStatus: error.remoteBizStatus },
              );
              await this.updateAggregate(tx, lockedRequest.id);
              await this.lifecycle.enqueueDomainEvent(tx, {
                eventKey: `go-live:${attempt.id}:failed`,
                eventType: 'store.online_failed',
                aggregateType: 'store_onboarding_unit',
                aggregateId: attempt.unitId,
                requestId: lockedRequest.id,
                taskId: lockedRequest.taskId,
                unitId: attempt.unitId,
                actorId: attempt.actorId ?? undefined,
                payload: {
                  requestId: lockedRequest.id,
                  unitId: attempt.unitId,
                  transitionId: transition.id,
                  attemptId: attempt.id,
                  recovered: true,
                  remoteBizStatus: error.remoteBizStatus,
                },
              });
            });
            continue;
          }
          this.logger.warn(`Store Onboarding Go-Live recovery pending (${attempt.id}): ${message.slice(0, 300)}`);
        }
      }
    } finally {
      this.recoveringGoLive = false;
    }
  }

  private async finishFailedGoLive(
    requestId: string,
    unitId: string,
    user: JwtUser,
    error: string,
    attemptId: string,
  ) {
    const failedUnit = await this.prisma.$transaction(async tx => {
      await this.lifecycle.assertEnabledInTransaction(tx);
      const lockedRequest = await this.lockedRequestForAction(tx, requestId, unitId, user);
      const lockedUnit = this.unitFromRequest(lockedRequest, unitId);
      await this.assertOwnerAssignmentOrManage(lockedRequest, lockedUnit, user, 'go_live');
      await tx.$queryRaw`
        SELECT "id"
        FROM "store_onboarding_go_live_attempt"
        WHERE "id" = ${attemptId}::uuid AND "unit_id" = ${unitId}::uuid
        FOR UPDATE
      `;
      const currentAttempt = await tx.storeOnboardingGoLiveAttempt.findUnique({ where: { id: attemptId } });
      if (
        currentAttempt?.unitId !== unitId
        || currentAttempt.status !== StoreOnboardingGoLiveStatus.running
        || lockedUnit.stage !== StoreOnboardingStage.going_online
      ) {
        throw new ConflictException('Go-Live attempt changed concurrently; reload before retrying');
      }
      const now = new Date();
      const attempt = await tx.storeOnboardingGoLiveAttempt.update({
        where: { id: attemptId },
        data: { status: StoreOnboardingGoLiveStatus.failed, error, finishedAt: now },
      });
      await tx.storeOnboardingUnit.update({ where: { id: unitId }, data: { lastError: error } });
      const transition = await this.transitionTx(tx, lockedUnit, StoreOnboardingStage.online_failed, user.id, error, {
        attemptId,
      });
      await this.updateAggregate(tx, lockedRequest.id);
      await this.lifecycle.enqueueDomainEvent(tx, {
        eventKey: `go-live:${attempt.id}:failed`,
        eventType: 'store.online_failed',
        aggregateType: 'store_onboarding_unit',
        aggregateId: unitId,
        requestId: lockedRequest.id,
        taskId: lockedRequest.taskId,
        unitId,
        actorId: user.id,
        payload: { requestId: lockedRequest.id, unitId, transitionId: transition.id, error },
      });
      return { unitId, externalShopId: lockedUnit.externalShopId };
    });
    return { ...failedUnit, status: 'online_failed', error };
  }

  private async requestForAction(id: string, user?: JwtUser): Promise<RequestForAction> {
    const request = await this.prisma.storeOnboardingRequest.findUnique({
      where: { id },
      include: ACTION_INCLUDE,
    });
    if (!request) throw new NotFoundException('Store Onboarding request not found');
    if (user) await this.assertRequestReadable(request, user);
    if (request.status === StoreOnboardingStatus.cancelled) throw new ConflictException('Store Onboarding request is cancelled');
    return request;
  }

  private async lockedRequestForAction(
    tx: StoreOnboardingTx,
    id: string,
    unitId?: string,
    user?: JwtUser,
  ): Promise<RequestForAction> {
    await tx.$queryRaw`SELECT "id" FROM "store_onboarding_request" WHERE "id" = ${id}::uuid FOR UPDATE`;
    await tx.$queryRaw`
      SELECT "id"
      FROM "brand"
      WHERE "id" = (SELECT "brand_id" FROM "store_onboarding_request" WHERE "id" = ${id}::uuid)
      FOR SHARE
    `;
    if (unitId) {
      await tx.$queryRaw`
        SELECT "id"
        FROM "store_onboarding_unit"
        WHERE "id" = ${unitId}::uuid AND "request_id" = ${id}::uuid
        FOR UPDATE
      `;
    }
    const request = await tx.storeOnboardingRequest.findUnique({
      where: { id },
      include: ACTION_INCLUDE,
    });
    if (!request) throw new NotFoundException('Store Onboarding request not found');
    if (user) await this.assertRequestReadable(request, user);
    if (request.status === StoreOnboardingStatus.cancelled) {
      throw new ConflictException('Store Onboarding request is cancelled');
    }
    return request;
  }

  private unitFromRequest(
    request: RequestForAction,
    unitId: string,
  ): RequestForAction['units'][number] {
    const unit = request.units.find(item => item.id === unitId);
    if (!unit) throw new NotFoundException('Store Onboarding unit not found in this request');
    return unit;
  }

  private async canManage(user: JwtUser) {
    return this.permissions.can(user, ['system.manage']);
  }

  private async visibilityFilter(user?: JwtUser): Promise<Prisma.StoreOnboardingRequestWhereInput> {
    if (user && await this.canManage(user)) return {};
    if (!user) return { id: '__store_onboarding_unauthorized__' };
    return {
      OR: [
        { createdById: user.id },
        { configurationBriefAssigneeId: user.id },
        { brand: { ownerId: user.id } },
        { units: { some: { configurationAssigneeId: user.id } } },
        { units: { some: { commercialAssigneeId: user.id } } },
        { units: { some: { goLiveAssigneeId: user.id } } },
      ],
    };
  }

  private async assertRequestReadable(
    request: {
      createdById: string;
      configurationBriefAssigneeId: string | null;
      brand: { ownerId: string | null };
      units: Array<{
        configurationAssigneeId: string | null;
        commercialAssigneeId: string | null;
        goLiveAssigneeId: string | null;
      }>;
    },
    user?: JwtUser,
  ) {
    if (user && await this.canManage(user)) return;
    if (
      user
      && (
        request.createdById === user.id
        || request.configurationBriefAssigneeId === user.id
        || request.brand.ownerId === user.id
        || request.units.some(unit => (
          unit.configurationAssigneeId === user.id
          || unit.commercialAssigneeId === user.id
          || unit.goLiveAssigneeId === user.id
        ))
      )
    ) return;
    // Deliberately hide the existence of requests outside the actor's scope.
    throw new NotFoundException('Store Onboarding request not found');
  }

  private async assertRequestIdReadable(requestId: string, user?: JwtUser) {
    const request = await this.prisma.storeOnboardingRequest.findUnique({
      where: { id: requestId },
      include: {
        brand: { select: { ownerId: true } },
        units: {
          select: {
            configurationAssigneeId: true,
            commercialAssigneeId: true,
            goLiveAssigneeId: true,
          },
        },
      },
    });
    if (!request) throw new NotFoundException('Store Onboarding request not found');
    await this.assertRequestReadable(request, user);
  }

  private async assertOperationalWriteEnabled() {
    const control = await this.lifecycle.control();
    if (!control.globalEnabled) {
      throw new ConflictException('Store Onboarding is disabled; operational writes are blocked');
    }
  }

  private async assertOperationalReadEnabled() {
    const control = await this.lifecycle.control();
    if (!control.globalEnabled) {
      throw new ConflictException('Store Onboarding is disabled');
    }
  }

  private notificationEventForStage(stage: StoreOnboardingStage) {
    const events: Partial<Record<StoreOnboardingStage, string>> = {
      [StoreOnboardingStage.configuring]: 'configuration.started',
      [StoreOnboardingStage.configuration_validated]: 'configuration.completed',
      [StoreOnboardingStage.awaiting_audit]: 'audit.submitted',
      [StoreOnboardingStage.rtbo]: 'rtbo.completed',
      [StoreOnboardingStage.going_online]: 'go_live.started',
      [StoreOnboardingStage.online]: 'store.online',
      [StoreOnboardingStage.online_failed]: 'store.online_failed',
    };
    return events[stage] ?? 'process.changed';
  }

  private async assertManage(user: JwtUser, message: string) {
    if (!await this.canManage(user)) throw new ForbiddenException(message);
  }

  private async assertAssignableAccounts(ids: string[], user: JwtUser) {
    if (!ids.length) return;
    const superAdmin = user.roles.includes(AccountRole.super_admin);
    const found = await this.prisma.account.count({
      where: {
        deletedAt: null,
        roles: { isEmpty: false },
        AND: [
          { id: { in: ids } },
          ...(!superAdmin
            ? [user.sectionId ? { sectionId: user.sectionId } : { id: user.id }]
            : []),
        ],
      },
    });
    if (found !== ids.length) {
      throw new BadRequestException('One or more assignees do not exist or are outside your section scope');
    }
  }

  private async assertAssignableAccountsInTransaction(
    tx: StoreOnboardingTx,
    ids: string[],
    user: JwtUser,
  ) {
    const uniqueIds = [...new Set(ids)].sort();
    if (!uniqueIds.length) return;

    // Lock each destination after the request/unit locks. This closes the gap
    // between the inexpensive preflight and the assignment write: a concurrent
    // soft-delete or section move must commit first or wait for this command.
    for (const id of uniqueIds) {
      await tx.$queryRaw`SELECT "id" FROM "account" WHERE "id" = ${id}::uuid FOR SHARE`;
    }
    const accounts = await tx.account.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, deletedAt: true, sectionId: true, roles: true },
    });
    const byId = new Map(accounts.map(account => [account.id, account]));
    const superAdmin = user.roles.includes(AccountRole.super_admin);
    const invalid = uniqueIds.some(id => {
      const account = byId.get(id);
      if (!account || account.deletedAt !== null || account.roles.length === 0) return true;
      if (superAdmin) return false;
      return user.sectionId ? account.sectionId !== user.sectionId : account.id !== user.id;
    });
    if (invalid) {
      throw new BadRequestException('One or more assignees do not exist or are outside your section scope');
    }
  }

  private async assertCommercialAssignmentOrManage(
    unit: { commercialAssigneeId?: string | null },
    user: JwtUser,
    action: string,
  ) {
    if (await this.canManage(user) || unit.commercialAssigneeId === user.id) return;
    throw new ForbiddenException(`Only system.manage or the explicit Commercial assignee can ${action}`);
  }

  private async assertConfigurationBriefActor(
    request: { configurationBriefAssigneeId?: string | null },
    user: JwtUser,
    action: string,
  ) {
    if (await this.canManage(user) || request.configurationBriefAssigneeId === user.id) return;
    throw new ForbiddenException(`Only system.manage or the explicit configuration brief assignee can ${action}`);
  }

  private async assertRtboActor(
    request: { brand: { ownerId: string | null } },
    unit: { configurationAssigneeId?: string | null; goLiveAssigneeId?: string | null },
    user: JwtUser,
  ) {
    if (
      await this.canManage(user)
      || request.brand.ownerId === user.id
      || unit.configurationAssigneeId === user.id
      || unit.goLiveAssigneeId === user.id
    ) return;
    throw new ForbiddenException('Only system.manage, the Brand owner or an explicit configuration/Go-Live assignee can complete RTBO');
  }

  private assertRtboChecklist(value: Prisma.JsonValue | null) {
    const checklist = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, Prisma.JsonValue>
      : {};
    const missing = REQUIRED_RTBO_CHECKLIST_KEYS.filter(key => checklist[key] !== true);
    if (missing.length) {
      throw new ConflictException(`RTBO requires every checklist item: ${missing.join(', ')}`);
    }
  }

  private async assertOwnerAssignmentOrManage(
    request: { brand: { ownerId: string | null } },
    unit: { configurationAssigneeId?: string | null; goLiveAssigneeId?: string | null } | null,
    user: JwtUser,
    capability: 'configuration' | 'go_live',
  ) {
    if (await this.canManage(user)) return;
    const assignedId = capability === 'configuration'
      ? unit?.configurationAssigneeId
      : unit?.goLiveAssigneeId;
    if (assignedId === user.id || request.brand.ownerId === user.id) return;
    throw new ForbiddenException(`Only system.manage, the explicit ${capability} assignee or the Brand owner can perform this action`);
  }

  private assertAllowedTransition(kaType: KaType, from: StoreOnboardingStage, to: StoreOnboardingStage) {
    const common = new Map<StoreOnboardingStage, StoreOnboardingStage[]>([
      [StoreOnboardingStage.audit_preparing, [StoreOnboardingStage.awaiting_audit]],
      [StoreOnboardingStage.audit_needs_information, [StoreOnboardingStage.audit_preparing]],
      [StoreOnboardingStage.audit_approved, [StoreOnboardingStage.rtbo]],
      [StoreOnboardingStage.rtbo, [StoreOnboardingStage.awaiting_go_live]],
      [StoreOnboardingStage.online_failed, [StoreOnboardingStage.awaiting_go_live]],
    ]);
    if (kaType === KaType.KA) {
      common.set(StoreOnboardingStage.configuring, [StoreOnboardingStage.configuration_validated]);
      common.set(StoreOnboardingStage.configuration_validated, [StoreOnboardingStage.audit_preparing]);
      common.set(StoreOnboardingStage.audit_rejected, [StoreOnboardingStage.configuring]);
    } else {
      common.set(StoreOnboardingStage.audit_rejected, [StoreOnboardingStage.audit_preparing]);
    }
    if (!common.get(from)?.includes(to)) {
      throw new ConflictException(`Invalid ${kaType} transition: ${from} -> ${to}`);
    }
  }

  private async authorizeTransition(
    request: Awaited<ReturnType<StoreOnboardingService['requestForAction']>>,
    unit: Awaited<ReturnType<StoreOnboardingService['requestForAction']>>['units'][number],
    target: StoreOnboardingStage,
    user: JwtUser,
  ) {
    const commercialTargets = new Set<StoreOnboardingStage>([
      StoreOnboardingStage.audit_preparing,
      StoreOnboardingStage.awaiting_audit,
    ]);
    if (commercialTargets.has(target)) {
      return this.assertCommercialAssignmentOrManage(unit, user, 'prepare or resubmit Audit');
    }
    if (request.kaTypeSnapshot === KaType.KA && target === StoreOnboardingStage.rtbo) {
      return this.assertConfigurationBriefActor(request, user, 'confirm KA RTBO');
    }
    if (target === StoreOnboardingStage.rtbo) {
      return this.assertRtboActor(request, unit, user);
    }
    return this.assertOwnerAssignmentOrManage(
      request,
      unit,
      user,
      target === StoreOnboardingStage.awaiting_go_live ? 'go_live' : 'configuration',
    );
  }

  private async transitionTx(
    tx: StoreOnboardingTx,
    unit: { id: string; stage: StoreOnboardingStage },
    toStage: StoreOnboardingStage,
    actorId: string | null,
    note?: string,
    metadata?: Prisma.InputJsonObject,
  ) {
    if (unit.stage === toStage) throw new ConflictException(`Unit is already ${toStage}`);
    const claimed = await tx.storeOnboardingUnit.updateMany({
      where: { id: unit.id, stage: unit.stage },
      data: {
        stage: toStage,
        lastNote: note ?? undefined,
        blockedFromStage: toStage === StoreOnboardingStage.audit_needs_information
          ? unit.stage
          : unit.stage === StoreOnboardingStage.audit_needs_information
            ? null
            : undefined,
        auditStatus: toStage === StoreOnboardingStage.awaiting_audit
          ? StoreOnboardingAuditStatus.pending
          : undefined,
      },
    });
    if (!claimed.count) throw new ConflictException('Unit changed concurrently; reload and retry');
    return tx.storeOnboardingTransition.create({
      data: {
        unitId: unit.id,
        fromStage: unit.stage,
        toStage,
        actorId,
        note: note ?? null,
        metadata: metadata ?? Prisma.JsonNull,
      },
    });
  }

  private async updateAggregate(tx: StoreOnboardingTx, requestId: string) {
    const [units, request] = await Promise.all([
      tx.storeOnboardingUnit.findMany({ where: { requestId }, select: { stage: true } }),
      tx.storeOnboardingRequest.findUnique({
        where: { id: requestId },
        select: { kaTypeSnapshot: true, taskId: true },
      }),
    ]);
    if (!request) throw new NotFoundException('Store Onboarding request not found');
    const totalUnits = units.length;
    const completedUnits = units.filter(unit => unit.stage === StoreOnboardingStage.online).length;
    const failedStages: StoreOnboardingStage[] = [
      StoreOnboardingStage.online_failed,
      StoreOnboardingStage.creation_failed,
      StoreOnboardingStage.no_coverage,
    ];
    const failedUnits = units.filter(unit => failedStages.includes(unit.stage)).length;
    const blockedStages: StoreOnboardingStage[] = [StoreOnboardingStage.blocked, StoreOnboardingStage.audit_needs_information];
    const blocked = units.some(unit => blockedStages.includes(unit.stage));
    const status = totalUnits > 0 && completedUnits === totalUnits
      ? StoreOnboardingStatus.done
      : blocked
        ? StoreOnboardingStatus.blocked
        : completedUnits > 0 && failedUnits > 0
          ? StoreOnboardingStatus.partial_success
          : StoreOnboardingStatus.active;
    const attentionOrder: StoreOnboardingStage[] = [
      StoreOnboardingStage.audit_needs_information,
      StoreOnboardingStage.audit_rejected,
      StoreOnboardingStage.online_failed,
      StoreOnboardingStage.creation_failed,
      StoreOnboardingStage.no_coverage,
      StoreOnboardingStage.blocked,
    ];
    const kaFlow: StoreOnboardingStage[] = [
      StoreOnboardingStage.created,
      StoreOnboardingStage.awaiting_shop_ids,
      StoreOnboardingStage.awaiting_configuration_brief,
      StoreOnboardingStage.configuring,
      StoreOnboardingStage.configuration_validated,
      StoreOnboardingStage.audit_preparing,
      StoreOnboardingStage.awaiting_audit,
      StoreOnboardingStage.audit_approved,
      StoreOnboardingStage.rtbo,
      StoreOnboardingStage.awaiting_go_live,
      StoreOnboardingStage.going_online,
      StoreOnboardingStage.online,
    ];
    const nonKaOnlyStages: StoreOnboardingStage[] = [
      StoreOnboardingStage.awaiting_configuration_brief,
      StoreOnboardingStage.configuring,
      StoreOnboardingStage.configuration_validated,
    ];
    const otherFlow = kaFlow.filter(stage => !nonKaOnlyStages.includes(stage));
    const attention = attentionOrder.find(stage => units.some(unit => unit.stage === stage));
    const flow = request.kaTypeSnapshot === KaType.KA ? kaFlow : otherFlow;
    const activeStages = units
      .map(unit => unit.stage)
      .filter(stage => stage !== StoreOnboardingStage.online && stage !== StoreOnboardingStage.cancelled);
    const earliest = activeStages.sort((left, right) => {
      const leftIndex = flow.indexOf(left);
      const rightIndex = flow.indexOf(right);
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
    })[0];
    const currentStage = completedUnits === totalUnits && totalUnits > 0
      ? StoreOnboardingStage.online
      : attention ?? earliest ?? units[0]?.stage;
    const completedAt = status === StoreOnboardingStatus.done ? new Date() : null;
    await tx.storeOnboardingRequest.update({
      where: { id: requestId },
      data: {
        totalUnits,
        completedUnits,
        failedUnits,
        status,
        ...(currentStage ? { currentStage } : {}),
        completedAt,
      },
    });
    if (completedAt) {
      await tx.storeOnboardingBatch.updateMany({
        where: { requestId, completedAt: null },
        data: { completedAt },
      });
      await this.lifecycle.enqueueDomainEvent(tx, {
        eventKey: `request-completed:${requestId}`,
        eventType: 'request.completed',
        aggregateType: 'store_onboarding_request',
        aggregateId: requestId,
        requestId,
        taskId: request.taskId,
        payload: { requestId, completedAt: completedAt.toISOString(), totalUnits },
      });
    }
  }

  private forecastProjection(request: {
    kaTypeSnapshot: KaType;
    units: Array<{ stage: StoreOnboardingStage }>;
  }) {
    const kaStages: StoreOnboardingStage[] = [
      StoreOnboardingStage.awaiting_configuration_brief,
      StoreOnboardingStage.configuring,
      StoreOnboardingStage.configuration_validated,
      StoreOnboardingStage.audit_preparing,
      StoreOnboardingStage.awaiting_audit,
      StoreOnboardingStage.audit_approved,
      StoreOnboardingStage.rtbo,
      StoreOnboardingStage.awaiting_go_live,
      StoreOnboardingStage.online,
    ];
    const otherStages: StoreOnboardingStage[] = [
      StoreOnboardingStage.audit_preparing,
      StoreOnboardingStage.awaiting_audit,
      StoreOnboardingStage.audit_approved,
      StoreOnboardingStage.rtbo,
      StoreOnboardingStage.awaiting_go_live,
      StoreOnboardingStage.online,
    ];
    const flow = request.kaTypeSnapshot === KaType.KA ? kaStages : otherStages;
    const now = new Date();
    const active = request.units.filter(unit => unit.stage !== StoreOnboardingStage.online);
    const maxRemaining = active.reduce((max, unit) => {
      const index = flow.indexOf(unit.stage);
      return Math.max(max, index >= 0 ? flow.length - index - 1 : flow.length);
    }, 0);
    const minutesPerStage = 60;
    const estimatedCompletionAt = new Date(now.getTime() + Math.max(1, maxRemaining) * minutesPerStage * 60_000);
    const stageEstimates = flow.map((stage, index) => ({
      stage,
      label: stage.replaceAll('_', ' '),
      estimatedAt: new Date(now.getTime() + (index + 1) * minutesPerStage * 60_000).toISOString(),
      source: 'deterministic_v1',
    }));
    return {
      estimatedCompletionAt,
      confidence: active.length ? 'low' as const : 'high' as const,
      stageEstimates,
      queueUnits: active.length,
      explanation: 'Deterministic v1 estimate; no broad BPO scheduler or historical work-rate dependency is required.',
      calculatedAt: now,
    };
  }

  private async decorate(request: RequestWithDetail, user?: JwtUser) {
    const dependency = await this.prisma.taskDependency.findFirst({
      where: { taskId: request.taskId, kind: 'brand_ready' },
      orderBy: { createdAt: 'desc' },
    });
    const canManage = user ? await this.canManage(user) : false;
    const owner = !!user && request.brand.ownerId === user.id;
    const now = new Date();
    const durationMinutes = dependency
      ? dependency.autoCompleted
        ? 0
        : Math.max(0, Math.round(((dependency.satisfiedAt ?? now).getTime() - dependency.startedAt.getTime()) / 60_000))
      : null;
    const sharedBatchCount = dependency
      ? await this.prisma.storeOnboardingBatch.count({
        where: { brandProvisioningId: dependency.brandProvisioningId },
      })
      : 0;
    return {
      ...request,
      forecast: request.forecastSnapshots[0] ?? null,
      enrollmentStatus: 'enrolled',
      rolloutPolicyId: request.rolloutRevisionId,
      eligibilitySnapshot: request.enrollmentSnapshot,
      canEditConfigurationBrief: request.kaTypeSnapshot === KaType.KA
        && (canManage || request.configurationBriefAssigneeId === user?.id),
      canSubmitShopIds: canManage || owner,
      brandDependency: dependency ? {
        status: dependency.autoCompleted ? 'existing' : dependency.status,
        brandTaskId: dependency.prerequisiteTaskId,
        sourceTaskId: dependency.prerequisiteTaskId,
        startedAt: dependency.startedAt,
        readyAt: dependency.satisfiedAt,
        durationMinutes,
        elapsedMinutes: durationMinutes,
        autoCompleted: dependency.autoCompleted,
        sharedBatchCount,
      } : null,
    };
  }
}
