# Documentación de Roles — DiDi Ops Panel

## Tabla de contenidos
- [Usuario](#usuario)
- [BPO](#bpo)
- [Admin](#admin)
- [Desarrollador — Handlers](#desarrollador--handlers)

---

## Usuario

**Rol:** `user`

Crea y hace seguimiento de sus propias tareas. No puede configurar nada del sistema.

### Lo que puede hacer

| Acción | Permitido |
|--------|-----------|
| Crear tareas (solo de los TaskTypes de su sección) | ✅ |
| Ver sus tareas (historial, estado de steps, formulario, archivos) | ✅ |
| Ver marcas y tiendas del catálogo de su sección (lectura) | ✅ |
| Completar o fallar steps | ❌ |
| Configurar task types, webhooks, handlers | ❌ |
| Invitar a otros usuarios | ❌ |

### Flujo típico

1. Entra al panel → **Tareas** → **Nueva tarea**.
2. Selecciona el tipo de tarea, llena el formulario y confirma.
3. El sistema crea los steps automáticamente y asigna BPOs just-in-time.
4. El usuario puede monitorear el avance en el detalle de la tarea.

---

## BPO

**Rol:** `bpo`

Ejecuta los steps manuales de las tareas. Gestiona las marcas donde es responsable. Puede ver métricas de su propio desempeño.

### Ejecución de tareas

| Acción | Permitido |
|--------|-----------|
| Ver la cola de steps manuales asignados a él | ✅ |
| Completar step → `done` | ✅ |
| Fallar step → `failed` con motivo (falla toda la tarea) | ✅ |
| Bloquear step → `blocked` cuando hay un impedimento externo (la tarea sigue en curso) | ✅ |
| Reintentar step bloqueado → pasa a `in_progress` cuando se resuelve el impedimento | ✅ |

### Gestión de marcas

| Acción | Permitido |
|--------|-----------|
| Editar marcas donde está asignado como responsable | ✅ |
| Crear marcas (si el super admin le otorgó `create_brand`) | ✅ condicional |
| Ver/crear aplicaciones (si el super admin le otorgó `create_application`) | ✅ condicional |

### Visibilidad

| Acción | Permitido |
|--------|-----------|
| Ver su propio desempeño (tareas completadas, tiempos) | ✅ |
| Ver historial de tareas del equipo (lectura) | ✅ |
| Configurar task types, webhooks o estrategias de asignación | ❌ |

### Máquina de estados de un step manual

```
pending → in_progress → done
                      → failed   (falla la tarea entera)
                      → blocked  (tarea sigue in_progress)
blocked → in_progress            (se resolvió el impedimento)
blocked → failed                 (no se corrigió)
```

---

## Admin

**Rol:** `admin`

Configura su sección: tipos de tarea, formularios, webhooks y estrategias de asignación. Gestiona el equipo BPO e invita usuarios.

### Configuración de task types

| Acción | Permitido |
|--------|-----------|
| Crear / editar TaskTypes (nombre, descripción, sección, si es programable) | ✅ |
| Gestionar StepDefinitions (agregar, editar, reordenar, eliminar) | ✅ |
| Configurar tipo de step: manual interno, manual externo, o automático (requiere handler) | ✅ |
| Construir formulario (campos de texto, número, select, marca, tienda…) | ✅ |
| Asignar webhooks por step y por evento (`on_start`, `on_complete`, `on_fail`, `on_assignment`) | ✅ |
| Configurar pool de candidatos y estrategia de asignación (fijo / round-robin / por peso) | ✅ |

### Webhooks y handlers

| Acción | Permitido |
|--------|-----------|
| Crear webhooks (URL destino, tipo notificación o alerta) | ✅ |
| Ver handlers disponibles (si el super admin habilitó el módulo `handlers`) | ✅ |
| Crear o editar handlers | ❌ (solo en código) |

### Equipo e invitaciones

| Acción | Permitido |
|--------|-----------|
| Invitar usuarios con rol `user` o `bpo` a su propia sección | ✅ |
| Ver BPOs del team, su carga y desempeño | ✅ |
| Invitar admins o acceder a otras secciones | ❌ |
| Crear secciones | ❌ (solo super admin) |

### Módulos visibles

El super admin controla qué módulos aparecen en el sidebar de cada admin:
`applications` · `bpo_team` · `webhooks` · `handlers`

---

## Desarrollador — Handlers

Un handler es una clase que ejecuta la lógica de un **step automático** vía cola BullMQ. Debe ser **idempotente**: si se reintenta con el mismo `stepInstanceId`, el resultado debe ser el mismo.

### Contrato de un handler

```typescript
// backend/src/queue/handlers/mi-handler.handler.ts

import { BaseHandler, HandlerContext } from '../base-handler';

export class MiHandler extends BaseHandler {
  readonly name = 'mi_handler'; // debe coincidir con Handler.name en DB

  async execute(ctx: HandlerContext): Promise<void> {
    const { stepInstance, task, formValues, logger } = ctx;

    // tu lógica aquí...
    const resultado = await hacerAlgo(formValues);

    // reporta éxito (obligatorio)
    await ctx.reportSuccess({ resumen: resultado });

    // o reporta fallo
    // await ctx.reportFailure('motivo del fallo');
  }
}
```

### Contexto disponible (`HandlerContext`)

| Campo | Descripción |
|-------|-------------|
| `stepInstance` | El step que se está ejecutando, con su `id`, estado y metadatos. |
| `task` | La tarea completa con brand, country, tipo, fecha programada. |
| `formValues` | Array de valores del formulario. Cada entry tiene `formField` con `tipo` y `label`, y el valor en `valor` / `brandId` / `shopId`. |
| `prisma` | Instancia del PrismaService para queries adicionales. |
| `logger` | NestJS Logger ya configurado con el nombre del handler. |

### Reglas importantes

- **Idempotencia** — la clave de deduplicación es el `stepInstanceId`. Si el job se reencola, el handler debe detectar trabajo ya hecho y no repetirlo.
- **Timeout** — si el handler no termina en ~2 horas, el scheduler lo marca como `failed` con motivo `system_timed_out`.
- **Reintentos** — BullMQ reintenta con backoff exponencial. El handler debe tolerar múltiples intentos.
- **No lanzar excepciones sin capturar** — siempre llamar `reportFailure()` para que el step quede `failed` limpiamente.
- **Nunca exponer `app_secret`** en logs ni en el payload de resultado.

### Registrar el handler

**Paso 1 — Código:**

```typescript
// backend/src/queue/queue.module.ts
import { MiHandler } from './handlers/mi-handler.handler';

const HANDLERS = [
  ExistingHandler,
  MiHandler, // <-- aquí
];
```

**Paso 2 — Base de datos:**

Ve a **Config → Handlers** en el panel y crea el registro con el mismo `name` que pusiste en `readonly name`. Una vez registrado, los admins pueden asignarlo a steps automáticos de cualquier TaskType.

### Ciclo de vida de un step automático

```
pending → in_progress  (se encola en BullMQ)
        → done         (handler llama reportSuccess)
        → failed       (handler llama reportFailure, o system_timed_out tras ~2h)
```

Los steps automáticos **no tienen estado `blocked`** — si fallan, es terminal. La resiliencia vive en el handler (reintentos + backoff + dead-letter).
