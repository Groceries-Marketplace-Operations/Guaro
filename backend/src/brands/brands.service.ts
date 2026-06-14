import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountRole, AssignmentMode, Country, KaType, MenuIntegration, PaymentMode, PickingMode, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AddRuleCandidateDto } from './dto/add-rule-candidate.dto';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

const BRAND_INCLUDE = {
  owner: { select: { id: true, name: true, email: true } },
  application: { select: { id: true, appId: true, appName: true, country: true } },
  webhooks: { include: { webhook: { select: { id: true, name: true, url: true, isAlerts: true } } } },
  _count: { select: { shops: true } },
} as const;

export interface BrandFilters {
  page?: number;
  limit?: number;
  q?: string;
  country?: Country;
  kaType?: KaType;
  menuIntegration?: MenuIntegration;
  pickingMode?: PickingMode;
  paymentMode?: PaymentMode;
  myBrands?: boolean;
}

@Injectable()
export class BrandsService {
  constructor(private prisma: PrismaService) {}

  // ── Brands ────────────────────────────────────────────────────────────────

  async findAll(roles: AccountRole[], accountId: string, filters: BrandFilters = {}) {
    const { page = 1, limit = 25, q, country, kaType, menuIntegration, pickingMode, paymentMode, myBrands } = filters;
    const skip = (page - 1) * limit;

    const where: Prisma.BrandWhereInput = { deletedAt: null };

    if (myBrands) {
      where.ownerId = accountId;
    }

    if (q) where.OR = [
      { brandName: { contains: q, mode: 'insensitive' } },
      { brandId:   { contains: q, mode: 'insensitive' } },
    ];
    if (country) where.country = country;
    if (kaType) where.kaType = kaType;
    if (menuIntegration) where.menuIntegration = menuIntegration;
    if (pickingMode) where.pickingMode = pickingMode;
    if (paymentMode) where.paymentMode = paymentMode;

    const [data, total] = await Promise.all([
      this.prisma.brand.findMany({ where, include: BRAND_INCLUDE, orderBy: { brandName: 'asc' }, skip, take: limit }),
      this.prisma.brand.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async findOne(id: string) {
    const brand = await this.prisma.brand.findUnique({ where: { id }, include: BRAND_INCLUDE });
    if (!brand || brand.deletedAt) throw new NotFoundException('Brand not found');
    return brand;
  }

  async create(dto: CreateBrandDto, createdById: string) {
    const { webhookIds, ...brandData } = dto;
    const ownerId = await this.assignOwner(dto.kaType, dto.country);
    return this.prisma.brand.create({
      data: {
        ...brandData,
        ownerId: ownerId ?? undefined,
        createdById,
        ...(webhookIds?.length && {
          webhooks: { create: webhookIds.map(webhookId => ({ webhookId })) },
        }),
      },
      include: BRAND_INCLUDE,
    });
  }

  async update(id: string, dto: UpdateBrandDto, requesterId?: string, requesterRoles?: AccountRole[]) {
    const brand = await this.findOne(id);

    const isBpoOnly = requesterRoles?.includes(AccountRole.bpo) &&
      !requesterRoles?.includes(AccountRole.admin) &&
      !requesterRoles?.includes(AccountRole.super_admin);

    if (isBpoOnly) {
      if (brand.ownerId !== requesterId) {
        throw new ForbiddenException('You can only edit brands you own');
      }
      if (dto.kaType !== undefined || dto.ownerId !== undefined) {
        throw new ForbiddenException('BPOs cannot change the KA type or owner of a brand');
      }
    }

    const { applicationId, ownerId, kaType, ...rest } = dto;
    const data: Prisma.BrandUpdateInput = { ...rest };

    // If ka_type changes, auto-reassign owner (unless ownerId is also being set manually)
    if (kaType && kaType !== brand.kaType && ownerId === undefined) {
      const newOwnerId = await this.assignOwner(kaType, brand.country);
      if (newOwnerId) {
        data.owner = { connect: { id: newOwnerId } };
      }
      data.kaType = kaType;
    } else if (kaType) {
      data.kaType = kaType;
    }

    // Manual OP override
    if (ownerId !== undefined) {
      data.owner = ownerId ? { connect: { id: ownerId } } : { disconnect: true };
    }

    // Handle application link/unlink
    if (applicationId !== undefined) {
      data.application = applicationId
        ? { connect: { id: applicationId } }
        : { disconnect: true };
    }

    return this.prisma.brand.update({ where: { id }, data, include: BRAND_INCLUDE });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.brand.update({
      where: { id },
      data: { deletedAt: new Date() },
      include: BRAND_INCLUDE,
    });
  }

  // ── BrandAssignmentRules ──────────────────────────────────────────────────

  findAllRules() {
    return this.prisma.brandAssignmentRule.findMany({
      include: {
        candidates: { include: { account: { select: { id: true, name: true, email: true } } } },
      },
      orderBy: [{ kaType: 'asc' }, { country: 'asc' }],
    });
  }

  async updateRule(id: string, modo: AssignmentMode) {
    const rule = await this.prisma.brandAssignmentRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Rule not found');
    return this.prisma.brandAssignmentRule.update({ where: { id }, data: { modo } });
  }

  async addRuleCandidate(ruleId: string, dto: AddRuleCandidateDto) {
    const rule = await this.prisma.brandAssignmentRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new NotFoundException('Rule not found');
    return this.prisma.brandAssignmentRuleAccount.create({
      data: { ruleId, accountId: dto.accountId },
    });
  }

  async removeRuleCandidate(ruleId: string, accountId: string) {
    return this.prisma.brandAssignmentRuleAccount.delete({
      where: { ruleId_accountId: { ruleId, accountId } },
    });
  }

  // ── Owner assignment ──────────────────────────────────────────────────────

  private async assignOwner(kaType: KaType, country: Country): Promise<string | null> {
    const rule = await this.prisma.brandAssignmentRule.findUnique({
      where: { kaType_country: { kaType, country } },
      include: { candidates: true },
    });

    if (!rule || !rule.candidates.length) return null;

    if (rule.modo === AssignmentMode.fixed) {
      return rule.candidates[0].accountId;
    }

    // round_robin: pick candidate with lowest rrCounter, increment atomically
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ account_id: string; contador_rr: number }[]>`
        SELECT bra.account_id, a.contador_rr
        FROM brand_assignment_rule_account bra
        JOIN account a ON a.id = bra.account_id
        WHERE bra.rule_id = ${rule.id}::uuid
        ORDER BY a.contador_rr ASC
        LIMIT 1
        FOR UPDATE OF a
      `;

      if (!rows.length) return null;
      const chosen = rows[0];

      await tx.account.update({
        where: { id: chosen.account_id },
        data: { rrCounter: { increment: 1 } },
      });

      return chosen.account_id;
    });
  }
}
