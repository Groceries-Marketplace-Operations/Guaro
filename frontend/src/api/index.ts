import client from './client';
import type { Account } from '../types';

/* ── Auth ───────────────────────────────────────────────────── */
export const authApi = {
  devAccounts: () => client.get('/auth/dev-accounts'),
  devLogin: (email: string) => client.post('/auth/dev-login', { email }),
  me: () => client.get('/auth/me'),
};

/* ── Sections ───────────────────────────────────────────────── */
export const sectionsApi = {
  list: () => client.get('/sections'),
  create: (data: { name: string }) => client.post('/sections', data),
  reorder: (order: { id: string; order: number }[]) => client.patch('/sections/reorder', { order }),
  roleAccess: () => client.get('/sections/role-access'),
  updateRoleAccess: (role: string, sectionIds: string[]) => client.put(`/sections/role-access/${role}`, { sectionIds }),
};

/* ── Handlers ───────────────────────────────────────────────── */
export const handlersApi = {
  list: () => client.get('/handlers'),
  create: (data: { name: string }) => client.post('/handlers', data),
};

/* ── Webhooks ───────────────────────────────────────────────── */
export const webhooksApi = {
  list: () => client.get('/webhooks'),
  create: (data: object) => client.post('/webhooks', data),
  update: (id: string, data: object) => client.patch(`/webhooks/${id}`, data),
  delete: (id: string) => client.delete(`/webhooks/${id}`),
};

