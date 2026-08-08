import { AccountRole } from '@prisma/client';

const ALL_EDITABLE = [AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.director];
const ADMIN = [AccountRole.admin];
const ADMIN_DIRECTOR = [AccountRole.admin, AccountRole.director];
const BPO_ADMIN = [AccountRole.bpo, AccountRole.admin];

export const PERMISSION_CATALOG = [
  { key: 'dashboard.view', group: 'General', label: 'Dashboard', description: 'Ver el resumen principal.', allowedRoles: ALL_EDITABLE },
  { key: 'brands.view', group: 'Catálogo', label: 'Brands y tiendas', description: 'Consultar marcas, tiendas, menús y promociones.', allowedRoles: ALL_EDITABLE },
  { key: 'brands.create', group: 'Catálogo', label: 'Crear brands', description: 'Crear nuevas marcas desde el catálogo.', allowedRoles: BPO_ADMIN },
  { key: 'tasks.view', group: 'Tareas', label: 'Tareas', description: 'Consultar tareas de acuerdo con el alcance del rol y sus secciones.', allowedRoles: ALL_EDITABLE },
  { key: 'tasks.create', group: 'Tareas', label: 'Crear tareas', description: 'Iniciar tareas y usar el asistente de validación.', allowedRoles: [AccountRole.user, AccountRole.bpo, AccountRole.admin] },
  { key: 'task_types.manage', group: 'Tareas', label: 'Task Types', description: 'Configurar tipos, pasos, campos y handlers de tareas.', allowedRoles: ADMIN },
  { key: 'bpo.queue', group: 'BPO', label: 'Mi cola BPO', description: 'Ver y trabajar la cola personal de BPO.', allowedRoles: BPO_ADMIN },
  { key: 'bpo.team', group: 'BPO', label: 'Gestión BPO', description: 'Consultar equipos, rendimiento e historial BPO.', allowedRoles: ADMIN_DIRECTOR },
  { key: 'applications.manage', group: 'Administración', label: 'Aplicaciones DiDi', description: 'Consultar y administrar aplicaciones API según las acciones permitidas al rol.', allowedRoles: BPO_ADMIN },
  { key: 'sftp_applications.manage', group: 'Administración', label: 'Aplicaciones SFTP', description: 'Administrar credenciales y conexiones SFTP.', allowedRoles: ADMIN },
  { key: 'integrations.forced_open', group: 'Integraciones', label: 'Auto Open Stores', description: 'Configurar y ejecutar aperturas automáticas.', allowedRoles: ADMIN },
  { key: 'integrations.auto_stores_fetch', group: 'Integraciones', label: 'Auto Stores Fetch', description: 'Descargar y sincronizar tiendas.', allowedRoles: ADMIN },
  { key: 'integrations.auto_menu_fetch', group: 'Integraciones', label: 'Auto Menu Fetch', description: 'Descargar y sincronizar menús.', allowedRoles: ADMIN },
  { key: 'integrations.auto_turn_off', group: 'Integraciones', label: 'Auto Turn Off Items', description: 'Administrar reglas de stock automático.', allowedRoles: ADMIN },
  { key: 'integrations.emergencies', group: 'Integraciones', label: 'Emergencias', description: 'Apagar y reabrir tiendas por emergencia.', allowedRoles: ADMIN },
  { key: 'integrations.promotions_sftp', group: 'Integraciones', label: 'Promociones SFTP', description: 'Consultar promociones provenientes de SFTP.', allowedRoles: ADMIN },
  { key: 'integrations.custom', group: 'Integraciones', label: 'Custom Integrations', description: 'Administrar herramientas SFTP y copias de menú.', allowedRoles: ADMIN },
  { key: 'integrations.promotion_api', group: 'Integraciones', label: 'Promociones API', description: 'Administrar integraciones de promociones API.', allowedRoles: ADMIN },
  { key: 'config.handlers', group: 'Configuración', label: 'Handlers', description: 'Consultar handlers; las mutaciones sensibles siguen reservadas a Super Admin.', allowedRoles: ADMIN },
  { key: 'config.webhooks', group: 'Configuración', label: 'Webhooks', description: 'Consultar y administrar webhooks.', allowedRoles: ADMIN },
  { key: 'config.invitations', group: 'Configuración', label: 'Invitaciones', description: 'Crear y revocar invitaciones dentro del alcance del rol.', allowedRoles: ADMIN },
  { key: 'config.users', group: 'Configuración', label: 'Usuarios', description: 'Consultar y editar cuentas dentro del alcance del rol.', allowedRoles: ADMIN },
  { key: 'sections.view', group: 'Configuración', label: 'Consultar secciones', description: 'Usar secciones en filtros, usuarios y tareas.', allowedRoles: ADMIN_DIRECTOR },
  { key: 'sections.manage', group: 'Configuración', label: 'Secciones', description: 'Crear, ordenar y asignar secciones.', allowedRoles: ADMIN },
  { key: 'settings.manage', group: 'Configuración', label: 'Settings', description: 'Administrar catálogos y reglas globales. Exclusivo de Super Admin.', allowedRoles: [] },
  { key: 'system.manage', group: 'Configuración', label: 'System Panel', description: 'Acceder a diagnósticos y controles del sistema. Exclusivo de Super Admin.', allowedRoles: [] },
] as const;

export type PermissionKey = typeof PERMISSION_CATALOG[number]['key'];
export const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.map(item => item.key);
export const PERMISSION_KEY_SET = new Set<string>(ALL_PERMISSION_KEYS);
export const PERMISSION_ALLOWED_ROLES = new Map<string, readonly AccountRole[]>(
  PERMISSION_CATALOG.map(item => [item.key, item.allowedRoles]),
);
