import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { UpdateWebhookDto } from './dto/update-webhook.dto';

@Injectable()
export class WebhooksService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.webhook.findMany({ orderBy: { nombre: 'asc' } });
  }

  create(dto: CreateWebhookDto) {
    return this.prisma.webhook.create({ data: dto });
  }

  async update(id: string, dto: UpdateWebhookDto) {
    await this.assertExists(id);
    return this.prisma.webhook.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.assertExists(id);
    return this.prisma.webhook.delete({ where: { id } });
  }

  private async assertExists(id: string) {
    const w = await this.prisma.webhook.findUnique({ where: { id } });
    if (!w) throw new NotFoundException('Webhook no encontrado');
  }
}
