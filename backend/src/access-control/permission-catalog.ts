import { AccountRole } from '@prisma/client';

const ALL_EDITABLE = [AccountRole.user, AccountRole.bpo, AccountRole.admin, AccountRole.director];
// Every editable role can receive any permission explicitly. The defaults remain
// conservative, but the access matrix is the source of truth for customization.
const ADMIN = ALL_EDITABLE;
const ADMIN_DIRECTOR = ALL_EDITABLE;
const BPO_ADMIN = ALL_EDITABLE;

export const PERMISSION_CATALOG = [
  { key: 'dashboard.view', group: 'General', label: 'Dashboard', description: 'Ver el resumen principal.', allowedRoles: ALL_EDITABLE },
  { key: 'brands.view', group: 'Catálogo', label: 'Brands y tiendas', description: 'Consultar marcas, tiendas, menús y promociones.', allowedRoles: ALL_EDITABLE },
  { key: 'brands.create', group: 'Catálogo', label: 'Crear brands', description: 'Crear nuevas marcas desde el catálogo.', allowedRoles: BPO_ADMIN },
  { key: 'brands.update', group: 'Catálogo', label: 'Editar brands', description: 'Modificar marcas, responsables y reglas de asignación.', allowedRoles: ADMIN },
  { key: 'brands.delete', group: 'Catálogo', label: 'Eliminar brands', description: 'Eliminar una marca y sus relaciones permitidas.', allowedRoles: ADMIN },
  { key: 'tasks.view', group: 'Tareas', label: 'Tareas', description: 'Consultar tareas de acuerdo con el alcance del rol y sus secciones.', allowedRoles: ALL_EDITABLE },
  { key: 'tasks.create', group: 'Tareas', label: 'Crear tareas', description: 'Iniciar tareas y usar el asistente de validación.', allowedRoles: ALL_EDITABLE },
  { key: 'tasks.execute', group: 'Tareas', label: 'Ejecutar pasos', description: 'Iniciar, completar, fallar, bloquear y reintentar pasos.', allowedRoles: BPO_ADMIN },
  { key: 'tasks.assign', group: 'Tareas', label: 'Asignar tareas', description: 'Asignar pasos de tareas a integrantes BPO.', allowedRoles: ADMIN },
  { key: 'task_types.manage', group: 'Task Types', label: 'Administrar Task Types', description: 'Consultar y configurar tipos, pasos, campos y handlers. Es independiente de los permisos de Tareas.', allowedRoles: ADMIN },
  { key: 'bpo.queue', group: 'BPO', label: 'Mi cola BPO', description: 'Ver y trabajar la cola personal de BPO.', allowedRoles: BPO_ADMIN },
  { key: 'bpo.team', group: 'BPO', label: 'Gestión BPO', description: 'Consultar equipos, rendimiento e historial BPO.', allowedRoles: ADMIN_DIRECTOR },
  { key: 'applications.manage', group: 'Administración', label: 'Consultar aplicaciones DiDi', description: 'Consultar aplicaciones API y sus asignaciones.', allowedRoles: BPO_ADMIN },
  { key: 'applications.create', group: 'Administración', label: 'Crear aplicaciones DiDi', description: 'Registrar una nueva aplicación API.', allowedRoles: BPO_ADMIN },
  { key: 'applications.update', group: 'Administración', label: 'Editar aplicaciones DiDi', description: 'Modificar credenciales y configuración de aplicaciones API.', allowedRoles: ADMIN },
  { key: 'applications.delete', group: 'Administración', label: 'Eliminar aplicaciones DiDi', description: 'Eliminar una aplicación API.', allowedRoles: ADMIN },
  { key: 'sftp_applications.manage', group: 'Administración', label: 'Consultar aplicaciones SFTP', description: 'Consultar credenciales y conexiones SFTP.', allowedRoles: ADMIN },
  { key: 'sftp_applications.update', group: 'Administración', label: 'Administrar aplicaciones SFTP', description: 'Crear, editar y eliminar conexiones SFTP.', allowedRoles: ADMIN },
  { key: 'sftp_applications.test', group: 'Administración', label: 'Probar aplicaciones SFTP', description: 'Ejecutar pruebas de conectividad SFTP.', allowedRoles: ADMIN },
  { key: 'integrations.forced_open', group: 'Integraciones', label: 'Auto Open Stores', description: 'Consultar pools, reglas y resultados de aperturas.', allowedRoles: ADMIN },
  { key: 'integrations.forced_open.configure', group: 'Integraciones', label: 'Configurar Auto Open', description: 'Crear, editar y eliminar pools de Auto Open.', allowedRoles: ADMIN },
  { key: 'integrations.forced_open.execute', group: 'Integraciones', label: 'Ejecutar Auto Open', description: 'Ejecutar pools y enviar notificaciones.', allowedRoles: ADMIN },
  { key: 'integrations.auto_stores_fetch', group: 'Integraciones', label: 'Auto Stores Fetch', description: 'Consultar sincronización de tiendas.', allowedRoles: ADMIN },
  { key: 'integrations.auto_stores_fetch.configure', group: 'Integraciones', label: 'Configurar Stores Fetch', description: 'Editar pools y marcas de Auto Stores Fetch.', allowedRoles: ADMIN },
  { key: 'integrations.auto_stores_fetch.execute', group: 'Integraciones', label: 'Ejecutar Stores Fetch', description: 'Iniciar y detener pools o marcas de Stores Fetch.', allowedRoles: ADMIN },
  { key: 'integrations.auto_menu_fetch', group: 'Integraciones', label: 'Auto Menu Fetch', description: 'Consultar sincronización de menús.', allowedRoles: ADMIN },
  { key: 'integrations.auto_menu_fetch.configure', group: 'Integraciones', label: 'Configurar Menu Fetch', description: 'Editar pools y marcas de Auto Menu Fetch.', allowedRoles: ADMIN },
  { key: 'integrations.auto_menu_fetch.execute', group: 'Integraciones', label: 'Ejecutar Menu Fetch', description: 'Iniciar y detener pools o marcas de Menu Fetch.', allowedRoles: ADMIN },
  { key: 'integrations.auto_turn_off', group: 'Integraciones', label: 'Auto Turn Off Items', description: 'Consultar pools, reglas y resultados de stock.', allowedRoles: ADMIN },
  { key: 'integrations.auto_turn_off.configure', group: 'Integraciones', label: 'Configurar Turn Off Items', description: 'Crear, editar y eliminar pools y reglas de stock.', allowedRoles: ADMIN },
  { key: 'integrations.auto_turn_off.execute', group: 'Integraciones', label: 'Ejecutar Turn Off Items', description: 'Ejecutar y detener reglas de stock.', allowedRoles: ADMIN },
  { key: 'integrations.emergencies', group: 'Integraciones', label: 'Consultar emergencias', description: 'Consultar apagados y reaperturas de tiendas.', allowedRoles: ADMIN },
  { key: 'integrations.emergencies.execute', group: 'Integraciones', label: 'Ejecutar emergencias', description: 'Crear apagados y forzar reaperturas de tiendas.', allowedRoles: ADMIN },
  { key: 'integrations.promotions_sftp', group: 'Integraciones', label: 'Promociones SFTP', description: 'Consultar promociones provenientes de SFTP.', allowedRoles: ADMIN },
  { key: 'integrations.promotions_sftp.configure', group: 'Integraciones', label: 'Configurar promociones SFTP', description: 'Crear, editar y eliminar reglas de promociones SFTP.', allowedRoles: ADMIN },
  { key: 'integrations.promotions_sftp.execute', group: 'Integraciones', label: 'Ejecutar promociones SFTP', description: 'Iniciar y detener reglas de promociones SFTP.', allowedRoles: ADMIN },
  { key: 'integrations.custom', group: 'Integraciones', label: 'Custom Integrations', description: 'Consultar herramientas SFTP y copias de menú.', allowedRoles: ADMIN },
  { key: 'integrations.custom.configure', group: 'Integraciones', label: 'Configurar Custom Integrations', description: 'Crear, editar y eliminar reglas o copias de menú.', allowedRoles: ADMIN },
  { key: 'integrations.custom.execute', group: 'Integraciones', label: 'Ejecutar Custom Integrations', description: 'Iniciar, detener y reejecutar integraciones personalizadas.', allowedRoles: ADMIN },
  { key: 'integrations.promotion_api', group: 'Integraciones', label: 'Promociones API', description: 'Consultar contrato e historial de promociones API.', allowedRoles: ADMIN },
  { key: 'integrations.promotion_api.execute', group: 'Integraciones', label: 'Ejecutar promociones API', description: 'Ejecutar cargas de promociones mediante API.', allowedRoles: ADMIN },
  { key: 'config.handlers', group: 'Configuración', label: 'Handlers', description: 'Consultar handlers; las mutaciones sensibles siguen reservadas a Super Admin.', allowedRoles: ADMIN },
  { key: 'config.webhooks', group: 'Configuración', label: 'Consultar webhooks', description: 'Consultar webhooks configurados.', allowedRoles: ADMIN },
  { key: 'config.webhooks.update', group: 'Configuración', label: 'Administrar webhooks', description: 'Crear, editar y eliminar webhooks.', allowedRoles: ADMIN },
  { key: 'config.invitations', group: 'Configuración', label: 'Consultar invitaciones', description: 'Consultar invitaciones dentro del alcance del rol.', allowedRoles: ADMIN },
  { key: 'config.invitations.update', group: 'Configuración', label: 'Administrar invitaciones', description: 'Crear y revocar invitaciones.', allowedRoles: ADMIN },
  { key: 'config.users', group: 'Configuración', label: 'Consultar usuarios', description: 'Consultar cuentas dentro del alcance del rol.', allowedRoles: ADMIN },
  { key: 'config.users.update', group: 'Configuración', label: 'Editar usuarios', description: 'Editar roles, sección y configuración de cuentas.', allowedRoles: ADMIN },
  { key: 'config.users.delete', group: 'Configuración', label: 'Eliminar usuarios', description: 'Desactivar cuentas dentro del alcance permitido.', allowedRoles: ADMIN },
  { key: 'sections.view', group: 'Configuración', label: 'Consultar secciones', description: 'Usar secciones en filtros, usuarios y tareas.', allowedRoles: ADMIN_DIRECTOR },
  { key: 'sections.manage', group: 'Configuración', label: 'Secciones', description: 'Crear, ordenar y asignar secciones.', allowedRoles: ADMIN },
  { key: 'settings.manage', group: 'Configuración', label: 'Settings', description: 'Administrar catálogos y reglas globales.', allowedRoles: ALL_EDITABLE },
  { key: 'system.manage', group: 'Configuración', label: 'System Panel', description: 'Acceder a diagnósticos y controles del sistema.', allowedRoles: ALL_EDITABLE },
] as const;

export type PermissionKey = typeof PERMISSION_CATALOG[number]['key'];
export const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.map(item => item.key);
export const PERMISSION_KEY_SET = new Set<string>(ALL_PERMISSION_KEYS);
export const PERMISSION_ALLOWED_ROLES = new Map<string, readonly AccountRole[]>(
  PERMISSION_CATALOG.map(item => [item.key, item.allowedRoles]),
);
