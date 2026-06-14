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
  list: () => client.get('/task-types'),
  get: (id: string) => client.get(`/task-types/${id}`),
  create: (data: object) => client.post('/task-types', data),
  update: (id: string, data: object) => client.patch(`/task-types/${id}`, data),
  delete: (id: string) => client.delete(`/task-types/${id}`),
  addStep: (id: string, data: object) => client.post(`/task-types/${id}/steps`, data),
  updateStep: (id: string, stepId: string, data: object) => client.patch(`/task-types/${id}/steps/${stepId}`, data),
  deleteStep: (id: string, stepId: string) => client.delete(`/task-types/${id}/steps/${stepId}`),
  addField: (id: string, data: object) => client.post(`/task-types/${id}/fields`, data),
  updateField: (id: string, fieldId: string, data: object) => client.patch(`/task-types/${id}/fields/${fieldId}`, data),
  deleteField: (id: string, fieldId: string) => client.delete(`/task-types/${id}/fields/${fieldId}`),
  addCandidate: (id: string, stepId: string, accountId: string) =>
    client.post(`/task-types/${id}/steps/${stepId}/candidates`, { accountId }),
  removeCandidate: (id: string, stepId: string, accountId: string) =>
    client.delete(`/task-types/${id}/steps/${stepId}/candidates/${accountId}`),
  addWebhook: (id: string, stepId: string, data: object) =>
    client.post(`/task-types/${id}/steps/${stepId}/webhooks`, data),
  removeWebhook: (id: string, stepId: string, webhookId: string) =>
    client.delete(`/task-types/${id}/steps/${stepId}/webhooks/${webhookId}`),
};

/* ── Accounts ───────────────────────────────────────────────── */
export const accountsApi = {
  list: (role?: string) => client.get('/accounts', { params: role ? { role } : {} }),
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
};

/* ── BPO Management ─────────────────────────────────────────── */
export const bpoApi = {
  myTasks: () => client.get('/bpo-management/my-tasks'),
  myPerformance: () => client.get('/bpo-management/my-performance'),
  team: () => client.get('/bpo-management/team'),
  teamHistory: (page = 1, limit = 25) => client.get('/bpo-management/team/history', { params: { page, limit } }),
  bpoPerf: (id: string) => client.get(`/bpo-management/team/${id}`),
};

/* ── Invitations ─────────────────────────────────────────────── */
export const invitationsApi = {
  list: () => client.get('/invitations'),
  create: (data: object) => client.post('/invitations', data),
  delete: (id: string) => client.delete(`/invitations/${id}`),
  use: (token: string, data: object) => client.post(`/invitations/${token}/use`, data),
};
