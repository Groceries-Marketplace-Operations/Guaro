export type AccountRole = 'user' | 'bpo' | 'admin' | 'super_admin' | 'director';
export type TaskStatus = 'scheduled' | 'pending' | 'assigned' | 'in_progress' | 'blocked' | 'done' | 'failed';
export type StepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'blocked';
export type ExecutionType = 'manual_internal' | 'manual_external' | 'automatic';
export type AssignmentStrategy = 'fixed' | 'round_robin' | 'brand_assignment' | 'by_weight' | 'manual';
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
  city?: string;
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
