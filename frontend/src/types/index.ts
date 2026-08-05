export type AccountRole = 'user' | 'bpo' | 'admin' | 'super_admin' | 'director';
export type TaskStatus = 'scheduled' | 'pending' | 'assigned' | 'in_progress' | 'blocked' | 'done' | 'failed';
export type StepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'blocked' | 'cancelled';
export type ExecutionType = 'manual_internal' | 'manual_external' | 'automatic';
export type AssignmentStrategy = 'fixed' | 'round_robin' | 'brand_assignment' | 'by_weight' | 'manual' | 'same_previous_step';
export type ShopStatus = 'lead' | 'application' | 'integrated' | 'online';
export type KaType = 'KA' | 'CKA' | 'SME';
export type Country = 'MX' | 'CO' | 'CR';
export type WebhookEvent = 'on_start' | 'on_complete' | 'on_fail' | 'on_assignment' | 'on_blocked';

export interface Account {
  id: string;
  name: string;
  email: string;
  roles: AccountRole[];
  sectionId?: string;
  section?: { id: string; name: string };
  adminModules?: string[];
  bpoPermissions?: string[];
  createdAt: string;
}

export interface Section {
  id: string;
  name: string;
  createdAt: string;
  _count?: { taskTypes: number; accounts: number };
}

export interface Handler {
  id: string;
  name: string;
  createdAt: string;
}

export interface Webhook {
  id: string;
  name: string;
  url: string;
  isAlerts: boolean;
  createdAt: string;
}

export interface FormField {
  id: string;
  label: string;
  tipo: string;
  required: boolean;
  multiple?: boolean;
  order: number;
  options?: string[];
  filteredById?: string;
}

export interface StepDefinition {
  id: string;
  name: string;
  order: number;
  executionType: ExecutionType;
  assignmentStrategy: AssignmentStrategy;
  handlerId?: string;
  bpoCount?: number;
  handler?: Handler;
  candidates?: { account: Account; weight?: number }[];
  stepWebhooks?: { id: string; webhookId: string; events: WebhookEvent[]; webhook: Webhook }[];
}

export interface TaskTypeTemplate {
  id: string;
  taskTypeId: string;
  name: string;
  url: string;
  tipo: string;
  createdAt: string;
}

export interface TaskType {
  id: string;
  name: string;
  description?: string;
  schedulable: boolean;
  active: boolean;
  sectionId: string;
  section?: Section;
  stepDefinitions?: StepDefinition[];
  formFields?: FormField[];
  templates?: TaskTypeTemplate[];
  createdAt: string;
  _count?: { tasks: number; stepDefinitions?: number; formFields?: number };
}

export type MenuIntegration = 'api' | 'api_whitelist' | 'sftp' | 'spreadsheets' | 'bapp';
export type PickingMode = 'merchant_picking_bapp' | 'merchant_picking_dapp' | 'dos_en_uno';
export type PaymentMode = 'food_mode' | 'prepaid_card' | 'qr_code';

export interface Application {
  id: string;
  appId: string;
  appName: string;
  country: Country;
  createdAt: string;
}

