import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type Catalog = Pick<Prisma.TransactionClient, 'brand' | 'application' | 'sftpApplication'>;
type Links = { brandId: string; applicationId: string; sftpApplicationId: string };

// Resolve the catalog again when a queued run starts, so rotations and revocations apply.
export async function resolveSftpApiApplications(prisma: Catalog, links: Links) {
  if (!links.applicationId || !links.sftpApplicationId) {
    throw new BadRequestException('Selecciona las aplicaciones API y SFTP en la configuración');
  }
  const [brand, application, sftpApplication] = await Promise.all([
    prisma.brand.findFirst({ where: { id: links.brandId, deletedAt: null }, select: { country: true } }),
    prisma.application.findFirst({ where: { id: links.applicationId, deletedAt: null } }),
    prisma.sftpApplication.findFirst({ where: { id: links.sftpApplicationId, active: true, deletedAt: null } }),
  ]);
  if (!brand) throw new BadRequestException('Selecciona una marca del catálogo');
  if (!application) throw new BadRequestException('La aplicación API DiDi Food no está disponible');
  if (application.country !== brand.country) throw new BadRequestException('La aplicación API debe pertenecer al país de la marca');
  if (!sftpApplication) throw new BadRequestException('La aplicación SFTP no está disponible o está inactiva');
  if (sftpApplication.brandId && sftpApplication.brandId !== links.brandId) {
    throw new BadRequestException('La aplicación SFTP pertenece a otra marca');
  }
  return { application, sftpApplication };
}
