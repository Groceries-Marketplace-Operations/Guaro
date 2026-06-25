import {
  PrismaClient,
  AccountRole,
  KaType,
  Country,
  AssignmentMode,
  WebhookEvent,
  FormFieldTipo,
  TaskStatus,
  StepStatus,
  StepFailureReason,
} from '@prisma/client';
import { encrypt } from '../common/crypto.util';

const prisma = new PrismaClient();

// Helpers
const hoursAgo  = (h: number) => new Date(Date.now() - h * 3_600_000);
const hoursFrom = (h: number) => new Date(Date.now() + h * 3_600_000);

async function main() {
  const encKey = process.env.APP_SECRET_ENCRYPTION_KEY;
  if (!encKey) throw new Error('APP_SECRET_ENCRYPTION_KEY not defined');

  // ── 1. Bootstrap: super_admin ─────────────────────────────────────────────
  const superAdmin = await prisma.account.upsert({
    where: { email: 'superadmin@didi-labs.com' },
    update: {},
    create: { name: 'Super Admin', email: 'superadmin@didi-labs.com', roles: [AccountRole.super_admin] },
  });
  console.log('✓ super_admin:', superAdmin.email);

  // ── 2. Sections ───────────────────────────────────────────────────────────
  const section = await prisma.section.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: { id: '00000000-0000-0000-0000-000000000001', name: 'Operations' },
  });
  const section2 = await prisma.section.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: {},
    create: { id: '00000000-0000-0000-0000-000000000002', name: 'Growth' },
  });
  console.log('✓ sections:', section.name, '+', section2.name);

  // ── 3. Handlers ───────────────────────────────────────────────────────────
  const handlerNames = [
    'sync_menu',
    'validate_app_credentials',
    'enable_shop_online',
    'notify_integration_complete',
    'debug_echo',
    'schedule_update_permanent',
    'schedule_update_dates',
  ];
  for (const name of handlerNames) {
    await prisma.handler.upsert({ where: { name }, update: {}, create: { name } });
  }
  console.log('✓ handlers:', handlerNames.length);

  // ── 4. Webhooks ───────────────────────────────────────────────────────────
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
  const devWebhook = await prisma.webhook.upsert({
    where: { id: '00000000-0000-0000-0000-000000000011' },
    update: { url: 'http://localhost:3000/dev/webhook-log' },
    create: {
      id: '00000000-0000-0000-0000-000000000011',
      name: 'Dev Webhook Log',
      url: 'http://localhost:3000/dev/webhook-log',
      isAlerts: false,
    },
  });
  console.log('✓ webhooks:', alertWebhook.name, '+', devWebhook.name);

  // ── 5. Brand assignment rules (3 ka_type × 3 countries) ──────────────────
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

  // ── 6. App config options ─────────────────────────────────────────────────
  const configOptions = [
    { category: 'country',          value: 'CO',                      label: 'Colombia',                 order: 0 },
    { category: 'country',          value: 'MX',                      label: 'México',                   order: 1 },
    { category: 'country',          value: 'CR',                      label: 'Costa Rica',               order: 2 },
    { category: 'ka_type',          value: 'KA',                      label: 'KA (Key Account)',          order: 0 },
    { category: 'ka_type',          value: 'CKA',                     label: 'CKA (Chain Key Account)',   order: 1 },
    { category: 'ka_type',          value: 'SME',                     label: 'SME (Small & Medium)',      order: 2 },
    { category: 'menu_integration', value: 'api',                     label: 'API',                      order: 0 },
    { category: 'menu_integration', value: 'api_whitelist',           label: 'API Whitelist',            order: 1 },
    { category: 'menu_integration', value: 'sftp',                    label: 'SFTP',                     order: 2 },
    { category: 'menu_integration', value: 'spreadsheets',            label: 'Spreadsheets',             order: 3 },
    { category: 'menu_integration', value: 'bapp',                    label: 'BAPP',                     order: 4 },
    { category: 'picking_mode',     value: 'merchant_picking_bapp',   label: 'Merchant Picking (BAPP)',  order: 0 },
    { category: 'picking_mode',     value: 'merchant_picking_dapp',   label: 'Merchant Picking (DAPP)',  order: 1 },
    { category: 'picking_mode',     value: 'dos_en_uno',              label: 'Dos en Uno',               order: 2 },
    { category: 'payment_mode',     value: 'food_mode',               label: 'Food Mode',                order: 0 },
    { category: 'payment_mode',     value: 'prepaid_card',            label: 'Prepaid Card',             order: 1 },
    { category: 'payment_mode',     value: 'qr_code',                 label: 'QR Code',                  order: 2 },
    { category: 'shop_status',      value: 'lead',                    label: 'Lead',                     order: 0 },
    { category: 'shop_status',      value: 'application',             label: 'Application',              order: 1 },
    { category: 'shop_status',      value: 'integrated',              label: 'Integrated',               order: 2 },
    { category: 'shop_status',      value: 'online',                  label: 'Online',                   order: 3 },
  ];
  for (const opt of configOptions) {
    await prisma.appConfigOption.upsert({
      where: { category_value: { category: opt.category, value: opt.value } },
      update: {},
      create: { ...opt, active: true },
    });
  }
  console.log('✓ app config options:', configOptions.length);

  // ── 7. Test data (dev only) ───────────────────────────────────────────────
  if (process.env.NODE_ENV === 'production') {
    console.log('→ production: skipping test data');
    return;
  }

  // ── Accounts ──────────────────────────────────────────────────────────────
  const admin = await prisma.account.upsert({
    where: { email: 'admin@didi-labs.com' },
    update: { deletedAt: null, roles: [AccountRole.admin], sectionId: section.id },
    create: { name: 'Admin Ops', email: 'admin@didi-labs.com', roles: [AccountRole.admin], sectionId: section.id },
  });
  const adminGrowth = await prisma.account.upsert({
    where: { email: 'admin.growth@didi-labs.com' },
    update: { deletedAt: null, roles: [AccountRole.admin], sectionId: section2.id },
    create: { name: 'Admin Growth', email: 'admin.growth@didi-labs.com', roles: [AccountRole.admin], sectionId: section2.id },
  });
  const director = await prisma.account.upsert({
    where: { email: 'director@didi-labs.com' },
    update: { deletedAt: null, roles: [AccountRole.director] },
    create: { name: 'Director General', email: 'director@didi-labs.com', roles: [AccountRole.director] },
  });
  const bpo1 = await prisma.account.upsert({
    where: { email: 'bpo1@didi-labs.com' },
    update: { deletedAt: null },
    create: { name: 'BPO One', email: 'bpo1@didi-labs.com', roles: [AccountRole.bpo], sectionId: section.id },
  });
  const bpo2 = await prisma.account.upsert({
    where: { email: 'bpo2@didi-labs.com' },
    update: { deletedAt: null },
    create: { name: 'BPO Two', email: 'bpo2@didi-labs.com', roles: [AccountRole.bpo], sectionId: section.id },
  });
  const bpo3 = await prisma.account.upsert({
    where: { email: 'bpo3@didi-labs.com' },
    update: { deletedAt: null },
    create: { name: 'BPO Three', email: 'bpo3@didi-labs.com', roles: [AccountRole.bpo], sectionId: section.id },
  });
  const bpo4 = await prisma.account.upsert({
    where: { email: 'bpo4@didi-labs.com' },
    update: { deletedAt: null },
    create: { name: 'BPO Four', email: 'bpo4@didi-labs.com', roles: [AccountRole.bpo], sectionId: section2.id },
  });
  const bpo5 = await prisma.account.upsert({
    where: { email: 'bpo5@didi-labs.com' },
    update: { deletedAt: null },
    create: { name: 'BPO Five', email: 'bpo5@didi-labs.com', roles: [AccountRole.bpo], sectionId: section2.id },
  });
  const user1 = await prisma.account.upsert({
    where: { email: 'user1@didi-labs.com' },
    update: { deletedAt: null },
    create: { name: 'User One', email: 'user1@didi-labs.com', roles: [AccountRole.user], sectionId: section.id },
  });
  const user2 = await prisma.account.upsert({
    where: { email: 'user2@didi-labs.com' },
    update: { deletedAt: null },
    create: { name: 'User Two', email: 'user2@didi-labs.com', roles: [AccountRole.user], sectionId: section.id },
  });
  const user3 = await prisma.account.upsert({
    where: { email: 'user3@didi-labs.com' },
    update: { deletedAt: null },
    create: { name: 'User Three', email: 'user3@didi-labs.com', roles: [AccountRole.user], sectionId: section2.id },
  });
  console.log('✓ accounts: 12 test accounts');

  // ── Assignment rule candidates ─────────────────────────────────────────────
  const ruleKaCo  = await prisma.brandAssignmentRule.findUnique({ where: { kaType_country: { kaType: KaType.KA,  country: Country.CO } } });
  const ruleKaMx  = await prisma.brandAssignmentRule.findUnique({ where: { kaType_country: { kaType: KaType.KA,  country: Country.MX } } });
  const ruleCkaCo = await prisma.brandAssignmentRule.findUnique({ where: { kaType_country: { kaType: KaType.CKA, country: Country.CO } } });
  const ruleCkaCr = await prisma.brandAssignmentRule.findUnique({ where: { kaType_country: { kaType: KaType.CKA, country: Country.CR } } });
  const ruleSmeCo = await prisma.brandAssignmentRule.findUnique({ where: { kaType_country: { kaType: KaType.SME, country: Country.CO } } });

  const ruleAssignments = [
    { rule: ruleKaCo,  accountId: bpo1.id },
    { rule: ruleKaMx,  accountId: bpo4.id },
    { rule: ruleCkaCo, accountId: bpo1.id },
    { rule: ruleCkaCo, accountId: bpo2.id },
    { rule: ruleCkaCr, accountId: bpo5.id },
    { rule: ruleSmeCo, accountId: bpo2.id },
    { rule: ruleSmeCo, accountId: bpo3.id },
  ];
  for (const { rule, accountId } of ruleAssignments) {
    if (!rule) continue;
    await prisma.brandAssignmentRuleAccount.upsert({
      where: { ruleId_accountId: { ruleId: rule.id, accountId } },
      update: {},
      create: { ruleId: rule.id, accountId },
    });
  }
  console.log('✓ rule candidates assigned');

  // ── Applications ──────────────────────────────────────────────────────────
  const appCo1 = await prisma.application.upsert({
    where: { appId: 'APP-CO-001' },
    update: {},
    create: { appId: 'APP-CO-001', appName: 'DiDi Colombia KA', country: Country.CO, appSecret: encrypt('secret-co-001', encKey), createdById: superAdmin.id },
  });
  const appCo2 = await prisma.application.upsert({
    where: { appId: 'APP-CO-002' },
    update: {},
    create: { appId: 'APP-CO-002', appName: 'DiDi Colombia CKA', country: Country.CO, appSecret: encrypt('secret-co-002', encKey), createdById: superAdmin.id },
  });
  const appMx1 = await prisma.application.upsert({
    where: { appId: 'APP-MX-001' },
    update: {},
    create: { appId: 'APP-MX-001', appName: 'DiDi México KA', country: Country.MX, appSecret: encrypt('secret-mx-001', encKey), createdById: superAdmin.id },
  });
  console.log('✓ applications: 3');

  // ── Brands ────────────────────────────────────────────────────────────────
  const brandBurger = await prisma.brand.upsert({
    where: { brandId: 'BRAND-CO-001' },
    update: {},
    create: { brandId: 'BRAND-CO-001', brandName: 'Burger Demo CO', country: Country.CO, kaType: KaType.KA, category: 'Burgers', ownerId: bpo1.id, applicationId: appCo1.id, createdById: superAdmin.id },
  });
  const brandPizza = await prisma.brand.upsert({
    where: { brandId: 'BRAND-CO-002' },
    update: {},
    create: { brandId: 'BRAND-CO-002', brandName: 'Pizza Express CO', country: Country.CO, kaType: KaType.CKA, category: 'Pizza', ownerId: bpo2.id, applicationId: appCo2.id, createdById: superAdmin.id },
  });
  const brandTacos = await prisma.brand.upsert({
    where: { brandId: 'BRAND-MX-001' },
    update: {},
    create: { brandId: 'BRAND-MX-001', brandName: 'Tacos El Rey MX', country: Country.MX, kaType: KaType.KA, category: 'Mexican', ownerId: bpo4.id, applicationId: appMx1.id, createdById: superAdmin.id },
  });
  const brandSushi = await prisma.brand.upsert({
    where: { brandId: 'BRAND-CO-003' },
    update: {},
    create: { brandId: 'BRAND-CO-003', brandName: 'Sushi Fusion CO', country: Country.CO, kaType: KaType.SME, category: 'Japanese', ownerId: bpo3.id, createdById: superAdmin.id },
  });
  const brandCoffee = await prisma.brand.upsert({
    where: { brandId: 'BRAND-CR-001' },
    update: {},
    create: { brandId: 'BRAND-CR-001', brandName: 'Coffee Central CR', country: Country.CR, kaType: KaType.CKA, category: 'Cafe', ownerId: bpo5.id, createdById: superAdmin.id },
  });
  console.log('✓ brands: 5');

  // ── Shops ─────────────────────────────────────────────────────────────────
  const shopsSeed = [
    // Burger Demo CO — 3 tiendas (online)
    { shopId: 'SHOP-CO-001', appShopId: 'S001', brandId: brandBurger.id, city: 'Bogotá',    status: 'online'      as const },
    { shopId: 'SHOP-CO-002', appShopId: 'S002', brandId: brandBurger.id, city: 'Medellín',  status: 'online'      as const },
    { shopId: 'SHOP-CO-003', appShopId: 'S003', brandId: brandBurger.id, city: 'Cali',      status: 'integrated'  as const },
    // Pizza Express CO — 4 tiendas (mixed)
    { shopId: 'SHOP-CO-004', appShopId: 'P001', brandId: brandPizza.id,  city: 'Bogotá',    status: 'online'      as const },
    { shopId: 'SHOP-CO-005', appShopId: 'P002', brandId: brandPizza.id,  city: 'Bogotá',    status: 'integrated'  as const },
    { shopId: 'SHOP-CO-006', appShopId: 'P003', brandId: brandPizza.id,  city: 'Medellín',  status: 'application' as const },
    { shopId: 'SHOP-CO-007', appShopId: 'P004', brandId: brandPizza.id,  city: 'Cali',      status: 'lead'        as const },
    // Tacos El Rey MX — 2 tiendas
    { shopId: 'SHOP-MX-001', appShopId: 'T001', brandId: brandTacos.id,  city: 'CDMX',      status: 'application' as const },
    { shopId: 'SHOP-MX-002', appShopId: 'T002', brandId: brandTacos.id,  city: 'Monterrey', status: 'lead'        as const },
    // Sushi Fusion CO — 3 tiendas (en proceso)
    { shopId: 'SHOP-CO-008', appShopId: 'SU01', brandId: brandSushi.id,  city: 'Bogotá',    status: 'application' as const },
    { shopId: 'SHOP-CO-009', appShopId: 'SU02', brandId: brandSushi.id,  city: 'Bogotá',    status: 'lead'        as const },
    { shopId: 'SHOP-CO-010', appShopId: 'SU03', brandId: brandSushi.id,  city: 'Pereira',   status: 'lead'        as const },
    // Coffee Central CR — 2 tiendas
    { shopId: 'SHOP-CR-001', appShopId: 'C001', brandId: brandCoffee.id, city: 'San José',  status: 'lead'        as const },
    { shopId: 'SHOP-CR-002', appShopId: 'C002', brandId: brandCoffee.id, city: 'Heredia',   status: 'lead'        as const },
  ];
  for (const s of shopsSeed) {
    await prisma.shop.upsert({
      where: { shopId: s.shopId },
      update: { status: s.status },
      create: { ...s, createdById: superAdmin.id },
    });
  }
  console.log('✓ shops:', shopsSeed.length);

  // ── Task Types ─────────────────────────────────────────────────────────────
  const syncHandler     = await prisma.handler.findUnique({ where: { name: 'sync_menu' } });
  const validateHandler = await prisma.handler.findUnique({ where: { name: 'validate_app_credentials' } });
  const enableHandler   = await prisma.handler.findUnique({ where: { name: 'enable_shop_online' } });
  const debugHandler    = await prisma.handler.findUnique({ where: { name: 'debug_echo' } });

  // ─── TT1: Brand Integration (Ops, schedulable) ────────────────────────────
  const ttIntegration = await prisma.taskType.upsert({
    where: { id: '00000000-0000-0000-0000-000000000020' },
    update: { active: true },
    create: {
      id: '00000000-0000-0000-0000-000000000020',
      sectionId: section.id,
      name: 'Brand Integration',
      descripcion: 'Complete flow to integrate a new brand: validate credentials, sync menu, enable shops.',
      schedulable: true,
    },
  });
  // Steps
  const ttIntStep1 = await prisma.stepDefinition.upsert({
    where: { taskTypeId_order: { taskTypeId: ttIntegration.id, order: 1 } },
    update: {},
    create: { taskTypeId: ttIntegration.id, name: 'Validate credentials', order: 1, executionType: 'manual_internal', assignmentStrategy: 'round_robin' },
  });
  await prisma.stepDefinition.upsert({
    where: { taskTypeId_order: { taskTypeId: ttIntegration.id, order: 2 } },
    update: {},
    create: { taskTypeId: ttIntegration.id, name: 'Sync menu', order: 2, executionType: syncHandler ? 'automatic' : 'manual_internal', assignmentStrategy: 'fixed', handlerId: syncHandler?.id },
  });
  const ttIntStep3 = await prisma.stepDefinition.upsert({
    where: { taskTypeId_order: { taskTypeId: ttIntegration.id, order: 3 } },
    update: {},
    create: { taskTypeId: ttIntegration.id, name: 'Enable shops online', order: 3, executionType: 'manual_external', assignmentStrategy: 'round_robin' },
  });
  // Candidates step 1 y 3
  for (const bpo of [bpo1, bpo2, bpo3]) {
    for (const step of [ttIntStep1, ttIntStep3]) {
      await prisma.stepDefinitionAccount.upsert({
        where: { stepDefinitionId_accountId: { stepDefinitionId: step.id, accountId: bpo.id } },
        update: {},
        create: { stepDefinitionId: step.id, accountId: bpo.id },
      });
    }
  }
  // Webhooks step 1
  await prisma.stepWebhook.upsert({
    where: { stepDefinitionId_webhookId: { stepDefinitionId: ttIntStep1.id, webhookId: devWebhook.id } },
    update: { events: [WebhookEvent.on_start, WebhookEvent.on_complete, WebhookEvent.on_fail] },
    create: { stepDefinitionId: ttIntStep1.id, webhookId: devWebhook.id, events: [WebhookEvent.on_start, WebhookEvent.on_complete, WebhookEvent.on_fail] },
  });
  // Form field: select brand
  const ffIntBrand = await prisma.formField.findFirst({ where: { taskTypeId: ttIntegration.id, label: 'Brand' } })
    ?? await prisma.formField.create({ data: { taskTypeId: ttIntegration.id, label: 'Brand', tipo: FormFieldTipo.select_brand, required: true, order: 1 } });
  const ffIntNotes = await prisma.formField.findFirst({ where: { taskTypeId: ttIntegration.id, label: 'Integration notes' } })
    ?? await prisma.formField.create({ data: { taskTypeId: ttIntegration.id, label: 'Integration notes', tipo: FormFieldTipo.texto, required: false, order: 2 } });

  // ─── TT2: Menu Update (Ops, schedulable) ──────────────────────────────────
  const ttMenu = await prisma.taskType.upsert({
    where: { id: '00000000-0000-0000-0000-000000000022' },
    update: { active: true },
    create: {
      id: '00000000-0000-0000-0000-000000000022',
      sectionId: section.id,
      name: 'Menu Update',
      descripcion: 'Manually verify menu data, auto-sync with the platform, and confirm.',
      schedulable: true,
    },
  });
  const ttMenuStep1 = await prisma.stepDefinition.upsert({
    where: { taskTypeId_order: { taskTypeId: ttMenu.id, order: 1 } },
    update: {},
    create: { taskTypeId: ttMenu.id, name: 'Verify menu data', order: 1, executionType: 'manual_internal', assignmentStrategy: 'round_robin' },
  });
  await prisma.stepDefinition.upsert({
    where: { taskTypeId_order: { taskTypeId: ttMenu.id, order: 2 } },
    update: {},
    create: { taskTypeId: ttMenu.id, name: 'Auto sync menu', order: 2, executionType: syncHandler ? 'automatic' : 'manual_internal', assignmentStrategy: 'fixed', handlerId: syncHandler?.id },
  });
  const ttMenuStep3 = await prisma.stepDefinition.upsert({
    where: { taskTypeId_order: { taskTypeId: ttMenu.id, order: 3 } },
    update: {},
    create: { taskTypeId: ttMenu.id, name: 'Confirm update', order: 3, executionType: 'manual_internal', assignmentStrategy: 'round_robin' },
  });
  for (const bpo of [bpo1, bpo2]) {
    for (const step of [ttMenuStep1, ttMenuStep3]) {
      await prisma.stepDefinitionAccount.upsert({
        where: { stepDefinitionId_accountId: { stepDefinitionId: step.id, accountId: bpo.id } },
        update: {},
        create: { stepDefinitionId: step.id, accountId: bpo.id },
      });
    }
  }
  const ffMenuBrand = await prisma.formField.findFirst({ where: { taskTypeId: ttMenu.id, label: 'Brand' } })
    ?? await prisma.formField.create({ data: { taskTypeId: ttMenu.id, label: 'Brand', tipo: FormFieldTipo.select_brand, required: true, order: 1 } });
  await prisma.formField.findFirst({ where: { taskTypeId: ttMenu.id, label: 'Change description' } })
    ?? await prisma.formField.create({ data: { taskTypeId: ttMenu.id, label: 'Change description', tipo: FormFieldTipo.texto, required: true, order: 2 } });

  // ─── TT3: Shop Onboarding (Growth) ────────────────────────────────────────
  const ttShop = await prisma.taskType.upsert({
    where: { id: '00000000-0000-0000-0000-000000000023' },
    update: { active: true },
    create: {
      id: '00000000-0000-0000-0000-000000000023',
      sectionId: section2.id,
      name: 'Shop Onboarding',
      descripcion: 'Onboard a new shop: validate info and confirm final setup with the merchant.',
      schedulable: false,
    },
  });
  const ttShopStep1 = await prisma.stepDefinition.upsert({
    where: { taskTypeId_order: { taskTypeId: ttShop.id, order: 1 } },
    update: {},
    create: { taskTypeId: ttShop.id, name: 'Validate shop data', order: 1, executionType: 'manual_internal', assignmentStrategy: 'round_robin' },
  });
  const ttShopStep2 = await prisma.stepDefinition.upsert({
    where: { taskTypeId_order: { taskTypeId: ttShop.id, order: 2 } },
    update: {},
    create: { taskTypeId: ttShop.id, name: 'Confirm with merchant', order: 2, executionType: 'manual_external', assignmentStrategy: 'round_robin' },
  });
  for (const bpo of [bpo4, bpo5]) {
    for (const step of [ttShopStep1, ttShopStep2]) {
      await prisma.stepDefinitionAccount.upsert({
        where: { stepDefinitionId_accountId: { stepDefinitionId: step.id, accountId: bpo.id } },
        update: {},
        create: { stepDefinitionId: step.id, accountId: bpo.id },
      });
    }
  }
  const ffShopBrand = await prisma.formField.findFirst({ where: { taskTypeId: ttShop.id, label: 'Brand' } })
    ?? await prisma.formField.create({ data: { taskTypeId: ttShop.id, label: 'Brand', tipo: FormFieldTipo.select_brand, required: true, order: 1 } });
  await prisma.formField.findFirst({ where: { taskTypeId: ttShop.id, label: 'Merchant contact' } })
    ?? await prisma.formField.create({ data: { taskTypeId: ttShop.id, label: 'Merchant contact', tipo: FormFieldTipo.texto, required: false, order: 2 } });

  // ─── TT4: Debug Test (Ops) ────────────────────────────────────────────────
  const ttDebug = await prisma.taskType.upsert({
    where: { id: '00000000-0000-0000-0000-000000000021' },
    update: { active: true },
    create: {
      id: '00000000-0000-0000-0000-000000000021',
      sectionId: section.id,
      name: 'Debug Test (webhook + auto step)',
      descripcion: 'Smoke test: manual step → automatic debug_echo step.',
      schedulable: false,
    },
  });
  const ttDbgStep1 = await prisma.stepDefinition.upsert({
    where: { taskTypeId_order: { taskTypeId: ttDebug.id, order: 1 } },
    update: {},
    create: { taskTypeId: ttDebug.id, name: 'Manual confirmation', order: 1, executionType: 'manual_internal', assignmentStrategy: 'round_robin' },
  });
  for (const bpo of [bpo1, bpo2, bpo3]) {
    await prisma.stepDefinitionAccount.upsert({
      where: { stepDefinitionId_accountId: { stepDefinitionId: ttDbgStep1.id, accountId: bpo.id } },
      update: {},
      create: { stepDefinitionId: ttDbgStep1.id, accountId: bpo.id },
    });
  }
  await prisma.stepWebhook.upsert({
    where: { stepDefinitionId_webhookId: { stepDefinitionId: ttDbgStep1.id, webhookId: devWebhook.id } },
    update: { events: [WebhookEvent.on_start, WebhookEvent.on_complete, WebhookEvent.on_fail] },
    create: { stepDefinitionId: ttDbgStep1.id, webhookId: devWebhook.id, events: [WebhookEvent.on_start, WebhookEvent.on_complete, WebhookEvent.on_fail] },
  });
  if (debugHandler) {
    const ttDbgStep2 = await prisma.stepDefinition.upsert({
      where: { taskTypeId_order: { taskTypeId: ttDebug.id, order: 2 } },
      update: {},
      create: { taskTypeId: ttDebug.id, name: 'Auto echo (debug_echo)', order: 2, executionType: 'automatic', assignmentStrategy: 'fixed', handlerId: debugHandler.id },
    });
    await prisma.stepWebhook.upsert({
      where: { stepDefinitionId_webhookId: { stepDefinitionId: ttDbgStep2.id, webhookId: devWebhook.id } },
      update: { events: [WebhookEvent.on_start, WebhookEvent.on_complete, WebhookEvent.on_fail] },
      create: { stepDefinitionId: ttDbgStep2.id, webhookId: devWebhook.id, events: [WebhookEvent.on_start, WebhookEvent.on_complete, WebhookEvent.on_fail] },
    });
  }
  await prisma.formField.findFirst({ where: { taskTypeId: ttDebug.id, label: 'Test Note' } })
    ?? await prisma.formField.create({ data: { taskTypeId: ttDebug.id, label: 'Test Note', tipo: FormFieldTipo.texto, required: false, order: 1 } });
  await prisma.formField.findFirst({ where: { taskTypeId: ttDebug.id, label: 'Brand Link' } })
    ?? await prisma.formField.create({ data: { taskTypeId: ttDebug.id, label: 'Brand Link', tipo: FormFieldTipo.link, required: false, order: 2 } });

  console.log('✓ task types: 4 (Brand Integration, Menu Update, Shop Onboarding, Debug Test)');

  // ── Sample Tasks (various states) ─────────────────────────────────────────
  // Load step definitions for use below
  const intSteps = await prisma.stepDefinition.findMany({ where: { taskTypeId: ttIntegration.id }, orderBy: { order: 'asc' } });
  const menuSteps = await prisma.stepDefinition.findMany({ where: { taskTypeId: ttMenu.id }, orderBy: { order: 'asc' } });
  const shopSteps = await prisma.stepDefinition.findMany({ where: { taskTypeId: ttShop.id }, orderBy: { order: 'asc' } });

  // Helper: upsert a task and wipe its step instances for a clean reseed
  async function upsertTask(id: string, data: Parameters<typeof prisma.task.create>[0]['data']) {
    const existing = await prisma.task.findUnique({ where: { id } });
    if (existing) {
      await prisma.stepInstance.deleteMany({ where: { taskId: id } });
      await prisma.formValue.deleteMany({ where: { taskId: id } });
      await prisma.task.update({ where: { id }, data: { status: data.status as TaskStatus, deletedAt: null } });
    } else {
      await prisma.task.create({ data: { id, ...data } as Parameters<typeof prisma.task.create>[0]['data'] });
    }
    return prisma.task.findUniqueOrThrow({ where: { id } });
  }

  // ─── TASK 1: DONE — Brand Integration, Burger Demo CO ─────────────────────
  // Completado hace 2 días por bpo1 (step1) y automático (step2), bpo2 (step3)
  const task1Id = '00000000-0000-0000-0001-000000000001';
  await upsertTask(task1Id, {
    taskTypeId: ttIntegration.id,
    brandId: brandBurger.id,
    createdById: user1.id,
    status: TaskStatus.done,
  });
  await prisma.formValue.create({ data: { taskId: task1Id, formFieldId: ffIntBrand.id, brandId: brandBurger.id } });
  await prisma.formValue.create({ data: { taskId: task1Id, formFieldId: ffIntNotes.id, valor: 'Credentials validated via API portal. No issues found.' } });
  if (intSteps[0]) await prisma.stepInstance.create({ data: {
    taskId: task1Id, stepDefinitionId: intSteps[0].id, status: StepStatus.done,
    assignedToId: bpo1.id, startedAt: hoursAgo(52), completedAt: hoursAgo(50),
    workedSeconds: 7200, note: 'Credentials OK, app secret verified.',
  }});
  if (intSteps[1]) await prisma.stepInstance.create({ data: {
    taskId: task1Id, stepDefinitionId: intSteps[1].id, status: StepStatus.done,
    startedAt: hoursAgo(50), completedAt: hoursAgo(49), workedSeconds: 3600,
  }});
  if (intSteps[2]) await prisma.stepInstance.create({ data: {
    taskId: task1Id, stepDefinitionId: intSteps[2].id, status: StepStatus.done,
    assignedToId: bpo2.id, startedAt: hoursAgo(49), completedAt: hoursAgo(47),
    workedSeconds: 5400, note: '3 shops enabled. Merchant confirmed.',
  }});

  // ─── TASK 2: IN_PROGRESS — Brand Integration, Pizza Express CO ────────────
  // bpo2 está trabajando en step 1 (lo inició hace 45 min)
  const task2Id = '00000000-0000-0000-0001-000000000002';
  await upsertTask(task2Id, {
    taskTypeId: ttIntegration.id,
    brandId: brandPizza.id,
    createdById: user1.id,
    status: TaskStatus.in_progress,
  });
  await prisma.formValue.create({ data: { taskId: task2Id, formFieldId: ffIntBrand.id, brandId: brandPizza.id } });
  await prisma.formValue.create({ data: { taskId: task2Id, formFieldId: ffIntNotes.id, valor: 'Check SFTP credentials before syncing.' } });
  if (intSteps[0]) await prisma.stepInstance.create({ data: {
    taskId: task2Id, stepDefinitionId: intSteps[0].id, status: StepStatus.in_progress,
    assignedToId: bpo2.id, startedAt: hoursAgo(0.75),
  }});
  if (intSteps[1]) await prisma.stepInstance.create({ data: { taskId: task2Id, stepDefinitionId: intSteps[1].id, status: StepStatus.pending } });
  if (intSteps[2]) await prisma.stepInstance.create({ data: { taskId: task2Id, stepDefinitionId: intSteps[2].id, status: StepStatus.pending } });

  // ─── TASK 3: ASSIGNED — Shop Onboarding, Sushi Fusion CO ──────────────────
  // bpo4 asignado al step 1, aún no ha dado Start
  const task3Id = '00000000-0000-0000-0001-000000000003';
  await upsertTask(task3Id, {
    taskTypeId: ttShop.id,
    brandId: brandSushi.id,
    createdById: user3.id,
    status: TaskStatus.assigned,
  });
  await prisma.formValue.create({ data: { taskId: task3Id, formFieldId: ffShopBrand.id, brandId: brandSushi.id } });
  if (shopSteps[0]) await prisma.stepInstance.create({ data: {
    taskId: task3Id, stepDefinitionId: shopSteps[0].id, status: StepStatus.pending, assignedToId: bpo4.id,
  }});
  if (shopSteps[1]) await prisma.stepInstance.create({ data: { taskId: task3Id, stepDefinitionId: shopSteps[1].id, status: StepStatus.pending } });

  // ─── TASK 4: BLOCKED — Menu Update, Burger Demo CO ────────────────────────
  // bpo1 bloqueó el step 1 (esperando info del merchant). Tiempo trabajado: 30 min.
  const task4Id = '00000000-0000-0000-0001-000000000004';
  await upsertTask(task4Id, {
    taskTypeId: ttMenu.id,
    brandId: brandBurger.id,
    createdById: user2.id,
    status: TaskStatus.blocked,
  });
  await prisma.formValue.create({ data: { taskId: task4Id, formFieldId: ffMenuBrand.id, brandId: brandBurger.id } });
  if (menuSteps[0]) await prisma.stepInstance.create({ data: {
    taskId: task4Id, stepDefinitionId: menuSteps[0].id, status: StepStatus.blocked,
    assignedToId: bpo1.id, workedSeconds: 1800,
    note: 'Waiting for updated price list from merchant. Blocked until received.',
  }});
  if (menuSteps[1]) await prisma.stepInstance.create({ data: { taskId: task4Id, stepDefinitionId: menuSteps[1].id, status: StepStatus.pending } });
  if (menuSteps[2]) await prisma.stepInstance.create({ data: { taskId: task4Id, stepDefinitionId: menuSteps[2].id, status: StepStatus.pending } });

  // ─── TASK 5: FAILED — Brand Integration, Tacos El Rey MX ─────────────────
  // bpo4 no pudo validar las credenciales (timed out)
  const task5Id = '00000000-0000-0000-0001-000000000005';
  await upsertTask(task5Id, {
    taskTypeId: ttIntegration.id,
    brandId: brandTacos.id,
    createdById: user3.id,
    status: TaskStatus.failed,
  });
  await prisma.formValue.create({ data: { taskId: task5Id, formFieldId: ffIntBrand.id, brandId: brandTacos.id } });
  await prisma.formValue.create({ data: { taskId: task5Id, formFieldId: ffIntNotes.id, valor: 'MX credentials not provided by merchant in time.' } });
  if (intSteps[0]) await prisma.stepInstance.create({ data: {
    taskId: task5Id, stepDefinitionId: intSteps[0].id, status: StepStatus.failed,
    assignedToId: bpo4.id, startedAt: hoursAgo(30), completedAt: hoursAgo(26),
    workedSeconds: 3600, failureReason: StepFailureReason.bpo_timed_out,
    note: 'Merchant did not provide app credentials within the agreed window.',
  }});
  if (intSteps[1]) await prisma.stepInstance.create({ data: { taskId: task5Id, stepDefinitionId: intSteps[1].id, status: StepStatus.pending } });
  if (intSteps[2]) await prisma.stepInstance.create({ data: { taskId: task5Id, stepDefinitionId: intSteps[2].id, status: StepStatus.pending } });

  // ─── TASK 6: SCHEDULED — Menu Update, Pizza Express CO (mañana) ───────────
  const task6Id = '00000000-0000-0000-0001-000000000006';
  await upsertTask(task6Id, {
    taskTypeId: ttMenu.id,
    brandId: brandPizza.id,
    createdById: user1.id,
    status: TaskStatus.scheduled,
    scheduledStart: hoursFrom(20),
    scheduledEnd: hoursFrom(24),
  });
  await prisma.formValue.create({ data: { taskId: task6Id, formFieldId: ffMenuBrand.id, brandId: brandPizza.id } });
  if (menuSteps[0]) await prisma.stepInstance.create({ data: { taskId: task6Id, stepDefinitionId: menuSteps[0].id, status: StepStatus.pending } });
  if (menuSteps[1]) await prisma.stepInstance.create({ data: { taskId: task6Id, stepDefinitionId: menuSteps[1].id, status: StepStatus.pending } });
  if (menuSteps[2]) await prisma.stepInstance.create({ data: { taskId: task6Id, stepDefinitionId: menuSteps[2].id, status: StepStatus.pending } });

  // ─── TASK 7: ASSIGNED — Shop Onboarding, Coffee Central CR ───────────────
  // bpo5 asignado, aún no inicia
  const task7Id = '00000000-0000-0000-0001-000000000007';
  await upsertTask(task7Id, {
    taskTypeId: ttShop.id,
    brandId: brandCoffee.id,
    createdById: user3.id,
    status: TaskStatus.assigned,
  });
  await prisma.formValue.create({ data: { taskId: task7Id, formFieldId: ffShopBrand.id, brandId: brandCoffee.id } });
  if (shopSteps[0]) await prisma.stepInstance.create({ data: {
    taskId: task7Id, stepDefinitionId: shopSteps[0].id, status: StepStatus.pending, assignedToId: bpo5.id,
  }});
  if (shopSteps[1]) await prisma.stepInstance.create({ data: { taskId: task7Id, stepDefinitionId: shopSteps[1].id, status: StepStatus.pending } });

  // ─── TASK 8: DONE — Shop Onboarding, Sushi Fusion CO (completado ayer) ────
  const task8Id = '00000000-0000-0000-0001-000000000008';
  await upsertTask(task8Id, {
    taskTypeId: ttShop.id,
    brandId: brandSushi.id,
    createdById: user3.id,
    status: TaskStatus.done,
  });
  await prisma.formValue.create({ data: { taskId: task8Id, formFieldId: ffShopBrand.id, brandId: brandSushi.id } });
  if (shopSteps[0]) await prisma.stepInstance.create({ data: {
    taskId: task8Id, stepDefinitionId: shopSteps[0].id, status: StepStatus.done,
    assignedToId: bpo4.id, startedAt: hoursAgo(26), completedAt: hoursAgo(24),
    workedSeconds: 4800, note: 'Data validated, 3 shops confirmed.',
  }});
  if (shopSteps[1]) await prisma.stepInstance.create({ data: {
    taskId: task8Id, stepDefinitionId: shopSteps[1].id, status: StepStatus.done,
    assignedToId: bpo5.id, startedAt: hoursAgo(24), completedAt: hoursAgo(22),
    workedSeconds: 3600, note: 'Merchant confirmed setup via WhatsApp.',
  }});

  console.log('✓ sample tasks: 8 (done×2, in_progress, assigned×2, blocked, failed, scheduled)');
  console.log('✓ dev webhook log:', devWebhook.url);
  console.log('\n✅ Seed complete');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