export interface Brand {
  id: string;
  brandId: string;
  brandName: string;
  country: Country;
  kaType: KaType;
  category?: string;
  menuIntegration?: MenuIntegration;
  pickingMode?: PickingMode;
  paymentMode?: PaymentMode;
  owner?: Account;
  applicationId?: string;
  application?: Application;
  webhooks?: { webhook: Webhook }[];
  shops?: Shop[];
  createdAt: string;
  _count?: { shops: number };
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface Shop {
  id: string;
  shopId: string;
  appShopId: string;
  name?: string;
  city?: string;
  address?: string;
  status: ShopStatus;
  brand?: Brand;
  brandId: string;
  latitude?: string;
  longitude?: string;
  createdAt: string;
}

export interface Application {
  id: string;
  appId: string;
  appName: string;
  country: Country;
  createdAt: string;
}

export interface StepInstance {
  id: string;
  status: StepStatus;
  assignedToId?: string;
  stepDefinition?: StepDefinition;
  assignedTo?: Account;
  note?: string;
  failureReason?: string;
  result?: unknown;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface FormValue {
  id: string;
  formFieldId: string;
  formField?: { id: string; label: string; tipo: string };
  valor?: string;
  brandId?: string;
  brand?: { id: string; brandId: string; brandName: string };
  shopId?: string;
  shop?: { id: string; shopId: string; appShopId: string };
}

export interface Task {
  id: string;
  status: TaskStatus;
  brand?: Brand;
  taskType?: TaskType;
  createdBy?: Account;
  scheduledStart?: string;
  scheduledEnd?: string;
  stepInstances?: StepInstance[];
  formValues?: FormValue[];
  createdAt: string;
}

export interface BrandAssignmentRule {
  id: string;
  kaType: KaType;
  country: Country;
  modo: 'fixed' | 'round_robin';
  candidates: { accountId: string; account: Account }[];
}

export interface AppConfigOption {
  id: string;
  category: string;
  value: string;
  label: string;
  active: boolean;
  order: number;
}

export interface Invitation {
  id: string;
  token: string;
  rol: AccountRole;
  section?: Section;
  usedAt?: string;
  expiresAt: string;
  createdAt: string;
}

export type AutoOpenStatus = 'pending' | 'running' | 'done' | 'partial_success' | 'failed' | 'cancelled';

export interface AutoOpenPool {
  id: string;
  name: string;
  country: Country;
  active: boolean;
  executionHours: number[];
  timezone: string;
  webhookId?: string;
  webhook?: { id: string; name: string };
  brands: Array<{ poolId: string; brandId: string; brand: { id: string; brandName: string; brandId: string; country: Country } }>;
  createdAt: string;
  updatedAt: string;
}

export interface AutoOpenExecution {
  id: string;
  poolId: string;
  status: AutoOpenStatus;
  startedAt?: string;
  finishedAt?: string;
  totalShops: number;
  shopsOpened: number;
  logs?: { brands: Array<{ brandName: string; shopsProcessed: number; shopsOpened: number; error?: string }> };
  createdAt: string;
}

export interface AssistantCheck {
  id: string;
  label: string;
  status: 'passed' | 'warning' | 'failed';
  message: string;
  details?: string[];
}

export interface FileValidationResult {
  originalName: string;
  tempPath?: string;
  canProceed: boolean;
  summary: string;
  checks: AssistantCheck[];
  stats: { validRows: number; totalRows: number };
}

export interface AssistantContext {
  assistantName: string;
  taskTypeId: string;
  taskTypeName: string;
  canAccess: boolean;
  accessMessage: string;
  hasFileValidation: boolean;
  fileRules: Array<{
    fieldId: string;
    fieldLabel: string;
    acceptedExtensions: string[];
    maxSizeMb: number;
    expectedColumns: string[];
    validator: string;
  }>;
  requiredFields: string[];
  templates: Array<{ name: string; url: string; type: string }>;
  formatExamples: Array<{
    title: string;
    headers: string[];
    rows: string[][];
    rowLabels: string[];
    notes: Array<{ es: string; en: string }>;
  }>;
  greeting: string;
}

export interface AutoTurnOffRule {
  id: string;
  poolId: string;
  brandId: string;
  name: string;
  active: boolean;
  scheduleMode: 'interval' | 'daily_times';
  intervalMinutes: number;
  executionTimes: string[];
  upcs: string[];
  shopIds: string[];
  stockEndpoint: 'setStock' | 'setstockSync';
  startsAt: string;
  endsAt?: string;
  nextRunAt: string;
  lastRunAt?: string;
  createdBy: { id: string; name: string; email: string };
  updatedBy: { id: string; name: string; email: string };
  executions?: Array<{
    id: string;
    status: AutoOpenStatus;
    currentStep?: string;
    progressCurrent: number;
    progressTotal: number;
    progressPercent: number;
    totalShops: number;
    shopsSucceeded: number;
    itemsTurnedOff: number;
    errorMessage?: string;
    cancelledAt?: string;
    startedAt?: string;
    finishedAt?: string;
  }>;
  brand: Pick<Brand, 'id' | 'brandId' | 'brandName' | 'country'>;
  createdAt: string;
  menuSyncStatus?: string;
  menuSyncedAt?: string;
  menuSyncError?: string;
  menuItemCount?: number;
  updatedAt: string;
}

export interface AutoTurnOffPool {
  id: string;
  name: string;
  country: Country;
  active: boolean;
  webhookId?: string;
  webhook?: { id: string; name: string };
  rules: AutoTurnOffRule[];
  createdAt: string;
  updatedAt: string;
}

export interface AutoTurnOffExecution {
  id: string;
  poolId: string;
  ruleId: string;
  status: AutoOpenStatus;
  trigger: 'manual' | 'scheduled';
  startedAt?: string;
  finishedAt?: string;
  totalShops: number;
  shopsSucceeded: number;
  itemsTurnedOff: number;
  currentStep?: string;
  progressCurrent: number;
  progressTotal: number;
  progressPercent: number;
  errorMessage?: string;
  cancelledAt?: string;
  rule: { id: string; name: string; brand: { brandName: string } };
  logs?: { shops: AutoTurnOffShopResult[] };
  createdAt: string;
}

export interface BrandItem {
  id: string;
  brandId: string;
  name: string;
  upc?: string;
  appItemId: string;
  imageUrl?: string;
  sourceShopId?: string;
  sourceCity?: string;
  lastSeenAt: string;
}

export interface BrandPromotion {
  id: string;
  shopExternalId: string;
  activityId: string;
  activityName?: string;
  startDate?: string;
  endDate?: string;
  activityType?: number;
  sku: string;
  discountAmount?: string;
  discountPercentage?: string;
  buyNum?: string;
  getNum?: string;
  bxgyX?: string;
  bxgyY?: string;
  actionType?: number;
  sourceFile: string;
  sourceAccount: string;
  fetchedAt: string;
  shop?: { id: string; shopId: string; appShopId: string; name?: string; city?: string };
}

export interface SftpApplication {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  rootPath?: string;
  brandId?: string;
  brand?: Pick<Brand, 'id' | 'brandId' | 'brandName' | 'country'>;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type FileIntegrationKind = 'complex_promotion_reader' | 'price_filter';

export interface FileIntegrationFileResult {
  fileName: string;
  size: number;
  modifiedAt: string;
  rowsRead: number;
  rowsKept: number;
  rowsRemoved: number;
  invalidAmounts: number;
  delimiter: string;
  outputFile?: string;
  beforeFile?: string;
  afterFile?: string;
  backupRemotePath?: string;
  remoteReplaced?: boolean;
  promotionsStored?: number;
  invalidRows?: number;
  skipped?: string;
  error?: string;
}

export interface FileIntegrationExecution {
  id: string;
  status: string;
  trigger: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  filesScanned: number;
  filesProcessed: number;
  rowsRead: number;
  rowsKept: number;
  rowsRemoved: number;
  bytesRead: string;
  currentFile?: string;
  errorMessage?: string;
  result?: { files?: FileIntegrationFileResult[]; newFiles?: number };
  createdAt: string;
}

export interface FileIntegrationRule {
  id: string;
  name: string;
  kind: FileIntegrationKind;
  country?: string;
  active: boolean;
  intervalMinutes?: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastRemoteModifiedAt?: string;
  filePattern: string;
  sourceScope: string;
  thresholdAmount?: string;
  delimiter?: string;
  priceColumn?: number;
  maxFilesPerRun: number;
  sftpApplicationId: string;
  sftpApplication: Pick<SftpApplication, 'id' | 'name' | 'host' | 'port' | 'rootPath' | 'active'>;
  executions: FileIntegrationExecution[];
}

export interface StoreEmergencyTarget {
  id: string;
  offlineStatus: string;
  restoreStatus: string;
  offlineError?: string;
  restoreError?: string;
  offlineAt?: string;
  restoredAt?: string;
  shop: Pick<Shop, 'id' | 'shopId' | 'appShopId' | 'name' | 'city'>;
}

export interface StoreEmergency {
  id: string;
  mode: 'all_brand' | 'shop_list';
  requestedIds: string[];
  endsAt: string;
  status: string;
  startedAt?: string;
  offlineAt?: string;
  restoredAt?: string;
  finishedAt?: string;
  errorMessage?: string;
  createdAt: string;
  brand: Pick<Brand, 'id' | 'brandId' | 'brandName' | 'country'>;
  createdBy: Pick<Account, 'id' | 'name' | 'email'>;
  targets: StoreEmergencyTarget[];
}

export interface ForcedOpenTarget {
  id: string;
  status: string;
  error?: string;
  openedAt?: string;
  shop: Pick<Shop, 'id' | 'shopId' | 'appShopId' | 'name' | 'city'>;
}

export interface ForcedOpenOperation {
  id: string;
  mode: 'all_brand' | 'shop_list';
  requestedIds: string[];
  status: string;
  totalShops: number;
  shopsOpened: number;
  shopsFailed: number;
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
  createdAt: string;
  brand: Pick<Brand, 'id' | 'brandId' | 'brandName' | 'country'>;
  createdBy: Pick<Account, 'id' | 'name' | 'email'>;
  targets?: ForcedOpenTarget[];
}

export interface AutoTurnOffShopResult {
  shopId: string;
  appShopId: string;
  endpoint: 'setStock' | 'setstockSync';
  success: boolean;
  itemsSucceeded: number;
  itemsFailed: number;
  taskId?: string;
  menuTaskId?: string;
  menuSource?: 'catalog' | 'download';
  requestedUpcs?: number;
  matchedUpcs?: number;
  missingUpcs?: string[];
  successfulItems?: Array<{ upc?: string; appItemId: string; name?: string; confirmation?: 'accepted' | 'confirmed' }>;
  failedItems?: Array<{ appItemId?: string; upc?: string; reason: string }>;
  error?: string;
}

export interface AutoTurnOffShopExecution {
  id: string;
  shopId: string;
  appShopId?: string;
  status: AutoOpenStatus;
  currentStep?: string;
  itemsSucceeded: number;
  itemsFailed: number;
  result?: AutoTurnOffShopResult;
  startedAt?: string;
  finishedAt?: string;
}
