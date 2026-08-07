import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { ReplaceBrandMenuCategoriesDto } from './dto/replace-brand-menu-categories.dto';

@Injectable()
export class BrandMenuCategoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(brandId: string) {
    await this.assertBrand(brandId);
    return this.prisma.brandMenuCategory.findMany({
      where: { brandId },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    });
  }

  async replace(brandId: string, dto: ReplaceBrandMenuCategoriesDto) {
    await this.assertBrand(brandId);
    const ids = dto.categories.map(category => category.categoryId.trim());
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Category IDs cannot be repeated');

    await this.prisma.$transaction(async tx => {
      await tx.brandMenuCategory.deleteMany({ where: { brandId } });
      await tx.brandMenuCategory.createMany({
        data: dto.categories.map((category, index) => ({
          brandId,
          categoryId: category.categoryId.trim(),
          name: category.name.trim(),
          order: category.order ?? index,
          active: category.active ?? true,
        })),
      });
    });
    return this.list(brandId);
  }

  async template(brandId: string): Promise<Buffer> {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { brandName: true, country: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    const categories = await this.prisma.brandMenuCategory.findMany({
      where: { brandId, active: true },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    });
    if (!categories.length) throw new BadRequestException('Configure at least one active menu category for this brand first');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Tequila 1.0';
    const instructions = workbook.addWorksheet('Instructions');
    instructions.addRows([
      ['Commercial Grocery Menu Upload'],
      ['Brand', brand.brandName],
      ['Country', brand.country],
      ['Instructions', 'Fill Items only. Do not rename sheets or headers. UPC/SKU becomes app_item_id and status is always 1.'],
      ['Prices', 'Enter visible currency values; the system converts them to DiDi cents. activity_price is optional.'],
      ['Image', 'Use a public HTTPS image URL.'],
    ]);
    instructions.getColumn(1).width = 22;
    instructions.getColumn(2).width = 100;
    instructions.getRow(1).font = { bold: true, size: 16, color: { argb: 'FFFF5A00' } };

    const categorySheet = workbook.addWorksheet('Categories');
    categorySheet.columns = [
      { header: 'category_id', key: 'categoryId', width: 28 },
      { header: 'category_name', key: 'name', width: 48 },
    ];
    categories.forEach(category => categorySheet.addRow({ categoryId: category.categoryId, name: category.name }));

    const items = workbook.addWorksheet('Items');
    items.columns = [
      { header: 'category_id', key: 'categoryId', width: 28 },
      { header: 'UPC_SKU', key: 'upc', width: 24 },
      { header: 'price', key: 'price', width: 16 },
      { header: 'activity_price', key: 'activityPrice', width: 18 },
      { header: 'image_url', key: 'imageUrl', width: 70 },
      { header: 'item_name_optional', key: 'name', width: 44 },
    ];
    items.getColumn(2).numFmt = '@';
    for (let row = 2; row <= 3001; row += 1) {
      items.getCell(`A${row}`).dataValidation = {
        type: 'list', allowBlank: false,
        formulae: [`Categories!$A$2:$A$${categories.length + 1}`],
      };
    }
    for (const sheet of [categorySheet, items]) {
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.autoFilter = { from: 'A1', to: sheet === items ? 'F1' : 'B1' };
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF5A00' } };
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  private async assertBrand(brandId: string) {
    const brand = await this.prisma.brand.findFirst({ where: { id: brandId, deletedAt: null }, select: { id: true } });
    if (!brand) throw new NotFoundException('Brand not found');
  }
}
