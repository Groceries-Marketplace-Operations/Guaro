# Alertas de Completion Rate

La integración está en **Integrations → Alertas de CR**. Usa `Brand.applicationId`: varias marcas pueden compartir una aplicación y cada marca tiene una sola aplicación. Las tiendas se toman de `Brand.shops`; no se configura una segunda lista de tiendas.

## Configuración y despliegue

1. Aplicar `npx prisma migrate deploy --schema prisma/schema.prisma` desde la raíz y regenerar el cliente Prisma antes de compilar/desplegar el backend. La migración agrega columnas y tablas; no activa ninguna marca.
2. Configurar `DCHAT_URL` y `DCHAT_GROUP_ID` en el backend con los mismos valores de grocery_tools. Se concatenan igual que en el sistema original y se envía `POST { "text": "…" }` por HTTPS. Docker Compose de producción ya pasa estas variables. No se incluyen credenciales en el repositorio ni en las respuestas de la API.
3. Crear/activar el DiDi Order Webhook en Applications y asociar la aplicación a la marca. Se utiliza la misma URL existente para `orderNew`, `deliveryStatus` y `orderCancel`; no hay que generar otra URL.
4. Asignar los permisos `integrations.completion_rate` y `integrations.completion_rate.configure` a los operadores desde la matriz de accesos. Super Admin tiene acceso por defecto.
5. Seleccionar la marca, guardar su tasa base de cancelación, desviación en puntos porcentuales y mínimo de órdenes, y activar alertas.

## Cálculo

Cada ventana dura 15 minutos, incluyendo el inicio y excluyendo el final, según el momento de terminación de la orden. Las ventanas terminan a las 06:00, 06:15, …, 23:45, 00:00, …, 03:00 en `America/Mexico_City`. La ventana de las 06:00 cubre 05:45–06:00. No hay ventanas entre 03:15 y 05:45.

Se calcula CR = completadas / (completadas + cancelaciones computables), ponderado por órdenes entre todas las tiendas de la marca, sin promediar porcentajes de tiendas. Se aíslan las órdenes por aplicación y tienda. Los estados 160 y 600 son completados. Solo cuentan las cancelaciones 902, 921, 922, 923, 961, 971 y 981. El catálogo OrderStatus reproduce los nombres y valores de grocery_tools; el estado 901 se excluye siempre, independientemente del tiempo transcurrido o de la disponibilidad de fechas. Las órdenes en curso no entran en el denominador.

Los valores iniciales son 10% de cancelación base, 15 puntos de desviación y 10 órdenes mínimas para alertar. Son valores explícitos editables, no una tasa histórica calculada automáticamente. Como en grocery_tools, con menos de cuatro órdenes no se publica un porcentaje de CR. La condición de alerta es inclusiva: cancelación actual − base ≥ desviación y volumen ≥ mínimo.

Los eventos se guardan por aplicación + order ID, conservando identificadores int64 como texto. Los duplicados no suman órdenes y un evento en curso tardío no revierte un estado final. Un `orderNew` tardío puede completar la fecha de creación de una orden que ya terminó. No se guarda el cuerpo completo ni información de repartidores en las tablas nuevas.

Las cancelaciones genéricas (170) se consultan en `/v1/order/order/detail` en cuanto se guarda su webhook, siguiendo el flujo de `CancelOrderStatusSerializer` de grocery_tools. La respuesta al webhook no espera a DiDi: una consulta fallida deja la cancelación guardada para el reintento periódico. En cada ciclo se reintentan hasta 20 órdenes en grupos de cinco, con tiempo límite por consulta. El historial muestra las cancelaciones pendientes como «En proceso de clasificación»; quedan fuera del denominador y no generan alertas basadas en un CR potencialmente incompleto.

## Ejecución y entregas

El coordinador despierta cada minuto para recuperar fallos y entregas pendientes, pero una restricción única permite una sola revisión por marca y ventana de 15 minutos, incluso con varias réplicas. Si falta atribuir cancelaciones, vuelve a intentar durante esa ventana de ejecución y guarda el resultado incompleto al final de ese período. El historial muestra las últimas 100 revisiones, métricas, estado y errores de envío.

Las alertas se persisten antes de enviarse, se reclaman mediante actualización condicional y se reintentan hasta tres veces. Se recuperan envíos interrumpidos durante más de dos minutos. Desactivar el monitoreo o el webhook suprime alertas pendientes. D-Chat no ofrece una clave de idempotencia en este contrato: una interrupción después de que el proveedor acepte un mensaje puede causar un reenvío.

No se reconstruyen estados finales de órdenes históricas a partir de registros `orderNew`. El cálculo empieza con los eventos de ciclo de vida recibidos después del despliegue. Tampoco se reprocesan ventanas ya cerradas por eventos que lleguen después de la evaluación ni se recuperan todas las ventanas omitidas durante una caída prolongada del servicio. Estos casos requieren un proceso adicional de conciliación histórica.

## Validación local

`backend/test/completion-rate.test.ts` cubre horarios de México, umbrales, cancelaciones, int64, eventos duplicados/desordenados, requisitos de configuración, aislamiento de marcas/aplicaciones y entrega/reintento de D-Chat. También se ejecutan las pruebas existentes de Order Webhooks y se compilan backend y frontend. Estas pruebas no envían mensajes reales ni modifican una base de producción.

## IDs por revisión y filtros

La migración `20261030010000_completion_rate_run_order_ids` agrega una instantánea de IDs por revisión: completadas, canceladas computables y pendientes de clasificación (170). Cada conteo se puede desplegar en el historial. Los IDs se conservan como texto y no cambian si después se clasifica una cancelación. Las revisiones anteriores mantienen `order_ids = NULL` y muestran «IDs no disponibles»; no se reconstruyen con estados actuales ni se recalculan alertas históricas. Las órdenes en curso no forman parte de las revisiones.

El filtro «Funciones activas» permite ver todas las marcas, las que tienen alertas, las que tienen cierre automático o las que tienen ambas funciones; se combina con la búsqueda por nombre o aplicación.
