import { PrismaClient, AccountRol, KaType, Country, AsignacionModo } from '@prisma/client';
import { encrypt } from '../common/crypto.util';

const prisma = new PrismaClient();

async function main() {
  const encKey = process.env.APP_SECRET_ENCRYPTION_KEY;
  if (!encKey) throw new Error('APP_SECRET_ENCRYPTION_KEY no definida');

  // ── 1. Bootstrap: primer super_admin ─────────────────────────────────────
  const superAdmin = await prisma.account.upsert({
    where: { email: 'superadmin@didi-labs.com' },
    update: {},
    create: {
      nombre: 'Super Admin',
      email: 'superadmin@didi-labs.com',
      roles: [AccountRol.super_admin],
    },
  });
  console.log('✓ super_admin:', superAdmin.email);

  // ── 2. Section inicial ────────────────────────────────────────────────────
  const section = await prisma.section.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: { id: '00000000-0000-0000-0000-000000000001', nombre: 'Operaciones' },
  });
  console.log('✓ section:', section.nombre);

  // ── 3. Handlers del catálogo ──────────────────────────────────────────────
  const handlerNames = [
    'sync_menu',
    'validate_app_credentials',
    'enable_shop_online',
    'notify_integration_complete',
  ];
  for (const nombre of handlerNames) {
    await prisma.handler.upsert({ where: { nombre }, update: {}, create: { nombre } });
  }
  console.log('✓ handlers:', handlerNames.length);

  // ── 4. Webhooks de alerta ─────────────────────────────────────────────────
  const alertWebhook = await prisma.webhook.upsert({
    where: { id: '00000000-0000-0000-0000-000000000010' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000010',
      nombre: 'Alertas Sistema',
      url: process.env.ALERT_WEBHOOK_URL ?? 'http://localhost:9999/alert',
      esAlertas: true,
    },
  });
  console.log('✓ webhook alerta:', alertWebhook.nombre);

  // ── 5. Las 9 reglas de asignación (3 ka_type × 3 países) ─────────────────
  const rules: { kaType: KaType; country: Country; modo: AsignacionModo }[] = [
    { kaType: KaType.KA,  country: Country.CO, modo: AsignacionModo.fijo },
    { kaType: KaType.KA,  country: Country.MX, modo: AsignacionModo.fijo },
    { kaType: KaType.KA,  country: Country.CR, modo: AsignacionModo.fijo },
    { kaType: KaType.CKA, country: Country.CO, modo: AsignacionModo.round_robin },
    { kaType: KaType.CKA, country: Country.MX, modo: AsignacionModo.round_robin },
    { kaType: KaType.CKA, country: Country.CR, modo: AsignacionModo.round_robin },
    { kaType: KaType.SME, country: Country.CO, modo: AsignacionModo.round_robin },
    { kaType: KaType.SME, country: Country.MX, modo: AsignacionModo.round_robin },
    { kaType: KaType.SME, country: Country.CR, modo: AsignacionModo.round_robin },
  ];
  for (const rule of rules) {
    await prisma.brandAssignmentRule.upsert({
      where: { kaType_country: { kaType: rule.kaType, country: rule.country } },
      update: {},
      create: rule,
    });
  }
  console.log('✓ reglas de asignación:', rules.length);

  // ── 6. Datos de prueba (solo dev) ─────────────────────────────────────────
  if (process.env.NODE_ENV === 'production') {
    console.log('→ producción: omitiendo datos de prueba');
    return;
  }

  // Cuentas de prueba
  const admin = await prisma.account.upsert({
    where: { email: 'admin@didi-labs.com' },
    update: {},
    create: { nombre: 'Admin Ops', email: 'admin@didi-labs.com', roles: [AccountRol.admin], sectionId: section.id },
  });

  const bpo1 = await prisma.account.upsert({
    where: { email: 'bpo1@didi-labs.com' },
    update: {},
    create: { nombre: 'BPO Uno', email: 'bpo1@didi-labs.com', roles: [AccountRol.bpo], sectionId: section.id },
  });

  const bpo2 = await prisma.account.upsert({
    where: { email: 'bpo2@didi-labs.com' },
    update: {},
    create: { nombre: 'BPO Dos', email: 'bpo2@didi-labs.com', roles: [AccountRol.bpo], sectionId: section.id },
  });

  const user1 = await prisma.account.upsert({
    where: { email: 'user1@didi-labs.com' },
    update: {},
    create: { nombre: 'Usuario Uno', email: 'user1@didi-labs.com', roles: [AccountRol.user], sectionId: section.id },
  });
  console.log('✓ cuentas de prueba:', [admin.email, bpo1.email, bpo2.email, user1.email]);

  // Asignar BPOs a regla KA/CO
  const ruleKaCo = await prisma.brandAssignmentRule.findUnique({
    where: { kaType_country: { kaType: KaType.KA, country: Country.CO } },
  });
  if (ruleKaCo) {
    await prisma.brandAssignmentRuleAccount.upsert({
      where: { ruleId_accountId: { ruleId: ruleKaCo.id, accountId: bpo1.id } },
      update: {},
      create: { ruleId: ruleKaCo.id, accountId: bpo1.id },
    });
  }

  // Asignar BPOs al pool CKA/CO
  const ruleCkaCo = await prisma.brandAssignmentRule.findUnique({
    where: { kaType_country: { kaType: KaType.CKA, country: Country.CO } },
  });
  if (ruleCkaCo) {
    for (const bpo of [bpo1, bpo2]) {
      await prisma.brandAssignmentRuleAccount.upsert({
        where: { ruleId_accountId: { ruleId: ruleCkaCo.id, accountId: bpo.id } },
        update: {},
        create: { ruleId: ruleCkaCo.id, accountId: bpo.id },
      });
    }
  }

  // Application de prueba
  const app = await prisma.application.upsert({
    where: { appId: 'APP-CO-001' },
    update: {},
    create: {
      appId: 'APP-CO-001',
      appName: 'DiDi Colombia Demo',
      country: Country.CO,
      appSecret: encrypt('secret-demo-123', encKey),
      createdById: superAdmin.id,
    },
  });

  // Brand de prueba
  const brand = await prisma.brand.upsert({
    where: { brandId: 'BRAND-CO-001' },
    update: {},
    create: {
      brandId: 'BRAND-CO-001',
      brandName: 'Burger Demo CO',
      country: Country.CO,
      kaType: KaType.KA,
      category: 'Burgers',
      responsableId: bpo1.id,
      applicationId: app.id,
      createdById: superAdmin.id,
    },
  });
  console.log('✓ brand de prueba:', brand.brandName);

  // Shops de prueba
  for (let i = 1; i <= 3; i++) {
    await prisma.shop.upsert({
      where: { shopId: `SHOP-CO-00${i}` },
      update: {},
      create: {
        shopId: `SHOP-CO-00${i}`,
        appShopId: `S00${i}`,
        brandId: brand.id,
        city: 'Bogotá',
        createdById: superAdmin.id,
      },
    });
  }
  console.log('✓ shops de prueba: 3');

  // TaskType de prueba con un step manual y uno automático
  const syncHandler = await prisma.handler.findUnique({ where: { nombre: 'sync_menu' } });

  const taskType = await prisma.taskType.upsert({
    where: { id: '00000000-0000-0000-0000-000000000020' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000020',
      sectionId: section.id,
      nombre: 'Integración de marca',
      descripcion: 'Flujo completo para integrar una nueva marca en la plataforma',
      programable: true,
    },
  });

  const step1 = await prisma.stepDefinition.upsert({
    where: { taskTypeId_orden: { taskTypeId: taskType.id, orden: 1 } },
    update: {},
    create: {
      taskTypeId: taskType.id,
      nombre: 'Validar credenciales',
      orden: 1,
      tipoEjecucion: 'manual_interno',
      estrategiaAsignacion: 'round_robin',
    },
  });

  if (syncHandler) {
    await prisma.stepDefinition.upsert({
      where: { taskTypeId_orden: { taskTypeId: taskType.id, orden: 2 } },
      update: {},
      create: {
        taskTypeId: taskType.id,
        nombre: 'Sincronizar menú',
        orden: 2,
        tipoEjecucion: 'automatico',
        estrategiaAsignacion: 'fijo',
        handlerId: syncHandler.id,
      },
    });
  }

  // Agregar BPOs como candidatos al step 1
  for (const bpo of [bpo1, bpo2]) {
    await prisma.stepDefinitionAccount.upsert({
      where: { stepDefinitionId_accountId: { stepDefinitionId: step1.id, accountId: bpo.id } },
      update: {},
      create: { stepDefinitionId: step1.id, accountId: bpo.id },
    });
  }

  console.log('✓ task type de prueba:', taskType.nombre);
  console.log('\n✅ Seed completado');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