/* ── Task Types ─────────────────────────────────────────────── */
export const taskTypesApi = {
  list: (params?: object) => client.get('/task-types', { params }),
  get: (id: string) => client.get(`/task-types/${id}`),
  catalog: (params?: object) => client.get('/task-types/catalog', { params }),
  catalogItem: (id: string) => client.get(`/task-types/catalog/${id}`),
  create: (data: object) => client.post('/task-types', data),
  update: (id: string, data: object) => client.patch(`/task-types/${id}`, data),
  delete: (id: string) => client.delete(`/task-types/${id}`),
  toggleActive: (id: string) => client.patch(`/task-types/${id}/toggle-active`),
  reorder: (order: { id: string; order: number }[]) => client.patch('/task-types/reorder', { order }),
  addStep: (id: string, data: object) => client.post(`/task-types/${id}/steps`, data),
  updateStep: (id: string, stepId: string, data: object) => client.patch(`/task-types/${id}/steps/${stepId}`, data),
  reorderSteps: (id: string, order: { id: string; order: number }[]) => client.patch(`/task-types/${id}/steps/reorder`, { order }),
  deleteStep: (id: string, stepId: string) => client.delete(`/task-types/${id}/steps/${stepId}`),
  addField: (id: string, data: object) => client.post(`/task-types/${id}/fields`, data),
  updateField: (id: string, fieldId: string, data: object) => client.patch(`/task-types/${id}/fields/${fieldId}`, data),
  reorderFields: (id: string, order: { id: string; order: number }[]) => client.patch(`/task-types/${id}/fields/reorder`, { order }),
  deleteField: (id: string, fieldId: string) => client.delete(`/task-types/${id}/fields/${fieldId}`),
  addCandidate: (id: string, stepId: string, accountId: string) =>
    client.post(`/task-types/${id}/steps/${stepId}/candidates`, { accountId }),
  removeCandidate: (id: string, stepId: string, accountId: string) =>
    client.delete(`/task-types/${id}/steps/${stepId}/candidates/${accountId}`),
  addWebhook: (id: string, stepId: string, data: object) =>
    client.post(`/task-types/${id}/steps/${stepId}/webhooks`, data),
  removeWebhook: (id: string, stepId: string, webhookId: string) =>
    client.delete(`/task-types/${id}/steps/${stepId}/webhooks/${webhookId}`),
  copy: (id: string) => client.post(`/task-types/${id}/copy`),
  addTemplate: (id: string, data: object) => client.post(`/task-types/${id}/templates`, data),
  uploadTemplate: (id: string, name: string, file: File) => {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('file', file);
    return client.post(`/task-types/${id}/templates/upload`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  removeTemplate: (id: string, templateId: string) => client.delete(`/task-types/${id}/templates/${templateId}`),
};

/* ── Accounts ───────────────────────────────────────────────── */
export const accountsApi = {
  list: (params?: { role?: string; page?: number; limit?: number }) => client.get('/accounts', { params }),
  update: (id: string, data: object) => client.patch(`/accounts/${id}`, data),
  delete: (id: string) => client.delete(`/accounts/${id}`),
};

/* ── Brands ─────────────────────────────────────────────────── */
export const brandsApi = {
  list: (params?: object) => client.get('/brands', { params }),
  get: (id: string) => client.get(`/brands/${id}`),
  create: (data: object) => client.post('/brands', data),
  update: (id: string, data: object) => client.patch(`/brands/${id}`, data),
  delete: (id: string) => client.delete(`/brands/${id}`),
  listRules: () => client.get('/brands/assignment-rules'),
  updateRule: (id: string, data: object) => client.patch(`/brands/assignment-rules/${id}`, data),
  menu: (id: string, params?: object) => client.get(`/brands/${id}/menu`, { params }),
  menuCategories: (id: string) => client.get(`/brands/${id}/menu/categories`),
  replaceMenuCategories: (id: string, categories: Array<{ categoryId: string; name: string; order?: number; active?: boolean }>) =>
    client.put(`/brands/${id}/menu/categories`, { categories }),
  downloadCommercialMenuTemplate: (id: string) =>
    client.get(`/brands/${id}/menu/commercial-template`, { responseType: 'blob' }),
  promotions: (id: string, params?: object) => client.get(`/brands/${id}/promotions`, { params }),
};

export const accessControlApi = {
  matrix: () => client.get('/access-control/matrix'),
  areaAccess: () => client.get('/access-control/area-access'),
  updateAreaAccess: (area: string, accountId: string, permissions: string[]) =>
    client.put(`/access-control/area-access/${area}/${accountId}`, { permissions }),
  updateRole: (role: string, data: { permissions: string[]; sectionIds: string[] }) =>
    client.put(`/access-control/roles/${role}`, data),
  roleSectionProfile: (role: string, sectionId: string) =>
    client.get(`/access-control/role-sections/${role}/${sectionId}`),
  updateRoleSectionProfile: (role: string, sectionId: string, data: object) =>
    client.put(`/access-control/role-sections/${role}/${sectionId}`, data),
  accounts: (params?: { q?: string; page?: number; limit?: number }) =>
    client.get('/access-control/accounts', { params }),
  accountProfile: (accountId: string) => client.get(`/access-control/accounts/${accountId}`),
  updateAccountProfile: (accountId: string, data: object) =>
    client.put(`/access-control/accounts/${accountId}`, data),
  audits: (params?: { page?: number; limit?: number }) => client.get('/access-control/audits', { params }),
};

/* ── Shops ──────────────────────────────────────────────────── */
export const shopsApi = {
  list: (params?: object) => client.get('/shops', { params }),
  get: (id: string) => client.get(`/shops/${id}`),
  create: (data: object) => client.post('/shops', data),
  createBatch: (shops: object[]) => client.post('/shops/batch', { shops }),
  downloadImportTemplate: () => client.get('/shops/import-template', { responseType: 'blob' }),
  batchStatus: (ids: string[], status: string) => client.patch('/shops/batch-status', { ids, status }),
  update: (id: string, data: object) => client.patch(`/shops/${id}`, data),
  delete: (id: string) => client.delete(`/shops/${id}`),
  addSchedule: (id: string, data: object) => client.post(`/shops/${id}/schedules`, data),
};

/* ── Applications ───────────────────────────────────────────── */
export const applicationsApi = {
  list: (params?: object) => client.get('/applications', { params }),
  get: (id: string) => client.get(`/applications/${id}`),
  create: (data: object) => client.post('/applications', data),
  update: (id: string, data: object) => client.patch(`/applications/${id}`, data),
  delete: (id: string) => client.delete(`/applications/${id}`),
};

/* ── Tasks ──────────────────────────────────────────────────── */
export const tasksApi = {
  list: (params?: object) => client.get<{ data: unknown[]; total: number; page: number; limit: number }>('/tasks', { params }),
  dashboardSummary: () => client.get<import('../types').TaskDashboardSummary>('/tasks/dashboard-summary'),
  filterOptions: () => client.get<{ sections: { id: string; name: string; order: number }[] }>('/tasks/filter-options'),
  get: (id: string) => client.get(`/tasks/${id}`),
  create: (data: object) => client.post('/tasks', data),
  completeStep: (taskId: string, stepId: string, data: object) =>
    client.patch(`/tasks/${taskId}/steps/${stepId}/complete`, data),
  blockStep: (taskId: string, stepId: string, data: object) =>
    client.patch(`/tasks/${taskId}/steps/${stepId}/block`, data),
  failStep: (taskId: string, stepId: string, data: object) =>
    client.patch(`/tasks/${taskId}/steps/${stepId}/fail`, data),
  retryStep: (taskId: string, stepId: string) =>
    client.patch(`/tasks/${taskId}/steps/${stepId}/retry`),
  forceRetryStep: (taskId: string, stepId: string) =>
    client.patch(`/tasks/${taskId}/steps/${stepId}/force-retry`),
  startStep: (taskId: string, stepId: string) =>
    client.patch(`/tasks/${taskId}/steps/${stepId}/start`),
  assignStep: (taskId: string, stepId: string, accountId: string) =>
    client.patch(`/tasks/${taskId}/steps/${stepId}/assign`, { accountId }),
  bulkReassign: (taskIds: string[], accountId: string) =>
    client.patch('/tasks/bulk-reassign', { taskIds, accountId }),
  assignableBpos: () => client.get<{ data: Account[] }>('/tasks/assignable-bpos'),
  downloadStepExport: (taskId: string, stepId: string, format: 'xlsx' | 'json' = 'xlsx') =>
    client.get<{ fileKey: string; mimeType: string; contentBase64: string }>(
      `/tasks/${taskId}/steps/${stepId}/download`,
      { params: { format } },
    ),
  assistantContext: (taskTypeId: string) =>
    client.get<import('../types').AssistantContext>(`/tasks/validation-assistant/${taskTypeId}/context`),
  assistantMessage: (taskTypeId: string, question: string, locale: string) =>
    client.post<{ answer: string }>(`/tasks/validation-assistant/${taskTypeId}/message`, { question, locale }),
  uploadExcel: (formData: FormData) =>
    client.post<import('../types').FileValidationResult>('/tasks/upload-excel', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  uploadImage: (formData: FormData) =>
    client.post<import('../types').FileValidationResult>('/tasks/upload-image', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  downloadTemplate: (url: string) => {
    const apiMarker = '/api/';
    const markerIndex = url.indexOf(apiMarker);
    const apiPath = markerIndex >= 0 ? `/${url.slice(markerIndex + apiMarker.length)}` : url;
    return client.get<Blob>(apiPath, { responseType: 'blob' });
  },
};

export const sftpApplicationsApi = {
  list: (params?: object) => client.get('/sftp-applications', { params }),
  create: (data: object) => client.post('/sftp-applications', data),
  update: (id: string, data: object) => client.patch(`/sftp-applications/${id}`, data),
  delete: (id: string) => client.delete(`/sftp-applications/${id}`),
  test: (id: string) => client.post(`/sftp-applications/${id}/test`),
};

export const fileIntegrationsApi = {
  list: (kind: 'complex_promotion_reader' | 'price_filter' | 'store_file_splitter' | 'daily_status_activation') => client.get(`/integrations/file-integrations/rules/${kind}`),
  create: (data: object) => client.post('/integrations/file-integrations/rules', data),
  update: (id: string, data: object) => client.patch(`/integrations/file-integrations/rules/${id}`, data),
  delete: (id: string) => client.delete(`/integrations/file-integrations/rules/${id}`),
  run: (id: string) => client.post(`/integrations/file-integrations/rules/${id}/run`),
  stop: (id: string) => client.post(`/integrations/file-integrations/rules/${id}/stop`),
  executions: (id: string, page = 1) => client.get(`/integrations/file-integrations/rules/${id}/executions`, { params: { page } }),
  download: (executionId: string, fileName: string) => client.get(`/integrations/file-integrations/executions/${executionId}/files/${encodeURIComponent(fileName)}`),
};

export const targetedMenuApi = {
  list: () => client.get('/integrations/targeted-menu/rules'),
  create: (data: object) => client.post('/integrations/targeted-menu/rules', data),
  update: (id: string, data: object) => client.patch(`/integrations/targeted-menu/rules/${id}`, data),
  delete: (id: string) => client.delete(`/integrations/targeted-menu/rules/${id}`),
  run: (id: string) => client.post(`/integrations/targeted-menu/rules/${id}/run`),
  stop: (id: string) => client.post(`/integrations/targeted-menu/rules/${id}/stop`),
};

export const offerMenuUploadApi = {
  list: () => client.get('/integrations/offer-menu-upload/rules'),
  create: (data: object) => client.post('/integrations/offer-menu-upload/rules', data),
  update: (id: string, data: object) => client.patch(`/integrations/offer-menu-upload/rules/${id}`, data),
  delete: (id: string) => client.delete(`/integrations/offer-menu-upload/rules/${id}`),
  run: (id: string) => client.post(`/integrations/offer-menu-upload/rules/${id}/run`),
  stop: (id: string) => client.post(`/integrations/offer-menu-upload/rules/${id}/stop`),
};

export const menuCopyApi = {
  list: () => client.get('/integrations/menu-copy/executions'),
  create: (data: object) => client.post('/integrations/menu-copy/executions', data),
  stop: (id: string) => client.post(`/integrations/menu-copy/executions/${id}/stop`),
};

export const promotionApi = {
  contract: () => client.get('/integrations/promotion-api/contract'),
  execute: (data: object) => client.post('/integrations/promotion-api/execute', data),
  executions: (page = 1) => client.get('/integrations/promotion-api/executions', { params: { page } }),
};

/* ── BPO Management ─────────────────────────────────────────── */
export const bpoApi = {
  myTasks: () => client.get('/bpo-management/my-tasks'),
  myPerformance: () => client.get('/bpo-management/my-performance'),
  team: (filters?: { taskTypeId?: string; year?: number; month?: number; week?: number }) =>
    client.get('/bpo-management/team', { params: filters }),
  filterOptions: (year?: number) =>
    client.get<{ years: number[]; months: number[]; weeks: number[] }>('/bpo-management/filter-options', { params: year ? { year } : {} }),
  teamHistory: (page = 1, limit = 25, filters?: { taskTypeId?: string; year?: number; month?: number; week?: number }) =>
    client.get('/bpo-management/team/history', { params: { page, limit, ...filters } }),
  bpoPerf: (id: string) => client.get(`/bpo-management/team/${id}`),
  bpoTasks: (id: string, page = 1, limit = 25, status?: string) =>
    client.get(`/bpo-management/team/${id}/tasks`, { params: { page, limit, status: status || undefined } }),
};

/* ── Invitations ─────────────────────────────────────────────── */
export const invitationsApi = {
  list: (params?: { page?: number; limit?: number }) => client.get('/invitations', { params }),
  create: (data: object) => client.post('/invitations', data),
  delete: (id: string) => client.delete(`/invitations/${id}`),
  use: (token: string, data: object) => client.post(`/invitations/${token}/use`, data),
};

/* ── App Config ──────────────────────────────────────────────── */
export const appConfigApi = {
  all: () => client.get<Record<string, AppConfigOptionRaw[]>>('/app-config'),
  byCategory: (cat: string) => client.get<AppConfigOptionRaw[]>(`/app-config/${cat}`),
  upsert: (data: object) => client.post('/app-config', data),
  patch: (id: string, data: object) => client.patch(`/app-config/${id}`, data),
  remove: (id: string) => client.delete(`/app-config/${id}`),
};

/* ── Brand Assignment Rules ──────────────────────────────────── */
export const assignmentRulesApi = {
  list: () => client.get('/brands/assignment-rules'),
  update: (ruleId: string, modo: string) => client.patch(`/brands/assignment-rules/${ruleId}`, { modo }),
  addCandidate: (ruleId: string, accountId: string) =>
    client.post(`/brands/assignment-rules/${ruleId}/candidates`, { accountId }),
  removeCandidate: (ruleId: string, accountId: string) =>
    client.delete(`/brands/assignment-rules/${ruleId}/candidates/${accountId}`),
};

/* ── Integrations: Auto Open ─────────────────────────────────── */
export const integrationsApi = {
  listPools: () => client.get('/integrations/auto-open/pools'),
  createPool: (data: object) => client.post('/integrations/auto-open/pools', data),
  updatePool: (id: string, data: object) => client.patch(`/integrations/auto-open/pools/${id}`, data),
  deletePool: (id: string) => client.delete(`/integrations/auto-open/pools/${id}`),
  runPool: (id: string) => client.post(`/integrations/auto-open/pools/${id}/run`),
  listExecutions: (poolId: string, page = 1) =>
    client.get(`/integrations/auto-open/pools/${poolId}/executions`, { params: { page } }),
  sendNotification: (data: { title?: string; message: string; webhookIds: string[]; color?: string }) =>
    client.post('/integrations/auto-open/notify', data),
};

/* ── Integrations: Auto Turn Off Items ─────────────────────────────────── */
export const autoTurnOffApi = {
  listPools: () => client.get('/integrations/auto-turn-off/pools'),
  createPool: (data: object) => client.post('/integrations/auto-turn-off/pools', data),
  updatePool: (id: string, data: object) => client.patch(`/integrations/auto-turn-off/pools/${id}`, data),
  deletePool: (id: string) => client.delete(`/integrations/auto-turn-off/pools/${id}`),
  createRule: (poolId: string, data: object) => client.post(`/integrations/auto-turn-off/pools/${poolId}/rules`, data),
  updateRule: (id: string, data: object) => client.patch(`/integrations/auto-turn-off/rules/${id}`, data),
  deleteRule: (id: string) => client.delete(`/integrations/auto-turn-off/rules/${id}`),
  runRule: (id: string) => client.post(`/integrations/auto-turn-off/rules/${id}/run`),
  stopRule: (id: string) => client.post(`/integrations/auto-turn-off/rules/${id}/stop`),
  listExecutions: (poolId: string, page = 1) =>
    client.get(`/integrations/auto-turn-off/pools/${poolId}/executions`, { params: { page } }),
  listExecutionShops: (executionId: string, page = 1, limit = 50) =>
    client.get(`/integrations/auto-turn-off/executions/${executionId}/shops`, { params: { page, limit } }),
};

export const autoFetchApi = {
  listPools: (kind: 'stores' | 'menu') => client.get(`/integrations/auto-fetch/${kind}/pools`),
  updatePool: (id: string, data: object) => client.patch(`/integrations/auto-fetch/pools/${id}`, data),
  runPool: (id: string) => client.post(`/integrations/auto-fetch/pools/${id}/run`),
  stopPool: (id: string) => client.post(`/integrations/auto-fetch/pools/${id}/stop`),
  addCkaBrand: (id: string, brandId: string) => client.post(`/integrations/auto-fetch/pools/${id}/brands`, { brandId }),
  removeCkaBrand: (id: string, brandId: string) => client.delete(`/integrations/auto-fetch/pools/${id}/brands/${brandId}`),
  updateBrand: (id: string, brandId: string, active: boolean) => client.patch(`/integrations/auto-fetch/pools/${id}/brands/${brandId}`, { active }),
  runBrand: (id: string, brandId: string) => client.post(`/integrations/auto-fetch/pools/${id}/brands/${brandId}/run`),
  stopBrand: (id: string, brandId: string) => client.post(`/integrations/auto-fetch/pools/${id}/brands/${brandId}/stop`),
  listExecutions: (id: string, page = 1) => client.get(`/integrations/auto-fetch/pools/${id}/executions`, { params: { page } }),
};

export const storeEmergenciesApi = {
  list: (page = 1, limit = 20) => client.get('/integrations/store-emergencies', { params: { page, limit } }),
  summary: () => client.get('/integrations/store-emergencies/summary'),
  get: (id: string) => client.get(`/integrations/store-emergencies/${id}`),
  create: (data: object) => client.post('/integrations/store-emergencies', data),
  updateReopening: (id: string, endsAt: string) => client.patch(`/integrations/store-emergencies/${id}/reopening`, { endsAt }),
  restoreNow: (id: string) => client.post(`/integrations/store-emergencies/${id}/restore`),
  retryFailures: (id: string) => client.post(`/integrations/store-emergencies/${id}/retry-failures`),
};

export const forcedOpenApi = {
  list: (page = 1, limit = 20) => client.get('/integrations/forced-open', { params: { page, limit } }),
  get: (id: string) => client.get(`/integrations/forced-open/${id}`),
  create: (data: object) => client.post('/integrations/forced-open', data),
};

/* ── Admin (super_admin only) ────────────────────────────────── */
export const adminApi = {
  queueStatus: () => client.get('/admin/queue-status'),
  handlerLogs: (params?: { page?: number; limit?: number; status?: string }) =>
    client.get('/admin/handler-logs', { params }),
};

// Helper type (used inline, exported for api file self-containment)
export interface AppConfigOptionRaw {
  id: string; category: string; value: string; label: string; active: boolean; order: number;
}
