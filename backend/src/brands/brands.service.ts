import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountRol, AsignacionModo, Country, KaType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AddRuleCandidateDto } from './dto/add-rule-candidate.dto';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

const BRAND_INCLUDE = {
  responsable: { select: { id: true, nombre: true, email: true } },
  application: { select: { id: true, appId: true, appName: true, country: true } },
} as const;

@Injectable()
export class BrandsService {
  constructor(private prisma: PrismaService) {}

  // ── Brands ────────────────────────────────────────────────────────────────

  findAll(roles: AccountRol[], accountId: string) {
    const where: Prisma.BrandWhereInput = { deletedAt: null };
    if (roles.includes(AccountRol.bpo) && !roles.includes(AccountRol.admin) && !roles.includes(AccountRol.super_admin)) {
      where.responsableId = accountId;
    }
    return this.prisma.brand.findMany({ where, include: BRAND_INCLUDE, orderBy: { brandName: 'asc' } });
  }

  async findOne(id: string) {
    const brand = await this.prisma.brand.findUnique({ where: { id }, include: BRAND_INCLUDE });
    if (!brand || brand.deletedAt) throw new NotFoundException('Brand no encontrada');
    return brand;
  }

  async create(dto: CreateBrandDto, createdById: string) {
    const responsableId = await this.assignResponsable(dto.kaType, dto.country);
    return this.prisma.brand.create({
      data: { ...dto, responsableId, createdById },
      include: BRAND_INCLUDE,
    });
  }

  async update(id: string, dto: UpdateBrandDto) {
    const brand = await this.findOne(id);

    const data: Prisma.BrandUpdateInput = { ...dto };

    // Si cambia el ka_type, reasignar responsable
    if (dto.kaType && dto.kaType !== brand.kaType) {
      const newResponsableId = await this.assignResponsable(dto.kaType, brand.country);
      data.responsable = { connect: { id: newResponsableId } };
      delete (data as any).kaType;
      data.kaType = dto.kaType;
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
        candidatos: { include: { account: { select: { id: true, nombre: true, email: true } } } },
      },
      orderBy: [{ kaType: 'asc' }, { country: 'asc' }],
    });
  }

  async updateRule(id: string, modo: AsignacionModo) {
    const rule = await this.prisma.brandAssignmentRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Regla no encontrada');
    return this.prisma.brandAssignmentRule.update({ where: { id }, data: { modo } });
  }

  async addRuleCandidate(ruleId: string, dto: AddRuleCandidateDto) {
    const rule = await this.prisma.brandAssignmentRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new NotFoundException('Regla no encontrada');
    return this.prisma.brandAssignmentRuleAccount.create({
      data: { ruleId, accountId: dto.accountId },
    });
  }

  async removeRuleCandidate(ruleId: string, accountId: string) {
    return this.prisma.brandAssignmentRuleAccount.delete({
      where: { ruleId_accountId: { ruleId, accountId } },
    });
  }

  // ── Asignación de responsable ─────────────────────────────────────────────

  private async assignResponsable(kaType: KaType, country: Country): Promise<string> {
    const rule = await this.prisma.brandAssignmentRule.findUnique({
      where: { kaType_country: { kaType, country } },
      include: { candidatos: true },
    });

    if (!rule) throw new BadRequestException(`Sin regla de asignación para ${kaType}/${country}`);
    if (!rule.candidatos.length) throw new BadRequestException('La regla no tiene candidatos configurados');

    if (rule.modo === AsignacionModo.fijo) {
      return rule.candidatos[0].accountId;
    }

    // round_robin: pick candidate con menor contadorRr, incrementar atómicamente
    return this.prisma.$transaction(async (tx) => {
      // SELECT FOR UPDATE vía queryRaw para garantizar atomicidad
      const rows = await tx.$queryRaw<{ account_id: string; contador_rr: number }[]>`
        SELECT bra.account_id, a.contador_rr
        FROM brand_assignment_rule_account bra
        JOIN account a ON a.id = bra.account_id
        WHERE bra.rule_id = ${rule.id}::uuid
        ORDER BY a.contador_rr ASC
        LIMIT 1
        FOR UPDATE OF a
      `;

      if (!rows.length) throw new BadRequestException('Sin candidatos disponibles');
      const chosen = rows[0];

      await tx.account.update({
        where: { id: chosen.account_id },
        data: { contadorRr: { increment: 1 } },
      });

      return chosen.account_id;
    });
  }
}
