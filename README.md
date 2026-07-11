# Guaro — Guía Técnica para Desarrolladores

Panel interno para configurar y ejecutar tareas (workflows) sobre marcas, tiendas y catálogos de un negocio de delivery (DiDi Food).

---

## Tabla de contenidos

1. [Stack y estructura general](#1-stack-y-estructura-general)
2. [Setup local](#2-setup-local)
3. [Modelo de datos (Prisma)](#3-modelo-de-datos-prisma)
4. [Roles y permisos](#4-roles-y-permisos)
5. [Módulos NestJS](#5-módulos-nestjs)
6. [Cómo crear un módulo nuevo](#6-cómo-crear-un-módulo-nuevo)
7. [Sistema de tareas](#7-sistema-de-tareas)
8. [Sistema de colas y handlers](#8-sistema-de-colas-y-handlers)
9. [Cómo crear un handler nuevo](#9-cómo-crear-un-handler-nuevo)
10. [Webhooks](#10-webhooks)
11. [Frontend](#11-frontend)
12. [Variables de entorno](#12-variables-de-entorno)
13. [Seed y datos iniciales](#13-seed-y-datos-iniciales)
14. [Despliegue](#14-despliegue)
15. [Scripts de importación masiva](#15-scripts-de-importación-masiva)
16. [Patrones y convenciones](#16-patrones-y-convenciones)

---

## 1. Stack y estructura general

| Capa | Tecnología |
|---|---|
| Backend | NestJS + TypeScript |
| ORM | Prisma 5 (PostgreSQL) |
| Colas | BullMQ (Redis) |
| Cron | @nestjs/schedule |
| Frontend | React + TypeScript + Vite |
| HTTP client | Axios + TanStack Query |
| Auth | Google OAuth 2.0 (dominio `didi-labs.com`) + JWT |
| Contenedores | Docker Compose |
| Reverse proxy | Nginx (frontend) |

### Estructura de directorios

```
Guaro-1/
├── backend/
│   └── src/
│       ├── accounts/           # Gestión de cuentas (admin, BPO, user)
│       ├── app-config/         # Enums globales editables (países, tipos, etc.)
│       ├── applications/       # Apps de DiDi Food (credentials cifradas)
│       ├── auth/               # Google OAuth + JWT + guards + decoradores
│       ├── bpo-management/     # Performance de BPOs y equipo
│       ├── brands/             # Marcas (KA/CKA/SME) y reglas de asignación
│       ├── common/             # Utilidades (crypto, filtros de error)
│       ├── dev/                # Endpoints solo para desarrollo
│       ├── handlers/           # CRUD de handlers (registro en DB)
│       ├── invitations/        # Invitaciones con token de un solo uso
│       ├── prisma/             # PrismaService (singleton)
│       ├── queue/              # BullMQ: processor + implementaciones de handlers
│       │   └── handlers/       # Un archivo por handler
│       ├── scheduler/          # Cron para activar tareas programadas
│       ├── sections/           # Secciones organizacionales (teams)
│       ├── seed/               # Script de seed
│       ├── shops/              # Tiendas dentro de marcas
│       ├── task-types/         # Plantillas de tareas (pasos, campos, webhooks)
│       ├── tasks/              # Motor de ejecución de tareas
│       ├── webhooks/           # Webhooks globales
│       ├── app.module.ts
│       └── main.ts
├── frontend/
│   └── src/
│       ├── api/                # Cliente Axios + todos los endpoints
│       ├── auth/               # AuthContext + PrivateRoute
│       ├── components/         # Layout (Sidebar, Topbar) + UI reutilizables
│       ├── i18n/               # Traducciones ES/EN + hook useT()
│       ├── pages/              # Una carpeta por sección (tasks, brands, etc.)
│       ├── types/              # Tipos TypeScript compartidos
│       ├── App.tsx             # Router (base: /guaro)
│       └── main.tsx
├── prisma/
│   ├── schema.prisma           # Fuente de verdad del esquema
│   └── constraints.sql         # CHECKs y FKs compuestas (aplicar manualmente)
├── docker-compose.yml          # Solo para desarrollo local (Postgres + Redis)
├── docker-compose.prod.yml     # Producción (app + db + redis + frontend)
└── .env.prod.example           # Variables de entorno requeridas
```

---

## 2. Setup local

### Prerrequisitos
- Node 20+
- Docker + Docker Compose
- Git

### Pasos

```bash
# 1. Clonar y entrar
git clone <repo-url>
cd Guaro-1

# 2. Levantar Postgres + Redis
docker compose up -d

# 3. Variables de entorno del backend
cp backend/.env.example backend/.env
# Editar backend/.env con los valores reales

# 4. Instalar dependencias del backend
cd backend
npm install

# 5. Generar cliente Prisma y aplicar schema
npx prisma generate --schema=../prisma/schema.prisma
npx prisma db push --schema=../prisma/schema.prisma

# 6. Aplicar constraints adicionales (FK compuestas, CHECKs)
#    Ejecutar el contenido de prisma/constraints.sql en la DB

# 7. Poblar datos iniciales
npx ts-node src/seed/seed.ts

# 8. Iniciar el backend en modo dev
npm run start:dev

# 9. Frontend (en otra terminal)
cd ../frontend
npm install
npm run dev
```

### Variables mínimas para `.env` en desarrollo

```env
DATABASE_URL=postgresql://guaro:guaro@localhost:5432/guaro?schema=public
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_SECRET=cualquier-string-largo
JWT_EXPIRES_IN=8h
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
FRONTEND_URL=http://localhost:5173
APP_SECRET_ENCRYPTION_KEY=<64 hex chars: openssl rand -hex 32>
NODE_ENV=development
```

---

## 3. Modelo de datos (Prisma)

> Fuente de verdad: `prisma/schema.prisma`
> Constraints adicionales: `prisma/constraints.sql`

### Enums principales

```prisma
enum Country           { CO, MX, CR }
enum AccountRole       { user, bpo, admin, super_admin, director }
enum ExecutionType     { manual_internal, manual_external, automatic }
enum AssignmentStrategy { fixed, round_robin, by_weight, brand_assignment, manual }
enum FormFieldTipo     { link, link_spreadsheet, texto, numero, select,
                         select_brand, select_store, select_ka_type,
                         select_country, file }
enum WebhookEvent      { on_start, on_complete, on_fail, on_assignment, on_blocked }
enum TaskStatus        { scheduled, pending, assigned, in_progress, blocked, failed, done }
enum StepStatus        { pending, in_progress, blocked, failed, done }
enum StepFailureReason { system_timed_out, bpo_timed_out, no_bpo, error_handler }
enum KaType            { KA, CKA, SME }
enum ShopStatus        { lead, application, integrated, online }
enum MenuIntegration   { api, api_whitelist, sftp, spreadsheets, bapp }
enum PickingMode       { merchant_picking_bapp, merchant_picking_dapp, dos_en_uno }
enum PaymentMode       { food_mode, prepaid_card, qr_code }
enum DayOfWeek         { monday, tuesday, wednesday, thursday, friday, saturday, sunday }
```

### Diagrama de entidades (simplificado)

```
Section ──< TaskType ──< StepDefinition ──< StepDefinitionAccount >── Account
                   └──< FormField
                   └──< TaskTypeTemplate

Application ──< Brand ──< Shop ──< Schedule
                    └──< BrandWebhook >── Webhook
                    └──< Task ──< StepInstance
                              └──< FormValue
                              └──< TaskShop >── Shop

BrandAssignmentRule ──< BrandAssignmentRuleAccount >── Account

Handler ──< StepDefinition
StepWebhook links StepDefinition ↔ Webhook (+ events[])

Account ──< Invitation (createdBy)
```

### Modelos clave

#### `Account` — Usuario del sistema
| Campo | Tipo | Descripción |
|---|---|---|
| `id` | uuid PK | |
| `name` | string | Nombre completo |
| `email` | string unique | |
| `googleSub` | string? unique | Vinculado al primer login con Google |
| `roles` | AccountRole[] | Array de roles (puede tener varios) |
| `adminModules` | string[] | Módulos admin habilitados |
| `bpoPermissions` | string[] | Permisos extra (ej. `create_brand`) |
| `sectionId` | uuid? | Section a la que pertenece |
| `workload` | int | Carga actual (para asignación by_weight) |
| `rrCounter` | int | Contador round-robin |
| `deletedAt` | datetime? | Soft-delete |

#### `TaskType` — Plantilla de tarea
| Campo | Tipo | Descripción |
|---|---|---|
| `id` | uuid PK | |
| `sectionId` | uuid | Section propietaria |
| `name` | string | Nombre del tipo de tarea |
| `schedulable` | bool | Permite fecha de inicio programada |
| `active` | bool | Disponible para crear nuevas tareas |
| `deletedAt` | datetime? | Soft-delete |

#### `StepDefinition` — Paso dentro de un TaskType
| Campo | Tipo | Descripción |
|---|---|---|
| `id` | uuid PK | |
| `taskTypeId` | uuid | |
| `name` | string | |
| `order` | int | Orden de ejecución |
| `executionType` | ExecutionType | `manual_internal`, `manual_external`, `automatic` |
| `assignmentStrategy` | AssignmentStrategy | Cómo se asigna el ejecutor |
| `handlerId` | uuid? | Solo si `executionType = automatic` |

#### `FormField` — Campo del formulario de creación de tarea
| Campo | Tipo | Descripción |
|---|---|---|
| `label` | string | Nombre visible en el formulario |
| `tipo` | FormFieldTipo | Tipo de input |
| `required` | bool | |
| `multiple` | bool | Permite seleccionar varios (en selects) |
| `options` | json? | Para campos `select` (array de `{value, label}`) |
| `order` | int | Orden en el formulario |
| `filteredById` | uuid? | Dependencia de otro campo |

#### `Task` — Instancia de ejecución
| Campo | Tipo | Descripción |
|---|---|---|
| `status` | TaskStatus | `scheduled → pending → assigned → in_progress → done/failed` |
| `brandId` | uuid? | Marca vinculada |
| `scheduledStart/End` | datetime? | Para tareas programadas |

#### `StepInstance` — Paso en ejecución
| Campo | Tipo | Descripción |
|---|---|---|
| `status` | StepStatus | `pending → in_progress → done/failed/blocked` |
| `assignedToId` | uuid? | BPO asignado |
| `result` | json? | Resultado del handler (automático) |
| `note` | string? | Notas acumuladas |
| `failureReason` | StepFailureReason? | Solo si `status = failed` |

#### `Handler` — Handler registrado en la DB
| Campo | Tipo | Descripción |
|---|---|---|
| `id` | uuid PK | |
| `name` | string unique | Debe coincidir con `registerHandler('nombre', fn)` en código |

---

## 4. Roles y permisos

### Roles disponibles

| Rol | Alcance | Qué puede hacer |
|---|---|---|
| `user` | Su section | Crear tareas de su section; ver sus tareas |
| `bpo` | Global (ejecución) | Ejecutar pasos asignados; gestionar sus marcas |
| `admin` | Su section | Configurar TaskTypes, Steps, webhooks, estrategias; invitar a su section |
| `director` | Global (solo lectura) | Ver todo, sin escritura, sin section |
| `super_admin` | Global total | Todo; único que puede crear Sections; otorga rol `director` |

### `bpoPermissions` — Permisos extra para BPO

Son strings almacenados en `Account.bpoPermissions`. Los checks se hacen en el controller:

```typescript
if (user.bpoPermissions.includes('create_brand')) { ... }
```

Ejemplos activos:
- `create_brand` — Puede crear marcas
- `create_application` — Puede crear aplicaciones DiDi

Solo el `super_admin` puede otorgar o revocar estos permisos vía `PATCH /accounts/:id`.

### Cómo proteger una ruta

```typescript
import { JwtAuthGuard }  from '../auth/guards/jwt-auth.guard';
import { RolesGuard }    from '../auth/guards/roles.guard';
import { Roles }         from '../auth/decorators/roles.decorator';
import { CurrentUser }   from '../auth/decorators/current-user.decorator';
import { AccountRole }   from '@prisma/client';

@Controller('mi-modulo')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MiController {

  // Cualquier usuario autenticado
  @Get()
  async listar(@CurrentUser() user: JwtUser) { ... }

  // Solo admin y super_admin
  @Post()
  @Roles(AccountRole.admin, AccountRole.super_admin)
  async crear(@CurrentUser() user: JwtUser, @Body() dto: CreateDto) { ... }
}
```

### `JwtUser` — Lo que devuelve `@CurrentUser()`

```typescript
interface JwtUser {
  id: string;
  email: string;
  roles: AccountRole[];
  sectionId: string | null;
  bpoPermissions: string[];
  adminModules: string[];
}
```

### Cómo crear un nuevo super_admin en la DB

```sql
INSERT INTO account (id, nombre, email, roles, created_at, updated_at)
VALUES (
  gen_random_uuid(),
  'Nombre Apellido',
  'email@didi-labs.com',
  ARRAY['super_admin']::"AccountRol"[],
  NOW(), NOW()
)
ON CONFLICT (email) DO UPDATE SET roles = ARRAY['super_admin']::"AccountRol"[];
```

El campo `google_sub` se vincula automáticamente en el primer login con Google.

---

## 5. Módulos NestJS

### Rutas disponibles

#### Auth — `/auth`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/auth/google` | Redirect a Google OAuth |
| GET | `/auth/google/callback` | Callback OAuth, emite JWT |
| GET | `/auth/me` | Usuario actual (requiere JWT) |
| POST | `/auth/dev-login` | Login por email (solo NODE_ENV=development) |

#### Accounts — `/accounts`
| Método | Ruta | Roles requeridos |
|---|---|---|
| GET | `/accounts` | admin, super_admin |
| PATCH | `/accounts/:id` | admin, super_admin |
| DELETE | `/accounts/:id` | super_admin |

#### Invitations — `/invitations`
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/invitations` | Crear invitación (admin crea para su section; super_admin para cualquiera) |
| GET | `/invitations` | Listar invitaciones |
| DELETE | `/invitations/:id` | Cancelar |
| POST | `/invitations/:token/use` | Redimir token (crea la Account) |

#### Sections — `/sections`
| Método | Ruta | Roles |
|---|---|---|
| GET | `/sections` | admin+ |
| POST | `/sections` | super_admin |
| PATCH | `/sections/:id` | super_admin |

#### Handlers — `/handlers`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/handlers` | Lista handlers registrados en DB |
| POST | `/handlers` | Registrar handler nuevo |
| DELETE | `/handlers/:id` | Eliminar |

#### Webhooks — `/webhooks`
| Método | Ruta | Roles |
|---|---|---|
| GET | `/webhooks` | admin+ |
| POST | `/webhooks` | admin+ |
| PATCH | `/webhooks/:id` | admin+ |
| DELETE | `/webhooks/:id` | admin+ |

#### Applications — `/applications`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/applications` | bpo, admin, super_admin |
| GET | `/applications/:id` | |
| POST | `/applications` | admin+ o BPO con `create_application` |
| PATCH | `/applications/:id` | |
| DELETE | `/applications/:id` | |

#### Brands — `/brands`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/brands` | Todos los roles |
| GET/POST/PATCH/DELETE | `/brands/:id` | |
| GET | `/brands/assignment-rules` | admin+ |
| PATCH | `/brands/assignment-rules/:ruleId` | admin+ |
| POST/DELETE | `/brands/assignment-rules/:ruleId/candidates` | admin+ |

#### Shops — `/shops`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/shops` | Todos |
| POST | `/shops` | bpo, admin+ |
| POST | `/shops/batch` | Creación masiva |
| PATCH | `/shops/batch-status` | Actualizar status masivo |
| PATCH/DELETE | `/shops/:id` | |
| POST | `/shops/:id/schedules` | Agregar horario |
| DELETE | `/shops/:id/schedules/:scheduleId` | |

#### Task Types — `/task-types`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/task-types` | Todos |
| GET | `/task-types/:id` | Con pasos, campos, webhooks |
| POST/PATCH/DELETE | `/task-types/:id` | admin+ |
| PATCH | `/task-types/:id/toggle-active` | admin+ |
| POST | `/task-types/:id/steps` | Crear paso |
| PATCH | `/task-types/:id/steps/reorder` | Reordenar pasos |
| PATCH/DELETE | `/task-types/:id/steps/:stepId` | |
| POST/DELETE | `/task-types/:id/steps/:stepId/candidates` | BPOs del pool |
| POST/DELETE | `/task-types/:id/steps/:stepId/webhooks` | Vincular webhook a paso |
| POST | `/task-types/:id/fields` | Crear campo de formulario |
| PATCH/DELETE | `/task-types/:id/fields/:fieldId` | |
| PATCH | `/task-types/:id/fields/reorder` | |
| POST | `/task-types/:id/templates/upload` | Subir archivo de plantilla |

#### Tasks — `/tasks`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/tasks` | Lista (filtros: status, brand, search) |
| GET | `/tasks/:id` | Detalle con pasos y valores de formulario |
| POST | `/tasks` | Crear tarea |
| PATCH | `/tasks/:id/steps/:stepId/start` | BPO inicia el paso |
| PATCH | `/tasks/:id/steps/:stepId/complete` | BPO completa el paso |
| PATCH | `/tasks/:id/steps/:stepId/fail` | Marcar paso fallido |
| PATCH | `/tasks/:id/steps/:stepId/block` | Bloquear paso |
| PATCH | `/tasks/:id/steps/:stepId/retry` | Reintentar paso fallido |
| PATCH | `/tasks/:id/steps/:stepId/assign` | Asignar BPO manualmente |
| POST | `/tasks/upload-excel` | Subir Excel temporal (devuelve nombre de archivo) |

#### BPO Management — `/bpo-management`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/bpo-management/my-tasks` | Tareas asignadas al BPO actual |
| GET | `/bpo-management/my-performance` | Estadísticas del BPO actual |
| GET | `/bpo-management/team` | Performance del equipo |
| GET | `/bpo-management/team/history` | Histórico paginado |
| GET | `/bpo-management/team/:accountId` | BPO individual |
| GET | `/bpo-management/filter-options` | Años/meses/semanas disponibles |

#### App Config — `/app-config`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/app-config` | Todos los valores agrupados por categoría |
| GET | `/app-config/:category` | Una categoría específica |
| POST | `/app-config` | Upsert de opción (admin+) |
| PATCH/DELETE | `/app-config/:id` | (admin+) |

---

## 6. Cómo crear un módulo nuevo

Sigue exactamente este patrón para no romper nada:

### Paso 1 — Crear el modelo en Prisma

Editar `prisma/schema.prisma`, agregar el modelo y correr:

```bash
cd backend
npx prisma db push --schema=../prisma/schema.prisma
npx prisma generate --schema=../prisma/schema.prisma
```

### Paso 2 — Crear los archivos del módulo

```
backend/src/mi-entidad/
├── mi-entidad.controller.ts
├── mi-entidad.service.ts      (opcional; puede ir toda la lógica en controller)
├── mi-entidad.module.ts
└── dto/
    ├── create-mi-entidad.dto.ts
    └── update-mi-entidad.dto.ts
```

**`mi-entidad.module.ts`** — siempre importar `PrismaModule`:

```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MiEntidadController } from './mi-entidad.controller';
import { MiEntidadService } from './mi-entidad.service';

@Module({
  imports: [PrismaModule],
  controllers: [MiEntidadController],
  providers: [MiEntidadService],
})
export class MiEntidadModule {}
```

**`mi-entidad.controller.ts`** — patrón estándar:

```typescript
import { Controller, Get, Post, Patch, Delete, Body, Param, Query,
         DefaultValuePipe, ParseIntPipe, UseGuards } from '@nestjs/common';
import { JwtAuthGuard }  from '../auth/guards/jwt-auth.guard';
import { RolesGuard }    from '../auth/guards/roles.guard';
import { Roles }         from '../auth/decorators/roles.decorator';
import { CurrentUser }   from '../auth/decorators/current-user.decorator';
import { AccountRole }   from '@prisma/client';
import { JwtUser }       from '../auth/types/jwt-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMiEntidadDto } from './dto/create-mi-entidad.dto';

@Controller('mi-entidad')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MiEntidadController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async findAll(
    @CurrentUser() user: JwtUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
  ) {
    const [data, total] = await Promise.all([
      this.prisma.miEntidad.findMany({
        where: { deletedAt: null },      // siempre filtrar soft-deletes
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.miEntidad.count({ where: { deletedAt: null } }),
    ]);
    return { data, total, page, limit };
  }

  @Post()
  @Roles(AccountRole.admin, AccountRole.super_admin)
  async create(@CurrentUser() user: JwtUser, @Body() dto: CreateMiEntidadDto) {
    return this.prisma.miEntidad.create({
      data: { ...dto, createdById: user.id },
    });
  }

  @Patch(':id')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  async update(@Param('id') id: string, @Body() dto: UpdateMiEntidadDto) {
    return this.prisma.miEntidad.update({
      where: { id, deletedAt: null },
      data: dto,
    });
  }

  @Delete(':id')
  @Roles(AccountRole.admin, AccountRole.super_admin)
  async remove(@Param('id') id: string) {
    return this.prisma.miEntidad.update({
      where: { id },
      data: { deletedAt: new Date() },    // soft-delete: nunca borrar físicamente
    });
  }
}
```

### Paso 3 — Registrar en `app.module.ts`

```typescript
import { MiEntidadModule } from './mi-entidad/mi-entidad.module';

@Module({
  imports: [
    // ... módulos existentes ...
    MiEntidadModule,
  ],
})
export class AppModule {}
```

### Paso 4 — DTOs con validación

```typescript
// create-mi-entidad.dto.ts
import { IsString, IsOptional, IsUUID } from 'class-validator';

export class CreateMiEntidadDto {
  @IsString()
  nombre: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;
}
```

La validación se aplica automáticamente (hay un `ValidationPipe` global en `main.ts`).

### Paso 5 — Frontend (API + página)

Agregar en `frontend/src/api/index.ts`:

```typescript
export const miEntidadApi = {
  list: (params?: PaginationParams) =>
    client.get('/mi-entidad', { params }).then(r => r.data),
  create: (dto: CreateDto) =>
    client.post('/mi-entidad', dto).then(r => r.data),
  update: (id: string, dto: Partial<CreateDto>) =>
    client.patch(`/mi-entidad/${id}`, dto).then(r => r.data),
  remove: (id: string) =>
    client.delete(`/mi-entidad/${id}`).then(r => r.data),
};
```

Agregar la ruta en `frontend/src/App.tsx`:

```tsx
<Route path="mi-entidad" element={<MiEntidadPage />} />
```

---

## 7. Sistema de tareas

### Flujo de estados

```
TaskType (plantilla)
    └── Task (instancia)
            └── StepInstance[] (uno por StepDefinition, en orden)

Task.status:
  scheduled → pending → assigned → in_progress → done
                                         └→ failed

StepInstance.status:
  pending → in_progress → done
                   └→ failed    (hace fallar toda la Task)
                   └→ blocked   (Task sigue in_progress; solo pasos manuales)
```

### Crear una tarea (desde el frontend / API)

```json
POST /tasks
{
  "taskTypeId": "uuid-del-task-type",
  "brandId": "uuid-de-la-marca",          // opcional
  "shopIds": ["uuid-shop-1"],             // opcional
  "formValues": [
    { "formFieldId": "uuid-campo", "value": "https://..." },
    { "formFieldId": "uuid-campo-marca", "brandId": "uuid-marca" }
  ],
  "scheduledStart": "2026-07-10T08:00:00Z",  // opcional
  "scheduledEnd":   "2026-07-10T20:00:00Z"   // requerido si scheduledStart
}
```

### Tipos de paso (`ExecutionType`)

| Tipo | Quién lo ejecuta | Flujo |
|---|---|---|
| `manual_internal` | BPO interno | Start → Complete/Fail/Block |
| `manual_external` | Agente externo (lead) | Start → Complete/Fail/Block |
| `automatic` | Handler (BullMQ) | Se encola automáticamente al activarse |

### Estrategias de asignación (`AssignmentStrategy`)

| Estrategia | Comportamiento |
|---|---|
| `fixed` | Siempre al mismo BPO del pool (el único candidato) |
| `round_robin` | Rotación entre candidatos (usa `contador_rr`) |
| `by_weight` | Elige el candidato con menor `workload` (`carga`) |
| `brand_assignment` | Asigna al BPO responsable de la marca (`Brand.ownerId`) |
| `manual` | Admin asigna manualmente (`PATCH .../assign`) |

La asignación es **just-in-time**: se hace al activarse cada paso (no al crear la tarea).

### Tipos de campo de formulario (`FormFieldTipo`)

| Tipo | Qué guarda `FormValue` | Notas |
|---|---|---|
| `texto` | `valor` (string) | |
| `numero` | `valor` (string de número) | |
| `link` | `valor` (URL) | |
| `link_spreadsheet` | `valor` (URL de Google Sheets) | |
| `select` | `valor` (una de `options`) | |
| `select_brand` | `brandId` (FK a Brand) | |
| `select_store` | `shopId` (FK a Shop) | |
| `select_ka_type` | `valor` (KA/CKA/SME) | |
| `select_country` | `valor` (CO/MX/CR) | |
| `file` | `valor` (nombre del archivo en `uploads/temp/`) | Ver sección 8 |

---

## 8. Sistema de colas y handlers

### Arquitectura

```
TaskEngine detecta paso automático
    → encola job en BullMQ ("handlers" queue)
    → HandlerProcessor recibe el job
    → busca la función en HANDLER_REGISTRY
    → la llama con HandlerContext
    → en éxito: completa el StepInstance
    → en fallo: reintenta (max 3 veces, backoff exponencial)
    → en fallo final: marca paso como failed
```

### `HandlerContext` — interfaz que recibe el handler

```typescript
interface HandlerContext {
  stepInstanceId: string;
  taskId: string;

  // Valores del formulario enviados al crear la tarea
  formValues: FormValueCtx[];

  // Marca vinculada a la tarea (null si no hay)
  brand: {
    id: string;
    brandId: string;
    brandName: string;
    country: string;           // 'CO' | 'MX' | 'CR'
    category?: string;
    application?: {
      appId: string;
      appName: string;
      appSecret: string;       // ¡DESCIFRADO! Nunca loguear esto
    };
  } | null;

  // Obtener un valor de formulario por su label
  field(label: string): string | null;

  // Acumular notas en el StepInstance (visibles en el detalle de la tarea)
  addNote(text: string): void;

  // Enviar al webhook de alertas
  sendAlert(payload: WebhookPayload): Promise<void>;

  // true si es el último reintento de BullMQ (no habrá más)
  isLastAttempt: boolean;
}

interface FormValueCtx {
  label: string;
  tipo: string;
  valor: string | null;
  brand?: { id, brandId, brandName, country };
  shop?: { id, shopId, appShopId };
}
```

### Registro global de handlers

El registro vive en memoria en `handler.processor.ts`:

```typescript
const HANDLER_REGISTRY = new Map<string, HandlerFn>();

export function registerHandler(name: string, fn: HandlerFn): void {
  HANDLER_REGISTRY.set(name, fn);
}
```

Cada archivo de handler llama a `registerHandler(...)` al cargarse. El `queue/handlers/index.ts` importa todos los archivos, lo que dispara el registro.

### Handlers actualmente registrados

| Nombre (en DB y código) | Archivo | Propósito |
|---|---|---|
| `sync_menu` | `sync-menu.handler.ts` | Sync menú via API |
| `validate_app_credentials` | `validate-app-credentials.handler.ts` | Validar credenciales DiDi |
| `enable_shop_online` | `enable-shop-online.handler.ts` | Poner tiendas online |
| `notify_integration_complete` | `notify-integration-complete.handler.ts` | Notificación de integración |
| `debug_echo` | `debug-echo.handler.ts` | Echo de contexto (testing) |
| `schedule_update_permanent` | `schedule-update-permanent.handler.ts` | Horarios permanentes desde Excel |
| `schedule_update_dates` | `schedule-update-dates.handler.ts` | Overrides de fechas desde Excel |
| `library_menu_upload` | `menu-upload.handler.ts` | Subida de menú desde Excel |
| `stock_update` | `stock-update.handler.ts` | Actualización de stock desde Excel |

---

## 9. Cómo crear un handler nuevo

### Paso 1 — Crear el archivo del handler

```typescript
// backend/src/queue/handlers/mi-handler.handler.ts

import { Logger } from '@nestjs/common';
import { registerHandler, HandlerContext } from '../handler.processor';

const logger = new Logger('mi_handler');

async function miHandler(ctx: HandlerContext): Promise<unknown> {
  const { brand, isLastAttempt } = ctx;

  // Validaciones básicas
  if (!brand) throw new Error('Task has no brand linked');
  if (!brand.application) throw new Error(`Brand ${brand.brandName} has no application`);

  // Leer valores del formulario por su label (exactamente como está en el TaskType)
  const url = ctx.field('URL del menú');
  if (!url) throw new Error('Form field "URL del menú" is required');

  ctx.addNote(`Iniciando procesamiento para ${brand.brandName}...`);

  try {
    // --- Lógica del handler aquí ---
    const resultado = await hacerAlgo(url, brand.application.appId);

    ctx.addNote(`✓ Completado: ${resultado.itemsProcessed} ítems`);
    logger.log(`mi_handler OK: brand=${brand.brandId}`);

    return { success: true, itemsProcessed: resultado.itemsProcessed };

  } catch (err) {
    const msg = (err as Error).message;

    // Enviar alerta solo en último intento para no spamear
    if (isLastAttempt) {
      await ctx.sendAlert({
        text: `⚠️ mi_handler falló para ${brand.brandName}: ${msg}`,
      });
    }
    throw err;  // re-lanzar para que BullMQ reintente
  }
}

registerHandler('mi_handler', miHandler);
```

### Paso 2 — Exportar desde el índice

```typescript
// backend/src/queue/handlers/index.ts
export * from './mi-handler.handler';  // agregar esta línea
```

### Paso 3 — Registrar en la DB

Opción A — vía API (si ya hay un super_admin logueado):
```bash
POST /handlers  { "name": "mi_handler" }
```

Opción B — vía psql:
```sql
INSERT INTO handler (id, name) VALUES (gen_random_uuid(), 'mi_handler');
```

Opción C — en el seed (`backend/src/seed/seed.ts`):
```typescript
await prisma.handler.upsert({
  where: { name: 'mi_handler' },
  update: {},
  create: { name: 'mi_handler' },
});
```

### Paso 4 — Vincular al StepDefinition en la UI

En el panel de admin: `TaskTypes → [tipo] → [paso] → Editar → Handler: mi_handler`.

El campo `executionType` del paso debe ser `automatic`.

### Handlers con archivos Excel

Para handlers que leen un archivo Excel subido vía el campo `file`:

```typescript
import { join } from 'path';
import { unlink } from 'fs/promises';
import * as ExcelJS from 'exceljs';

async function miHandler(ctx: HandlerContext): Promise<unknown> {
  const tempFile = ctx.field('Excel File');  // label exacto del campo
  if (!tempFile) throw new Error('Form field "Excel File" is required');

  const filePath = join(process.cwd(), 'uploads', 'temp', tempFile);

  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
  } catch (err) {
    await unlink(filePath).catch(() => undefined);  // limpiar en error de lectura
    throw err;
  }

  const sheet = workbook.worksheets[0];
  // ... procesar filas ...

  // Eliminar archivo temp solo en éxito o en último intento
  // (para que BullMQ pueda reintentar si falla antes de llegar aquí)
  const allFailed = /* tu lógica */ false;
  if (!allFailed || ctx.isLastAttempt) {
    await unlink(filePath).catch(() => undefined);
  }
  if (allFailed) throw new Error('All shops failed');

  return { total: 0, success: 0, failed: 0 };
}
```

**Regla crítica de archivos temp**: Nunca borrar el archivo en el `finally` del try. Solo borrarlo cuando:
- El handler termina exitosamente, O
- `ctx.isLastAttempt === true` (último reintento, no habrá más)

De lo contrario, BullMQ no encontrará el archivo al reintentar.

---

## 10. Webhooks

### Estructura del payload (estilo Mattermost)

```typescript
interface WebhookPayload {
  text: string;       // Texto principal (soporta markdown)
  attachments?: [
    {
      title?: string;
      text?: string;
      color?: string;  // Hex: '#4CAF50' (verde), '#F44336' (rojo), '#FF9800' (naranja)
      images?: string[];
    }
  ];
}
```

### Eventos disponibles por paso

```typescript
enum WebhookEvent {
  on_start,       // Cuando el BPO inicia el paso
  on_complete,    // Cuando el paso se completa
  on_fail,        // Cuando el paso falla
  on_assignment,  // Cuando se asigna un BPO al paso
  on_blocked,     // Cuando el paso se bloquea
}
```

### Vincular webhook a un paso (API)

```json
POST /task-types/:id/steps/:stepId/webhooks
{
  "webhookId": "uuid-del-webhook",
  "events": ["on_complete", "on_fail"]
}
```

### Webhook de alertas del sistema

El webhook con `isAlerts: true` recibe alertas de:
- Handlers que fallan en todos sus reintentos
- Timeouts de pasos manuales (`bpo_timed_out`)
- Timeouts de pasos automáticos (`system_timed_out`)

Configurar su URL en `ALERT_WEBHOOK_URL` o crear uno en la UI y marcarlo como "de alertas".

---

## 11. Frontend

### Configuración de rutas

Base URL: `/guaro` (configurado en `vite.config.ts` como `base: '/guaro'`)

```tsx
// App.tsx — todas las rutas protegidas van dentro del <PrivateRoute>
<BrowserRouter basename="/guaro">
  <Routes>
    <Route path="/login"          element={<Login />} />
    <Route path="/auth/callback"  element={<AuthCallback />} />
    <Route path="/invite/:token"  element={<InvitePage />} />

    <Route path="/" element={<PrivateRoute><AppLayout /></PrivateRoute>}>
      <Route index                element={<Dashboard />} />
      <Route path="brands"        element={<BrandsList />} />
      <Route path="brands/:id"    element={<BrandDetail />} />
      <Route path="shops"         element={<ShopsList />} />
      <Route path="tasks"         element={<TasksList />} />
      <Route path="tasks/new"     element={<NewTaskPage />} />
      <Route path="tasks/:id"     element={<TaskDetail />} />
      <Route path="task-types"    element={<TaskTypesList />} />
      <Route path="task-types/:id" element={<TaskTypeDetail />} />
      <Route path="bpo"           element={<BpoQueue />} />
      <Route path="bpo-management" element={<BpoManagement />} />
      <Route path="sections"      element={<SectionsList />} />
      <Route path="applications"  element={<ApplicationsPage />} />
      <Route path="config"        element={<Config />} />
      <Route path="settings"      element={<SettingsPage />} />
    </Route>
  </Routes>
</BrowserRouter>
```

### Cliente HTTP

```typescript
// api/client.ts — Axios con JWT automático
const client = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000',
});

// Agrega el JWT a cada request
client.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// 401 → limpiar token y redirigir a /login
client.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401) {
    localStorage.clear();
    window.location.href = `${import.meta.env.BASE_URL}login`;
  }
  return Promise.reject(err);
});
```

### Cómo agregar una nueva página

1. Crear `frontend/src/pages/mi-seccion/MiPagina.tsx`
2. Agregar la llamada API en `frontend/src/api/index.ts`
3. Agregar la ruta en `App.tsx`
4. Agregar el link en el `Sidebar.tsx`
5. Agregar las traducciones en `frontend/src/i18n/translations.ts`

### Internacionalización (i18n)

```tsx
// En cualquier componente:
import { useT } from '../i18n';

function MiComponente() {
  const t = useT();
  return <h1>{t('mi.clave')}</h1>;
}
```

Agregar la clave en `translations.ts`:

```typescript
export const translations = {
  en: {
    'mi.clave': 'My heading',
    'mi.clave.con.variable': 'Hello {nombre}',
  },
  es: {
    'mi.clave': 'Mi encabezado',
    'mi.clave.con.variable': 'Hola {nombre}',
  },
};
```

Uso con variables: `t('mi.clave.con.variable', { nombre: 'Alejandro' })`

### Auth en el frontend

```tsx
import { useAuth } from '../auth/AuthContext';

function MiComponente() {
  const { account, logout } = useAuth();

  if (!account) return null;

  const isAdmin = account.roles.includes('admin') || account.roles.includes('super_admin');
  const canCreateBrand = account.bpoPermissions.includes('create_brand');
}
```

---

## 12. Variables de entorno

### Backend (requeridas en producción)

| Variable | Descripción | Generar con |
|---|---|---|
| `DATABASE_URL` | URL completa de PostgreSQL | — |
| `REDIS_HOST` | Host de Redis | — |
| `REDIS_PORT` | Puerto de Redis (default: 6379) | — |
| `JWT_SECRET` | Clave para firmar tokens | `openssl rand -hex 64` |
| `JWT_EXPIRES_IN` | Expiración del token (default: 8h) | — |
| `GOOGLE_CLIENT_ID` | Client ID de Google Cloud | Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Client Secret | Google Cloud Console |
| `GOOGLE_CALLBACK_URL` | URL de callback OAuth | Debe coincidir con Google Console |
| `FRONTEND_URL` | URL base del frontend | — |
| `APP_SECRET_ENCRYPTION_KEY` | Clave AES-256 (64 hex chars) | `openssl rand -hex 32` |
| `ALERT_WEBHOOK_URL` | URL del webhook de alertas | — |
| `NODE_ENV` | `production` o `development` | — |

### Frontend (baked en build time)

| Variable | Descripción |
|---|---|
| `VITE_API_URL` | URL base del backend (e.g., `https://dominio.com/api`) |

---

## 13. Seed y datos iniciales

**Archivo**: `backend/src/seed/seed.ts`

```bash
# Correr el seed
cd backend
npx ts-node src/seed/seed.ts

# En Docker (producción)
docker exec guaro-backend-1 node dist/seed/seed.js
```

### Qué siembra en todos los entornos

1. **Super admin**: `superadmin@didi-labs.com` (rol `super_admin`)
2. **Sections**: "Operations" y "Growth"
3. **Handlers**: Los 9 handlers registrados en código
4. **Webhooks**: Webhook de alertas del sistema + dev webhook local
5. **Brand Assignment Rules**: 9 reglas (3 kaTypes × 3 países)
6. **AppConfigOptions**: Valores de enums (países, tipos de KA, integraciones de menú, etc.)

### Qué siembra solo en `NODE_ENV !== 'production'`

1. Cuentas de prueba (admin, BPO × 5, user × 3, director)
2. Aplicaciones DiDi de ejemplo (CO × 2, MX × 1)
3. Marcas de ejemplo (5 marcas en CO/MX/CR)
4. Tiendas de ejemplo (14 shops)
5. TaskTypes de ejemplo con pasos configurados
6. Tareas de ejemplo en varios estados (done, in_progress, failed, etc.)

### Cómo agregar datos al seed

```typescript
// Al final de la función seedAll():
await prisma.handler.upsert({
  where: { name: 'mi_nuevo_handler' },
  update: {},
  create: { name: 'mi_nuevo_handler' },
});
```

Usar **siempre `upsert`** en el seed para que sea idempotente (se puede correr múltiples veces sin duplicar datos).

---

## 14. Despliegue

### Desarrollo local

```bash
# Solo Postgres + Redis en Docker; app en el host
docker compose up -d          # Levanta postgres + redis
cd backend && npm run start:dev
cd frontend && npm run dev
```

### Producción — Makefile

El servidor tiene un `Makefile` con los comandos más usados. Instalar `make` si no está disponible:

```bash
apt install make -y
```

| Comando | Qué hace |
|---|---|
| `make deploy` | `git pull` + build backend y frontend + `up -d` |
| `make deploy-backend` | `git pull` + build y restart solo el backend |
| `make deploy-frontend` | `git pull` + build y restart solo el frontend |
| `make migrate` | `prisma migrate deploy` dentro del contenedor |
| `make logs` | Logs en vivo de todos los servicios |
| `make logs-backend` | Logs en vivo solo del backend |
| `make import-brands` | Correr el script de importación de brands (requiere `/tmp/brands.xlsx`) |

### Flujo habitual de actualización

```bash
# Local: commit y push
git add .
git commit -m "feat: descripción"
git push

# Servidor
make deploy       # pull + build + up
make migrate      # solo si hay nuevas migraciones de Prisma
```

### Flujo si solo cambia el frontend

```bash
make deploy-frontend
```

### Si hay cambios en el seed

```bash
docker compose -f docker-compose.prod.yml exec backend node dist/seed/seed.js
```

### Configurar Nginx (reverse proxy externo)

El `docker-compose.prod.yml` asume una red Docker externa `grocerytools_webnet` donde ya corre un reverse proxy (Nginx/Traefik). El proxy debe apuntar:

- `dominio.com/guaro/*` → container `guaro-frontend-1:80`
- `dominio.com/api/*` → container `guaro-backend-1:3000` (o el Nginx interno del frontend hace el proxy vía `/api/`)

El Nginx interno del frontend ya tiene configurado:

```nginx
location /api/ {
  proxy_pass http://backend:3000/;
  # ...headers...
}
location / {
  try_files $uri $uri/ /index.html;  # SPA fallback
}
```

---

## 15. Scripts de importación masiva

Los scripts viven en `backend/src/scripts/` y se corren con `ts-node`. Son **idempotentes**: si se corren dos veces no duplican datos (usan `upsert`).

> **Archivos de datos**: Los Excel con datos reales nunca se suben al repo. La carpeta `backend/data/` está en `.gitignore`. Para producción, copiar el archivo al servidor vía `scp`, correr el script y borrar el archivo.

### `import-brands.ts` — Importar brands desde Excel

**Columnas esperadas** (el orden no importa, se detectan por nombre):

| Columna | Campo en DB | Notas |
|---|---|---|
| `Brand Name` | `brandName` | Requerido |
| `Brand Id` | `brandId` | Requerido. ID externo DiDi |
| `Country` | `country` | Requerido. CO / MX / CR |
| `Business Type` | `kaType` | Requerido. KA / CKA / SME |
| `Business Category` | `category` | Opcional. Texto libre |
| `OP` | `ownerId` | Opcional. Username sin `@didi-labs.com` |
| `Menu Method` | `menuIntegration` | Opcional. BApp / API / SFTP |
| `Checkout Mode` | `paymentMode` | Opcional. Food Mode / Prepaid Card / DiDi Payless (QR) |
| `Picking Mode` | `pickingMode` | Opcional. Merchant Picking / 2in1 / 1+1 / 1+1 & 2in1 |

**En local (dev):**

```bash
# Coloca el Excel en backend/data/brands.xlsx
DATABASE_URL="postgresql://guaro:guaro@localhost:5432/guaro?schema=public" \
  npx ts-node -r tsconfig-paths/register src/scripts/import-brands.ts ./data/brands.xlsx
```

**En producción (servidor):**

```bash
# Desde tu máquina local, copiar el Excel al servidor
scp ./brands.xlsx usuario@servidor:/tmp/brands.xlsx

# En el servidor
make import-brands

# Borrar el archivo del servidor
rm /tmp/brands.xlsx
```

El script imprime cada fila procesada (`✓ Imported` / `↺ Updated`) y al final un resumen con las filas saltadas y el motivo.

---

## 16. Patrones y convenciones

### Soft-delete — nunca borrar físicamente

```typescript
// Siempre filtrar deleted en las queries:
where: { id, deletedAt: null }

// Soft-delete:
data: { deletedAt: new Date() }
```

### Paginación estándar

Todos los endpoints de listado devuelven:

```typescript
{ data: T[], total: number, page: number, limit: number }
```

Query params: `?page=1&limit=25`

### PKs — siempre UUID desde la app

```prisma
id String @id @default(uuid()) @db.Uuid
```

Nunca usar `autoincrement()` ni `pgcrypto`.

### Timestamps — siempre `timestamptz`

```prisma
createdAt DateTime @default(now()) @map("created_at")
updatedAt DateTime @updatedAt @map("updated_at")
```

### Nombres de columnas — snake_case en DB, camelCase en código

```prisma
brandName String @map("brand_name")
```

Prisma mapea automáticamente. En código siempre usar el nombre en camelCase.

### Validación — solo en el borde con DTOs

```typescript
// Prisma NO valida. La validación va en DTOs con class-validator:
@IsString()
@MinLength(1)
name: string;

@IsOptional()
@IsUUID()
brandId?: string;
```

### Secrets — nunca exponer `appSecret`

```typescript
// Al serializar applications, excluir appSecret:
const { appSecret: _, ...safeApp } = application;
return safeApp;

// Al pasar al handler, el secret ya viene descifrado en ctx.brand.application.appSecret
// NUNCA loguear ctx.brand.application.appSecret
```

### Handlers — siempre idempotentes

Los handlers pueden ejecutarse más de una vez (BullMQ reintenta). Diseñarlos para que llamar múltiples veces con el mismo `stepInstanceId` produzca el mismo resultado sin efectos secundarios duplicados.

### Archivos Excel temp

- El frontend sube el archivo: `POST /tasks/upload-excel` → devuelve `{ filename: "uuid.xlsx" }`
- El frontend guarda el filename y lo manda como valor del campo `file` al crear la tarea
- El handler lo lee de `uploads/temp/<filename>`
- El handler lo borra después de procesarlo (o en el último intento)
- En producción, `uploads/` está en un volumen Docker persistente

### Números grandes (IDs de DiDi)

DiDi devuelve IDs de 64 bits que JavaScript no puede representar exactamente como `number`. Usar `parseJsonKeepingIds()` de `didi-food.util.ts`:

```typescript
const body = parseJsonKeepingIds(await res.text());
// body.data.taskID es un string, no un number
```

### Transacciones para asignación just-in-time

La asignación de BPOs a pasos usa `SELECT FOR UPDATE` para evitar race conditions:

```typescript
await prisma.$transaction(async (tx) => {
  const candidate = await tx.account.findFirst({
    where: { ... },
    orderBy: { rrCounter: 'asc' },
    // SELECT FOR UPDATE (via raw query o plugin)
  });
  await tx.account.update({ where: { id: candidate.id }, data: { rrCounter: { increment: 1 } } });
  await tx.stepInstance.update({ where: { id: stepId }, data: { assignedToId: candidate.id } });
});
```
