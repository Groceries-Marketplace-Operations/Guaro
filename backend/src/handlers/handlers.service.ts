import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HandlersService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.handler.findMany({ orderBy: { nombre: 'asc' } });
  }

  create(nombre: string) {
    return this.prisma.handler.create({ data: { nombre } });
  }

  remove(id: string) {
    return this.prisma.handler.delete({ where: { id } });
  }
}
