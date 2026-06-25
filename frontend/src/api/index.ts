import client from './client';

/* ── Auth ───────────────────────────────────────────────────── */
export const authApi = {
  devLogin: (email: string) => client.post('/auth/dev-login', { email }),
  me: () => client.get('/auth/me'),
};

/* ── Sections ───────────────────────────────────────────────── */
export const sectionsApi = {
  list: () => client.get('/sections'),
  create: (data: { name: string }) => client.post('/sections', data),
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
  create: (data: object) => client.post('/task-types', data),
  update: (id: string, data: object) => client.patch(`/task-types/${id}`, data),
  delete: (id: string) => client.delete(`/task-types/${id}`),
  toggleActive: (id: string) => client.patch(`/task-types/${id}/toggle-active`),
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
};

/* ── Shops ──────────────────────────────────────────────────── */
export const shopsApi = {
  list: (params?: object) => client.get('/shops', { params }),
  get: (id: string) => client.get(`/shops/${id}`),
  create: (data: object) => client.post('/shops', data),
  createBatch: (shops: object[]) => client.post('/shops/batch', { shops }),
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
  startStep: (taskId: string, stepId: string) =>
    client.patch(`/tasks/${taskId}/steps/${stepId}/start`),
  assignStep: (taskId: string, stepId: string, accountId: string) =>
    client.patch(`/tasks/${taskId}/steps/${stepId}/assign`, { accountId }),
  uploadExcel: (formData: FormData) =>
    client.post<{ tempPath: string; originalName: string }>('/tasks/upload-excel', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
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

// Helper type (used inline, exported for api file self-containment)
export interface AppConfigOptionRaw {
  id: string; category: string; value: string; label: string; active: boolean; order: number;
}
