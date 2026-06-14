import { PrismaClient, AccountRole, KaType, Country, AssignmentMode } from '@prisma/client';
import { encrypt } from '../common/crypto.util';

const prisma = new PrismaClient();

async function main() {
  const encKey = process.env.APP_SECRET_ENCRYPTION_KEY;
  if (!encKey) throw new Error('APP_SECRET_ENCRYPTION_KEY not defined');

  // ── 1. Bootstrap: first super_admin ──────────────────────────────────────
  const superAdmin = await prisma.account.upsert({
    where: { email: 'superadmin@didi-labs.com' },
    update: {},
    create: {
      name: 'Super Admin',
      email: 'superadmin@didi-labs.com',
      roles: [AccountRole.super_admin],
    },
  });
  console.log('✓ super_admin:', superAdmin.email);

  // ── 2. Initial section ───────────────────────────────────────────────────
  const section = await prisma.section.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: { id: '00000000-0000-0000-0000-000000000001', name: 'Operations' },
  });
  console.log('✓ section:', section.name);

  // ── 3. Catalog handlers ───────────────────────────────────────────────────
  const handlerNames = [
    'sync_menu',
    'validate_app_credentials',
    'enable_shop_online',
    'notify_integration_complete',
  ];
  for (const name of handlerNames) {
    await prisma.handler.upsert({ where: { name }, update: {}, create: { name } });
  }
  console.log('✓ handlers:', handlerNames.length);

  // ── 4. Alert webhooks ─────────────────────────────────────────────────────
  const alertWebhook = await prisma.webhook.upsert({
    where: { id: '00000000-0000-0000-0000-000000000010' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000010',
      name: 'System Alerts',
      url: process.env.ALERT_WEBHOOK_URL ?? 'http://localhost:9999/alert',
      isAlerts: true,
    },
  });
  console.log('✓ alert webhook:', alertWebhook.name);

  // ── 5. The 9 assignment rules (3 ka_type × 3 countries) ──────────────────
  const rules: { kaType: KaType; country: Country; modo: AssignmentMode }[] = [
    { kaType: KaType.KA,  country: Country.CO, modo: AssignmentMode.fixed },
    { kaType: KaType.KA,  country: Country.MX, modo: AssignmentMode.fixed },
    { kaType: KaType.KA,  country: Country.CR, modo: AssignmentMode.fixed },
    { kaType: KaType.CKA, country: Country.CO, modo: AssignmentMode.round_robin },
    { kaType: KaType.CKA, country: Country.MX, modo: AssignmentMode.round_robin },
    { kaType: KaType.CKA, country: Country.CR, modo: AssignmentMode.round_robin },
    { kaType: KaType.SME, country: Country.CO, modo: AssignmentMode.round_robin },
    { kaType: KaType.SME, country: Country.MX, modo: AssignmentMode.round_robin },
    { kaType: KaType.SME, country: Country.CR, modo: AssignmentMode.round_robin },
  ];
  for (const rule of rules) {
    await prisma.brandAssignmentRule.upsert({
      where: { kaType_country: { kaType: rule.kaType, country: rule.country } },
      update: {},
      create: rule,
    });
  }
  console.log('✓ assignment rules:', rules.length);

  // ── 6. Test data (dev only) ───────────────────────────────────────────────
  if (process.env.NODE_ENV === 'production') {
    console.log('→ production: skipping test data');
    return;
  }

  // Test accounts
  const admin = await prisma.account.upsert({
    where: { email: 'admin@didi-labs.com' },
    update: {},
    create: { name: 'Admin Ops', email: 'admin@didi-labs.com', roles: [AccountRole.admin], sectionId: section.id },
  });

  const bpo1 = await prisma.account.upsert({
    where: { email: 'bpo1@didi-labs.com' },
    update: {},
    create: { name: 'BPO One', email: 'bpo1@didi-labs.com', roles: [AccountRole.bpo], sectionId: section.id },
  });

  const bpo2 = await prisma.account.upsert({
    where: { email: 'bpo2@didi-labs.com' },
    update: {},
    create: { name: 'BPO Two', email: 'bpo2@didi-labs.com', roles: [AccountRole.bpo], sectionId: section.id },
  });

  const user1 = await prisma.account.upsert({
    where: { email: 'user1@didi-labs.com' },
    update: {},
    create: { name: 'User One', email: 'user1@didi-labs.com', roles: [AccountRole.user], sectionId: section.id },
  });
  console.log('✓ test accounts:', [admin.email, bpo1.email, bpo2.email, user1.email]);

  // Assign BPOs to rule KA/CO
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

  // Assign BPOs to pool CKA/CO
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

  // Sample application
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

  // Sample brand
  const brand = await prisma.brand.upsert({
    where: { brandId: 'BRAND-CO-001' },
    update: {},
    create: {
      brandId: 'BRAND-CO-001',
      brandName: 'Burger Demo CO',
      country: Country.CO,
      kaType: KaType.KA,
      category: 'Burgers',
      ownerId: bpo1.id,
      applicationId: app.id,
      createdById: superAdmin.id,
    },
  });
  console.log('✓ sample brand:', brand.brandName);

  // Sample shops
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
  console.log('✓ sample shops: 3');

  // Sample task type with one manual and one automatic step
  const syncHandler = await prisma.handler.findUnique({ where: { name: 'sync_menu' } });

  const taskType = await prisma.taskType.upsert({
    where: { id: '00000000-0000-0000-0000-000000000020' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000020',
      sectionId: section.id,
      name: 'Brand Integration',
      descripcion: 'Complete flow to integrate a new brand on the platform',
      schedulable: true,
    },
  });

  const step1 = await prisma.stepDefinition.upsert({
    where: { taskTypeId_order: { taskTypeId: taskType.id, order: 1 } },
    update: {},
    create: {
      taskTypeId: taskType.id,
      name: 'Validate credentials',
      order: 1,
      executionType: 'manual_internal',
      assignmentStrategy: 'round_robin',
    },
  });

  if (syncHandler) {
    await prisma.stepDefinition.upsert({
      where: { taskTypeId_order: { taskTypeId: taskType.id, order: 2 } },
      update: {},
      create: {
        taskTypeId: taskType.id,
        name: 'Sync menu',
        order: 2,
        executionType: 'automatic',
        assignmentStrategy: 'fixed',
        handlerId: syncHandler.id,
      },
    });
  }

  // Add BPOs as candidates for step 1
  for (const bpo of [bpo1, bpo2]) {
    await prisma.stepDefinitionAccount.upsert({
      where: { stepDefinitionId_accountId: { stepDefinitionId: step1.id, accountId: bpo.id } },
      update: {},
      create: { stepDefinitionId: step1.id, accountId: bpo.id },
    });
  }

  console.log('✓ sample task type:', taskType.name);
  console.log('\n✅ Seed complete');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
