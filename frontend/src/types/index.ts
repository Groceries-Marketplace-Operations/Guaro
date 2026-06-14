export type AccountRole = 'user' | 'bpo' | 'admin' | 'super_admin' | 'director';
export type TaskStatus = 'scheduled' | 'pending' | 'assigned' | 'in_progress' | 'done' | 'failed';
export type StepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'blocked';
export type ExecutionType = 'manual_internal' | 'manual_external' | 'automatic';
export type AssignmentStrategy = 'fixed' | 'round_robin' | 'by_weight';
export type ShopStatus = 'lead' | 'application' | 'integrated' | 'online';
export type KaType = 'KA' | 'CKA' | 'SME';
export type Country = 'MX' | 'CO' | 'CR';
export type WebhookEvent = 'on_start' | 'on_complete' | 'on_fail';

export interface Account {
  id: string;
  name: string;
  email: string;
  roles: AccountRole[];
  sectionId?: string;
  section?: { id: string; name: string };
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
  order: number;
  options?: string[];
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
  webhooks?: { webhook: Webhook; events: WebhookEvent[] }[];
}

export interface TaskType {
  id: string;
  name: string;
  description?: string;
  schedulable: boolean;
  sectionId: string;
  section?: Section;
  stepDefinitions?: StepDefinition[];
  formFields?: FormField[];
  createdAt: string;
  _count?: { tasks: number };
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
  order: number;
  stepDefinition?: StepDefinition;
  assignedTo?: Account;
  note?: string;
  failureReason?: string;
  result?: unknown;
  completedAt?: string;
  createdAt: string;
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
  formValues?: unknown[];
  createdAt: string;
}

export interface BrandAssignmentRule {
  id: string;
  kaType: KaType;
  country: Country;
  modo: 'fixed' | 'round_robin';
  account?: Account;
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
