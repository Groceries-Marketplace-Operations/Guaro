import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ParsedPromotionRow } from './promotion-file.util';

@Injectable()
export class StorePromotionStorageService {
  constructor(private readonly prisma: PrismaService) {}

  async replace(
    sftpApplicationId: string,
    shopExternalId: string,
    sourceFile: string,
    sourceModifiedAt: Date,
    values: ParsedPromotionRow[],
  ) {
    const unique = [...new Map(values.map(value => [`${value.activityId}\u0000${value.sku}`, value])).values()];
    const writes: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.storePromotion.deleteMany({ where: { sftpApplicationId, shopExternalId } }),
    ];
    if (unique.length > 0) {
      writes.push(this.prisma.storePromotion.createMany({
        data: unique.map(value => ({
          sftpApplicationId,
          shopExternalId,
          activityId: value.activityId,
          activityName: value.activityName,
          startDate: value.startDate,
          endDate: value.endDate,
          activityType: value.activityType,
          sku: value.sku,
          discountAmount: value.discountAmount,
          discountPercentage: value.discountPercentage,
          buyNum: value.buyNum,
          getNum: value.getNum,
          bxgyX: value.bxgyX,
          bxgyY: value.bxgyY,
          actionType: value.actionType,
          sourceFile,
          sourceModifiedAt,
          rawData: value.rawData as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      }));
    }
    writes.push(this.prisma.promotionShopSnapshot.upsert({
      where: { sftpApplicationId_shopExternalId: { sftpApplicationId, shopExternalId } },
      create: { sftpApplicationId, shopExternalId, sourceFile, sourceModifiedAt, rowCount: unique.length },
      update: { sourceFile, sourceModifiedAt, rowCount: unique.length, fetchedAt: new Date() },
    }));
    await this.prisma.$transaction(writes);
    return unique.length;
  }
}
