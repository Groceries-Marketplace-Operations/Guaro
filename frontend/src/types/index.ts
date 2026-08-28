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
  permissions?: string[];
  createdAt: string;
}

export interface Section {
  id: string;
  name: string;
  order: number;
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
  order: number;
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
export type ShopPickingModel = 'store_picking' | 'qr_code_2in1' | 'prepaid_card_2in1';

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
  pickingModel?: ShopPickingModel;
  driverCashBlocked?: boolean;
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

export interface DidiStoreBindingShop {
  shopId: string;
  appShopId: string;
  name?: string | null;
  shopName?: string | null;
  city?: string | null;
  bound?: boolean | null;
  bindingStatus?: string | null;
}

export interface DidiStoreBindingShopsResponse {
  application?: {
    id: string;
    appId: string;
    appName: string;
    country: Country;
    environment: string;
  };
  guards?: {
    writesEnabled: boolean;
    productionWritesEnabled: boolean;
    canWrite: boolean;
  };
  confirmation?: { bind: string; unbind: string };
  pageNo?: number;
  pageSize?: number;
  totalPages?: number;
  total?: number;
  shops?: DidiStoreBindingShop[];
  data?: DidiStoreBindingShop[];
}

export interface DidiStoreBindingRequest {
  applicationId: string;
  shops: Array<{ shopId: string; appShopId: string }>;
  confirmation: string;
}

export interface DidiStoreBindingResult {
  shopId?: string | null;
  appShopId?: string | null;
  status?: string | null;
  success?: boolean;
  reason?: string | null;
  error?: string | null;
  message?: string | null;
  errno?: string | number | null;
}

export interface DidiStoreBindingResponse {
  operationId?: string;
  action?: 'bind' | 'unbind';
  summary?: {
    total?: number;
    requested?: number;
    succeeded?: number;
    failed?: number;
    skipped?: number;
    unconfirmed?: number;
    status?: string;
  };
  results: DidiStoreBindingResult[];
  auditPersisted?: boolean;
  durationMs?: number;
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

export interface AutoOpenCapabilities {
  dryRunAvailable: boolean;
  remoteWritesEnabled: boolean;
  liveModeAvailable: boolean;
  reason: string;
}

export interface AutoOpenStoreSummary {
  totalStores: number;
  includedStores: number;
  emergencyProtectedStores: number;
  configurationBlockedStores: number;
  calculatedAt?: string;
}

export type AutoOpenStoreInclusion =
  | 'included'
  | 'emergency'
  | 'configuration';

export interface AutoOpenPoolStore {
  id: string;
  shopId: string;
  appShopId: string;
  name?: string | null;
  city?: string | null;
  status: 'lead' | 'application' | 'integrated' | 'online';
  brand: {
    id: string;
    brandId: string;
    brandName: string;
    country: Country;
  };
  inclusion: AutoOpenStoreInclusion;
  reason: 'missing_active_application' | 'live_brand_emergency' | 'live_store_emergency' | null;
  emergency?: {
    id: string;
    mode: string;
    status: string;
    scope: 'brand' | 'store';
  } | null;
}

export interface AutoOpenPoolStoresResponse {
  data: AutoOpenPoolStore[];
  total: number;
  page: number;
  limit: number;
  summary: AutoOpenStoreSummary;
  summaryScope: 'pool';
  calculatedAt: string;
}

export interface AutoOpenPoolBrandMembership {
  poolId: string;
  brandId: string;
  brand: {
    id: string;
    brandName: string;
    brandId: string;
    country: Country;
  };
  storeSummary: AutoOpenStoreSummary;
}

export interface AutoOpenPool {
  id: string;
  managedKey?: string;
  name: string;
  country: Country;
  active: boolean;
  dryRun: boolean;
  executionHours: number[];
  timezone: string;
  webhookId?: string;
  webhook?: { id: string; name: string };
  storeSummary: AutoOpenStoreSummary;
  brands: AutoOpenPoolBrandMembership[];
  createdAt: string;
  updatedAt: string;
}

export interface AutoOpenExecution {
  id: string;
  poolId: string;
  status: AutoOpenStatus;
  dryRun: boolean;
  remoteWritesEnabled: boolean;
  scheduledSlot?: string;
  startedAt?: string;
  finishedAt?: string;
  totalShops: number;
  shopsOpened: number;
  shopsWouldOpen: number;
  shopsSkippedEmergency: number;
  shopsFailed: number;
  totalBrands: number;
  brandsCompleted: number;
  brandsFailed: number;
  progressPercent: number;
  currentBrand?: string;
  errorMessage?: string;
  heartbeatAt?: string;
  brandRuns?: AutoOpenBrandExecution[];
  logs?: {
    mode?: 'dry_run' | 'live';
    brands: Array<{
      brandName: string;
      shopsProcessed: number;
      shopsOpened: number;
      shopsWouldOpen: number;
      shopsSkippedEmergency: number;
      shopsFailed?: number;
      blockedByEmergency?: boolean;
      error?: string;
      shopErrors?: Array<{ shopId: string; appShopId: string; error: string }>;
    }>;
  };
  createdAt: string;
}

export interface AutoOpenBrandExecution {
  id: string;
  executionId: string;
  brandId: string;
  brandName: string;
  status: AutoOpenStatus;
  startedAt?: string;
  finishedAt?: string;
  totalShops: number;
  shopsProcessed: number;
  shopsOpened: number;
  shopsWouldOpen: number;
  shopsSkippedEmergency: number;
  shopsFailed: number;
  errorMessage?: string;
  shopErrors?: Array<{ shopId: string; appShopId: string; error: string }>;
  createdAt: string;
  updatedAt: string;
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
  stockValue: number;
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
    shopsPartial: number;
    shopsFailed: number;
    itemsTurnedOff: number;
    itemsFailed: number;
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
  shopsPartial: number;
  shopsFailed: number;
  itemsTurnedOff: number;
  itemsFailed: number;
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

export interface TaskDashboardSummary {
  total: number;
  counts: Record<TaskStatus, number>;
  active: number;
  attention: number;
  createdLast24Hours: number;
  completionRate: number;
  scopedBrandCount?: number;
  scopedShopCount?: number;
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

export interface BrandMenuCategory {
  id: string;
  brandId: string;
  categoryId: string;
  name: string;
  order: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
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

export type FileIntegrationKind = 'complex_promotion_reader' | 'price_filter' | 'store_file_splitter' | 'daily_status_activation';

export interface FileIntegrationFileResult {
  fileName: string;
  size: number;
  modifiedAt: string;
  rowsRead: number;
  rowsKept: number;
  rowsRemoved: number;
  rowsRemovedByAmount?: number;
  rowsRemovedByUpc?: number;
  invalidAmounts: number;
  delimiter: string;
  outputFile?: string;
  beforeFile?: string;
  afterFile?: string;
  backupRemotePath?: string;
  remoteReplaced?: boolean;
  promotionsStored?: number;
  invalidRows?: number;
  rowsChanged?: number;
  alreadyActiveLines?: number;
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
  result?: {
    files?: FileIntegrationFileResult[];
    newFiles?: number;
    pendingFiles?: number;
    sourceFile?: string;
    malformed?: number;
    outputs?: Array<{ file: string; records: number; remotePath: string }>;
    matchedDate?: string;
    poolSize?: number;
    changedLines?: number;
  };
  createdAt: string;
}

export interface FileIntegrationRule {
  id: string;
  name: string;
  kind: FileIntegrationKind;
  country?: string;
  active: boolean;
  intervalMinutes?: number;
  dailyTime?: string;
  timezone: string;
  parallelism: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastRemoteModifiedAt?: string;
  filePattern: string;
  sourceScope: string;
  thresholdAmount?: string;
  delimiter?: string;
  priceColumn?: number;
  upcColumn?: number;
  excludedUpcs: string[];
  maxFilesPerRun: number;
  fileState: { total: number; pending: number; running: number; done: number; failed: number };
  sftpApplicationId: string;
  sftpApplication: Pick<SftpApplication, 'id' | 'name' | 'host' | 'port' | 'rootPath' | 'active'>;
  executions: FileIntegrationExecution[];
}

export interface TargetedMenuShopResult {
  shopId: string;
  appShopId?: string;
  status: 'done' | 'partial_success' | 'failed';
  requestedUpcs: number;
  uploadedUpcs: number;
  missingUpcs: string[];
  exportTaskId?: string;
  uploadTaskId?: string;
  uploadTaskIds?: string[];
  failedItems?: Array<{ appItemId: string; reason: string }>;
  error?: string;
}

export interface TargetedMenuExecution {
  id: string;
  status: AutoOpenStatus;
  trigger: string;
  startedAt?: string;
  finishedAt?: string;
  totalShops: number;
  processedShops: number;
  successfulShops: number;
  failedShops: number;
  currentShopId?: string;
  errorMessage?: string;
  result?: {
    shops?: TargetedMenuShopResult[];
    progress?: {
      shopId: string;
      phase: 'resolving_shop' | 'downloading_menu' | 'matching_upcs' | 'submitting_menu' | 'confirming_upload';
      message: string;
      exportTaskId?: string;
      exportPollAttempts?: number;
      exportStatus?: number;
      currentBatch?: number;
      totalBatches?: number;
    };
  };
  createdAt: string;
}

export interface TargetedMenuRule {
  id: string;
  name: string;
  brandId: string;
  shopIds: string[];
  upcs: string[];
  active: boolean;
  mergePolicy: number;
  uploadEndpoint: 'uploadGrocery' | 'updateItemsync';
  startsAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
  brand: Pick<Brand, 'id' | 'brandId' | 'brandName' | 'country'>;
  createdBy?: Pick<Account, 'id' | 'name' | 'email'>;
  updatedBy?: Pick<Account, 'id' | 'name' | 'email'>;
  executions: TargetedMenuExecution[];
}

export interface OfferMenuStoreResult {
  storeId: string;
  appShopId: string;
  status: 'done' | 'partial_success' | 'failed';
  itemCount: number;
  uploadedItems: number;
  taskIds: string[];
  failedItems: Array<{ appItemId: string; reason: string }>;
  failedItemCount?: number;
  dryRun: boolean;
  error?: string;
}

export interface OfferMenuUploadExecution {
  id: string;
  status: AutoOpenStatus;
  trigger: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  sourceFile?: string;
  sourceModifiedAt?: string;
  sourceSize?: string;
  totalStores: number;
  processedStores: number;
  successfulStores: number;
  failedStores: number;
  totalItems: number;
  uploadedItems: number;
  failedItems: number;
  currentStoreId?: string;
  errorMessage?: string;
  result?: {
    skipped?: boolean;
    reason?: string;
    dryRun?: boolean;
    phase?: 'submitting' | 'checking_status' | 'complete';
    submissionProcessedStores?: number;
    submittedStores?: number;
    checkedStores?: number;
    totalStores?: number;
    statusPolls?: number;
    rateLimitedPolls?: number;
    pendingStatusChecks?: number;
    submittedTasks?: Array<{ storeId: string; appShopId: string; itemCount: number; taskId: string }>;
    stores?: OfferMenuStoreResult[];
    csv?: { rowsRead: number; rowsAccepted: number; rowsRejected: number; duplicateItems: number; errors: string[] };
  };
  createdAt: string;
}

export interface OfferMenuUploadRule {
  id: string;
  name: string;
  sftpApplicationId: string;
  applicationId: string;
  active: boolean;
  dryRun: boolean;
  scheduleHours: number[];
  timezone: string;
  nextRunAt?: string;
  lastRunAt?: string;
  filePattern: string;
  delimiter: string;
  categoryIdPrefix: string;
  categoryName: string;
  menuIdPrefix: string;
  menuNamePrefix: string;
  mergePolicy: number;
  storeConcurrency: number;
  maxItemsPerStore: number;
  maxItemsPerCategory: number;
  activeStatus: number;
  includeTaxInfo: boolean;
  taxType: number;
  taxRate: number;
  lastSourceFile?: string;
  lastSourceModifiedAt?: string;
  lastSourceSize?: string;
  createdAt: string;
  updatedAt: string;
  sftpApplication: Pick<SftpApplication, 'id' | 'name' | 'host' | 'port' | 'rootPath' | 'active'>;
  application: Pick<Application, 'id' | 'appId' | 'appName' | 'country'>;
  createdBy?: Pick<Account, 'id' | 'name' | 'email'>;
  updatedBy?: Pick<Account, 'id' | 'name' | 'email'>;
  executions: OfferMenuUploadExecution[];
}

export interface MenuCopyExecution {
  id: string;
  status: AutoOpenStatus;
  sourceApplicationId: string;
  targetApplicationId: string;
  sourceShopId: string;
  targetShopId: string;
  sourceAppShopId?: string;
  targetAppShopId?: string;
  mergePolicy: number;
  uploadEndpoint: 'uploadGrocery' | 'updateItemsync';
  currentStep?: string;
  exportTaskId?: string;
  uploadTaskId?: string;
  itemCount: number;
  categoryCount: number;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  sourceApplication: Pick<Application, 'id' | 'appId' | 'appName' | 'country'>;
  targetApplication: Pick<Application, 'id' | 'appId' | 'appName' | 'country'>;
  createdBy?: Pick<Account, 'id' | 'name' | 'email'>;
}

export interface MassiveRtboShopResult {
  shopId: string;
  appShopId?: string;
  status: 'done' | 'failed';
  error?: string;
}

export interface MassiveRtboExecution {
  id: string;
  status: AutoOpenStatus;
  applicationId: string;
  shopIds: string[];
  promiseProduceTime: number;
  totalShops: number;
  processedShops: number;
  successfulShops: number;
  failedShops: number;
  currentShopId?: string;
  currentStep?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  result?: { shops?: MassiveRtboShopResult[] };
  application: Pick<Application, 'id' | 'appId' | 'appName' | 'country'>;
  createdBy?: Pick<Account, 'id' | 'name' | 'email'>;
}

export type StoreEmergencyStatus =
  | 'pending'
  | 'running'
  | 'offline'
  | 'partial_success'
  | 'failed'
  | 'restoring'
  | 'restored'
  | 'partial_restored'
  | 'restore_failed';

export type StoreEmergencyTargetStatus =
  | 'pending'
  | 'running'
  | 'required'
  | 'not_required'
  | 'done'
  | 'failed';

export interface StoreEmergencyTarget {
  id: string;
  offlineStatus: StoreEmergencyTargetStatus;
  restoreStatus: StoreEmergencyTargetStatus;
  offlineError?: string;
  restoreError?: string;
  offlineAt?: string;
  restoredAt?: string;
  offlineAttempts?: number;
  restoreAttempts?: number;
  createdAt?: string;
  updatedAt?: string;
  shop: Pick<Shop, 'id' | 'shopId' | 'appShopId' | 'name' | 'city'>;
}

export interface StoreEmergencyTargetCounts {
  total: number;
  shutdownSucceeded: number;
  shutdownFailed: number;
  shutdownPending: number;
  restoreSucceeded: number;
  restoreFailed: number;
  restorePending: number;
  restoreRequired?: number;
  restoreNotRequired?: number;
  // Compatibility aliases keep the frontend safe during a rolling deployment.
  offlinePending?: number;
  offlineDone?: number;
  offlineFailed?: number;
  restoreDone?: number;
  offline?: number;
  restored?: number;
  errors?: number;
}

export interface StoreEmergency {
  id: string;
  mode: 'all_brand' | 'shop_list';
  requestedIds: string[];
  reason: string;
  endsAt: string;
  status: StoreEmergencyStatus;
  startedAt?: string;
  offlineAt?: string;
  restoreStartedAt?: string;
  restoredAt?: string;
  finishedAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  brand: Pick<Brand, 'id' | 'brandId' | 'brandName' | 'country'>;
  createdBy: Pick<Account, 'id' | 'name' | 'email'>;
  targets?: StoreEmergencyTarget[];
  targetCounts?: StoreEmergencyTargetCounts;
  milestones?: StoreEmergencyMilestones;
}

export interface StoreEmergencyMilestone {
  key: string;
  label: string;
  status?: 'pending' | 'current' | 'done' | 'failed' | string;
  at?: string;
  occurredAt?: string;
  description?: string;
}

export interface StoreEmergencyMilestones {
  createdAt?: string | null;
  shutdownQueuedAt?: string | null;
  shutdownStartedAt?: string | null;
  shutdownFinishedAt?: string | null;
  scheduledReopeningAt?: string | null;
  restoreRequestedAt?: string | null;
  restoreQueuedAt?: string | null;
  restoreStartedAt?: string | null;
  restoreFinishedAt?: string | null;
  finishedAt?: string | null;
}

export interface StoreEmergencyTimelineEvent {
  id: string;
  type?: string;
  eventType?: string;
  phase?: 'lifecycle' | 'shutdown' | 'schedule' | 'restore' | 'system' | string;
  outcome?: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'rescheduled' | 'requested' | 'skipped' | string | null;
  status?: string;
  severity?: 'info' | 'warning' | 'error' | 'success' | string;
  source?: 'user' | 'scheduler' | 'worker' | 'system' | 'migration' | string;
  attempt?: number | null;
  message?: string | null;
  occurredAt: string;
  createdAt?: string;
  actor?: Pick<Account, 'id' | 'name' | 'email'> | null;
  target?: { id: string; shop: Pick<Shop, 'id' | 'shopId' | 'appShopId' | 'name' | 'city'> } | null;
  metadata?: Record<string, unknown> | null;
}

export interface StoreEmergencyTimelineResponse {
  emergency: StoreEmergency;
  milestones: StoreEmergencyMilestones | StoreEmergencyMilestone[];
  counts: StoreEmergencyTargetCounts;
  data: StoreEmergencyTimelineEvent[];
  events?: StoreEmergencyTimelineEvent[];
  total: number;
  page: number;
  limit: number;
}

export interface StoreEmergencySummary {
  activeEmergencies: number;
  stalledEmergencies?: number;
  storesOffline: number;
  storesWithErrors: number;
  nextReopening?: {
    id: string;
    endsAt: string;
    brand: { brandName: string };
  };
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

/* ── Store Onboarding (dormant until the server status gate is enabled) ── */
export type StoreOnboardingSource = 'create' | 'duplicate' | 'manual';
export type StoreOnboardingStatus = 'active' | 'partial_success' | 'blocked' | 'done' | 'cancelled';
export type StoreOnboardingStage =
  | 'created'
  | 'awaiting_shop_ids'
  | 'awaiting_configuration_brief'
  | 'integration_queued'
  | 'configuring'
  | 'configuration_validated'
  | 'audit_preparing'
  | 'awaiting_audit'
  | 'audit_needs_information'
  | 'audit_rejected'
  | 'audit_approved'
  | 'rtbo'
  | 'integration_complete'
  | 'awaiting_go_live'
  | 'going_online'
  | 'online'
  | 'online_failed'
  | 'no_coverage'
  | 'creation_failed'
  | 'blocked'
  | 'cancelled';
export type StoreOnboardingEtaConfidence = 'high' | 'medium' | 'low' | 'unavailable';
export type StoreGoLiveSource = 'manual' | 'auto_open' | 'forced_open' | null;
export type StoreOnboardingAssignee = Pick<Account, 'id' | 'name' | 'email'>;

export interface StoreOnboardingOperationalStatus {
  operationalReady?: boolean;
  activationAllowed?: boolean;
  activationReadiness?: {
    ready: boolean;
    readyScopeCount: number;
    runtimeScopeCount: number;
    reasons: string[];
  };
  configured?: boolean;
  globalEnabled?: boolean;
  notificationsEnabled?: boolean;
  reason?: string | null;
  updatedAt?: string | null;
}

export interface StoreOnboardingControlResponse extends StoreOnboardingOperationalStatus {
  rolloutDrafts?: number;
  notificationProfileDrafts?: number;
  control?: {
    id: string;
    globalEnabled: boolean;
    notificationsEnabled: boolean;
    updatedById?: string | null;
    createdAt?: string;
    updatedAt?: string;
  } | null;
}

export interface StoreOnboardingUnit {
  id: string;
  requestId?: string;
  shopId?: string | null;
  externalShopId: string;
  appShopId?: string | null;
  stage: StoreOnboardingStage | string;
  configurationAssigneeId?: string | null;
  configurationAssignee?: StoreOnboardingAssignee | null;
  commercialAssigneeId?: string | null;
  commercialAssignee?: StoreOnboardingAssignee | null;
  goLiveAssigneeId?: string | null;
  goLiveAssignee?: StoreOnboardingAssignee | null;
  checklist?: Record<string, boolean | string | number | null> | null;
  configurationInput?: Record<string, boolean | string | number | null> | null;
  auditStatus?: 'pending' | 'needs_information' | 'approved' | 'rejected' | null;
  auditNote?: string | null;
  auditEvidence?: string[] | null;
  auditedById?: string | null;
  auditedBy?: StoreOnboardingAssignee | null;
  auditedAt?: string | null;
  configurationCompletedAt?: string | null;
  rtboAt?: string | null;
  onlineAt?: string | null;
  onlineSource?: StoreGoLiveSource;
  lastError?: string | null;
  transitions?: StoreOnboardingTransition[];
  createdAt?: string;
  updatedAt?: string;
}

export interface StoreOnboardingTransition {
  id: string;
  unitId?: string;
  fromStage: StoreOnboardingStage | string;
  toStage: StoreOnboardingStage | string;
  note?: string | null;
  metadata?: Record<string, unknown> | null;
  actor?: StoreOnboardingAssignee | null;
  createdAt: string;
}

export interface StoreOnboardingEtaMilestone {
  stage?: string;
  label?: string;
  estimatedAt?: string | null;
  queueUnits?: number;
  durationDays?: number;
  status?: string;
}

export interface StoreOnboardingForecast {
  estimatedCompletionAt?: string | null;
  confidence?: StoreOnboardingEtaConfidence | string;
  stageEstimates?: StoreOnboardingEtaMilestone[] | Record<string, unknown> | null;
  explanation?: string[] | string | null;
  queueUnits?: number;
  calculatedAt?: string | null;
}

export type StoreOnboardingBriefFieldType = 'text' | 'long_text' | 'number' | 'select' | 'link';

export interface StoreOnboardingBriefField {
  id: string;
  label: string;
  type: StoreOnboardingBriefFieldType;
  value: string | number;
  required?: boolean;
  options?: string[];
}

export interface StoreOnboardingBrandDependency {
  status: 'existing' | 'waiting' | 'ready' | 'failed' | string;
  brandTaskId?: string | null;
  sourceTaskId?: string | null;
  taskReference?: string | null;
  startedAt?: string | null;
  readyAt?: string | null;
  durationMinutes?: number | null;
  elapsedMinutes?: number | null;
  sharedBatchCount?: number;
  autoCompleted?: boolean;
}

export interface StoreOnboardingRequest {
  id: string;
  brandId: string;
  taskId?: string | null;
  countrySnapshot?: Country | null;
  kaTypeSnapshot?: KaType | null;
  source: StoreOnboardingSource;
  status: StoreOnboardingStatus | string;
  currentStage: StoreOnboardingStage | string;
  priority?: number;
  totalUnits: number;
  completedUnits: number;
  failedUnits: number;
  estimatedCompletionAt?: string | null;
  etaConfidence?: StoreOnboardingEtaConfidence | string | null;
  etaCalculatedAt?: string | null;
  workflowVersion?: string | null;
  enrollmentStatus?: 'enrolled' | 'legacy' | 'excluded' | string | null;
  rolloutPolicyId?: string | null;
  eligibilitySnapshot?: Record<string, unknown> | null;
  brandDependency?: StoreOnboardingBrandDependency | null;
  configurationBrief?: string | null;
  configurationBriefFields?: StoreOnboardingBriefField[] | null;
  configurationBriefAssigneeId?: string | null;
  configurationBriefAssignee?: StoreOnboardingAssignee | null;
  canEditConfigurationBrief?: boolean;
  canSubmitShopIds?: boolean;
  shopIdsValidatedAt?: string | null;
  shopIdsValidationSource?: string | null;
  configurationPreparedAt?: string | null;
  configurationPreparedBy?: StoreOnboardingAssignee | null;
  brand: Pick<Brand, 'id' | 'brandName' | 'country' | 'kaType'> & {
    brandId?: string;
    owner?: StoreOnboardingAssignee | null;
  };
  createdBy?: StoreOnboardingAssignee | null;
  units?: StoreOnboardingUnit[];
  forecast?: StoreOnboardingForecast | null;
  createdAt: string;
  updatedAt?: string;
}

export interface StoreOnboardingListResponse {
  data: StoreOnboardingRequest[];
  total: number;
  page: number;
  limit: number;
}

export interface StoreOnboardingRolloutPolicy {
  id?: string;
  revision?: number;
  country: Country;
  kaType: KaType;
  sources: StoreOnboardingSource[];
  taskTypeIds?: Partial<Record<StoreOnboardingSource, string>>;
  sourceTaskTypes?: Array<{ source: StoreOnboardingSource; taskTypeId: string }>;
  brandTaskTypeId?: string | null;
  notificationProfileId?: string | null;
  notificationProfile?: Pick<StoreOnboardingNotificationProfile, 'id' | 'logicalKey' | 'revision' | 'name' | 'enabled'> | null;
  enabled: boolean;
  effectiveAt?: string | null;
  workflowVersion: string;
  newRequestsOnly: true;
  timezone?: string;
  activatedAt?: string | null;
  publishedAt?: string | null;
  published?: boolean;
  isRuntimeRevision?: boolean;
  runtimeRevisionId?: string | null;
  runtimeEnabled?: boolean;
  pendingActivation?: boolean;
  pendingActivationRevisionId?: string | null;
  pendingActivationEffectiveAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface StoreOnboardingTaskTypeOption {
  id: string;
  name: string;
  section?: { id: string; name: string } | null;
}

export interface StoreOnboardingRolloutResponse extends StoreOnboardingOperationalStatus {
  data: StoreOnboardingRolloutPolicy[];
  canManage?: boolean;
  taskTypeOptions?: StoreOnboardingTaskTypeOption[];
}

export type StoreOnboardingNotificationFrequency = 'immediate' | 'digest' | 'scheduled';

export interface StoreOnboardingNotificationProfile {
  id?: string;
  revision?: number;
  logicalKey?: string;
  name: string;
  country?: Country | null;
  kaType?: KaType | null;
  sources?: StoreOnboardingSource[];
  webhookId: string;
  enabled: boolean;
  frequency: StoreOnboardingNotificationFrequency;
  intervalMinutes?: number | null;
  scheduledTime?: string | null;
  timezone: string;
  criticalEvents: string[];
  template: string;
  publishedAt?: string | null;
  published?: boolean;
  isRuntimeRevision?: boolean;
  runtimeRevisionId?: string | null;
  runtimeEnabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface StoreOnboardingNotificationProfilesResponse extends StoreOnboardingOperationalStatus {
  data: StoreOnboardingNotificationProfile[];
  canManage?: boolean;
  allowedVariables?: string[];
  webhookOptions?: Array<{ id: string; name: string }>;
}

export type StoreOnboardingTimelineSegmentKind = 'actual' | 'forecast' | 'blocked';

export interface StoreOnboardingTimelineSegment {
  id: string;
  type?: string;
  unitId?: string | null;
  batchId?: string | null;
  batchLabel?: string | null;
  externalShopId?: string | null;
  key?: string;
  label: string;
  kind?: StoreOnboardingTimelineSegmentKind | string;
  stage?: StoreOnboardingStage | string;
  fromStage?: StoreOnboardingStage | string | null;
  toStage?: StoreOnboardingStage | string | null;
  status?: string;
  startedAt: string;
  endedAt?: string | null;
  estimatedEndAt?: string | null;
  durationMinutes?: number | null;
  owner?: StoreOnboardingAssignee | null;
  actor?: StoreOnboardingAssignee | null;
  note?: string | null;
  eventId?: string | null;
  sharedDependency?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface StoreOnboardingTimelineSummary {
  startedAt?: string | null;
  estimatedCompletionAt?: string | null;
  inclusiveLeadTimeMinutes?: number | null;
  batchOwnTimeMinutes?: number | null;
  completedUnits?: number;
  activeUnits?: number;
  blockedUnits?: number;
  brandDependency?: StoreOnboardingBrandDependency | null;
}

export interface StoreOnboardingTimelineResponse {
  data: StoreOnboardingTimelineSegment[];
  summary: StoreOnboardingTimelineSummary;
  page: number;
  limit: number;
  total: number;
}
