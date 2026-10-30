# Cierre automático por CR de tienda

La sección **Cierre automático por tienda** está en el mismo formulario de **Integrations → Alertas de CR**. La configuración reside en `Brand`: `crAutoClosureEnabled` (apagado por defecto), `crAutoClosureThreshold` (50%) y `crAutoClosureMinOrders` (3). Las alertas por marca y los cierres se pueden activar independientemente.

## Regla estática

Se conserva la lógica de `static-rule-closure-every-15-minutes` de grocery_tools: CR = completadas / (completadas + cancelaciones computables), comparado individualmente por tienda con `CR <= umbral` y `total >= mínimo`. Son umbrales inclusivos. Solo cuentan las cancelaciones 902, 921, 922, 923, 961, 971 y 981, igual que en las alertas; el estado 901 siempre se excluye, al igual que las órdenes en curso. No se utilizan los parámetros de probabilidad o ventana de 30 minutos del antiguo modelo beta-binomial.

Las evaluaciones terminan cada cuarto de hora, de 06:00 a 03:00 del día siguiente, en hora de Ciudad de México. El acumulado comienza a las 04:00 del día operativo de cada marca: Ciudad de México para MX, Bogotá para CO y Costa Rica para CR. Antes de las 04:00, el día operativo comenzó el día anterior. Los intervalos incluyen el inicio y excluyen el final.

Se usan las órdenes persistidas por Order Webhooks y las tiendas de la marca, aislando por aplicación. Las cancelaciones genéricas (170) se consultan en el detalle de DiDi al recibir el webhook, incluso cuando solo están habilitados los cierres. La tarea periódica reintenta los casos que DiDi no clasificó. El historial los muestra como «En proceso de clasificación»; no entran en el CR. Si siguen pendientes para una tienda, se registra `incomplete` y no se cierra con un CR potencialmente incorrecto. El siguiente cuarto de hora vuelve a evaluar el acumulado. No se reconstruyen órdenes de antes del despliegue de la recepción de estados.

## Ejecución y protección de Auto Open

Cada evaluación queda registrada con métricas, reglas y IDs de las órdenes utilizadas. Una solicitud de cierre por tienda y día operativo se persiste antes de llamar a DiDi. El cierre utiliza `/v1/shop/shop/setStatus`, `biz_status: 2` y `auto_switch: 2`, como grocery_tools.

La solicitud se reclama mediante actualización condicional, con hasta tres intentos. Antes de enviar, se verifica de nuevo que la aplicación y su webhook estén activos, que la tienda siga asociada a la marca/aplicación, que la función siga activada y que el CR actual del día todavía cumpla la regla. Un cierre cancelado por revalidación puede volver a solicitarse en una evaluación posterior si vuelve a cumplir la regla. Un cierre confirmado nunca se repite durante ese día operativo. Una respuesta explícita de error se registra como `failed`; un timeout o un fallo de persistencia después del envío se registra como `unknown`, no como éxito.

Auto Open omite tiendas con solicitudes pendientes, en proceso, confirmadas o de resultado incierto hasta terminar su día operativo. Comprueba la protección al preparar cada lote, también en dry-run, y de nuevo inmediatamente antes de llamar a DiDi. El permiso final y la creación/ejecución del cierre comparten el bloqueo de marca de PostgreSQL, para evitar que una apertura simultánea deshaga un cierre. El resultado de Auto Open muestra un contador separado de tiendas protegidas por CR.

La protección termina a las siguientes 04:00 locales aunque la configuración se desactive después de un cierre. Esta integración no envía reaperturas: Auto Open podrá abrir la tienda en su próxima ejecución elegible, respetando las demás protecciones, como Store Emergencies. Las operaciones manuales de Forced Open conservan su comportamiento; la regla solicitada protege específicamente Auto Open. Una petición de cierre caducada no se ejecuta durante otro día operativo.

## D-Chat y despliegue

Configurar `DCHAT_URL` y **`DCHAT_STORE_CLOSURE_GROUP_ID`** con el grupo específico de cierres de grocery_tools. No se usa `DCHAT_GROUP_ID` como alternativa. Docker Compose de producción pasa la nueva variable al backend.

El historial distingue estado del cierre y estado de su notificación. D-Chat recibe mensajes claramente distintos para cierre confirmado, fallido o incierto. Se reintenta la notificación hasta tres veces sin volver a cerrar la tienda. Como el contrato D-Chat no tiene clave de idempotencia, una caída tras aceptar el mensaje puede provocar una notificación duplicada.

Aplicar las migraciones, regenerar Prisma y desplegar backend/frontend. Esta rama parte de `feat/brand-completion-rate-alerts` y requiere su migración `20261028010000_completion_rate_alerts`, además de `20261029010000_store_cr_auto_closure`. El Dockerfile actual aplica las migraciones al arrancar. La migración nueva no activa cierres ni envía solicitudes a DiDi. Después se configura y activa cada marca en el formulario existente usando los mismos permisos de consulta/configuración de alertas.

El coordinador despierta cada minuto para recuperar solicitudes/notificaciones pendientes; la restricción única de decisiones mantiene una sola evaluación por tienda y cuarto de hora. No se recuperan todas las ventanas históricas de una caída prolongada: la siguiente evaluación usa el acumulado vigente.

## Verificación

Las pruebas de `store-cr.test.ts` cubren reglas, día operativo, duplicados, aislamiento por tienda/aplicación, revalidación, respuestas de DiDi, fallos de confirmación, grupo específico, notificaciones y bloqueo/expiración de Auto Open. `auto-open-release.test.ts` prueba las omisiones por CR en dry-run y live, y el bloqueo que aparece entre la selección y la apertura. No realizan cierres ni envíos reales.
