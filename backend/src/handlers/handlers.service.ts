import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HandlersService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.handler.findMany({ orderBy: { name: 'asc' } });
  }

  create(name: string) {
    return this.prisma.handler.create({ data: { name } });
  }

  remove(id: string) {
    return this.prisma.handler.delete({ where: { id } });
  }
}
