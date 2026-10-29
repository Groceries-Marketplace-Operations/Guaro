# Limpieza de logs de integraciones

`IntegrationLogsCleanupService`, registrado en `SchedulerModule`, inicia la limpieza a las 03:00 y realiza pasadas cada 10 minutos hasta las 05:50 en `America/Mexico_City` (18 pasadas por noche). El corte de cada pasada es su hora de inicio menos 72 horas exactas; los registros exactamente en el corte se conservan hasta la siguiente pasada. El horario no depende de la zona horaria del servidor.

## Order webhooks logs

Se eliminan físicamente las solicitudes de `didi_order_webhook_request` creadas antes del corte, con resultado distinto de `processing` y `completed_at` registrado. Esto aplica al historial global y al de cada aplicación y reduce sus contadores y resúmenes a los registros conservados. Las solicitudes en curso se mantienen.

Los eventos de `didi_order_webhook_event` se conservan: son el registro operativo de deduplicación, del máximo de confirmaciones por orden y de los importes reconocidos. Borrarlos permitiría que una notificación repetida volviera a confirmar una orden antigua. La limpieza de logs no borra órdenes en DiDi, aplicaciones ni destinos de forwarding; tampoco modifica la cola de forwarding.

## SFTP to API

Se eliminan físicamente las ejecuciones creadas y finalizadas antes del corte, excepto estados `pending` y `running`. También se eliminan todos sus envíos, incluidos payloads cifrados, respuestas y errores. Las ejecuciones con errores o que requieren revisión están sujetas al mismo plazo una vez finalizadas.

Los registros de archivos se compactan: se conservan su identidad por regla/nombre, estado y fechas para impedir un reenvío automático. Se eliminan hash y reporte y se desvinculan de la ejecución eliminada (`run_id = NULL`). No se muestran en el historial. El lector sigue consultándolos, incluso si se configura una antigüedad de archivos superior a tres días. El borrado explícito de registros por regla mantiene su comportamiento y permite eliminar estos marcadores.

Las configuraciones, horarios, última lectura, último envío y archivos remotos no se modifican. Cada lote SFTP trabaja sobre una ejecución finalizada y compacta hasta 100 marcadores y elimina hasta 25 envíos, seleccionando solo sus IDs. La ejecución se elimina cuando se han procesado todos sus hijos. Cada lote es una transacción independiente: un error revierte solo ese lote; los lotes anteriores quedan confirmados y la siguiente pasada continúa con los hijos pendientes. Durante la limpieza puede verse una ejecución antigua con parte de su historial ya eliminado.

## Ejecución y despliegue

- Hasta 100 lotes por historial en cada pasada: 1,000 solicitudes webhook por lote; SFTP limita las filas hijas como se describe arriba, no solo la cantidad de ejecuciones. Se dejan de iniciar lotes al alcanzar 60 segundos por historial; la transacción en curso conserva su máximo de 30 segundos. El remanente se procesa en la siguiente pasada para limitar la carga sobre la base.
- La capacidad teórica de webhooks aumenta de 100,000 por día a 1,800,000 por noche. Es un máximo, no una garantía: depende del trabajo pendiente, la duración de los lotes y la disponibilidad de la base.
- Un bloqueo transaccional de PostgreSQL coordina los lotes entre réplicas; una guardia local evita solapamientos en la misma instancia.
- Los errores se registran junto con el avance ya confirmado y se reintentan en la siguiente pasada; un fallo en un historial no impide limpiar el otro. Los logs distinguen `sin_pendientes`, `limite_de_lotes`, `limite_de_tiempo` y `bloqueo_ocupado`, e incluyen registros, envíos y marcadores procesados.
- No hay limpieza al arrancar ni borrado de datos dentro de la migración. La primera limpieza ocurre en el siguiente horario nocturno programado después del despliegue.
- Si el backend estuvo detenido, el siguiente horario nocturno usa la hora actual y recupera la limpieza pendiente en lotes.

## Incidente confirmado el 28 de octubre de 2026

Los logs de producción del 26, 27 y 28 de octubre muestran 100,000 solicitudes eliminadas cada día: el límite anterior frenaba la reducción del acumulado. En esas mismas ejecuciones, SFTP falló por cierre de transacción; el día 28 Prisma reportó 58,398 ms transcurridos frente a un máximo de 30,000 ms. El lote antiguo seleccionaba 100 ejecuciones pero borraba todos sus hijos sin límite, por lo que podía exceder el tiempo y revertirse. La corrección limita las filas hijas y permite confirmar el avance por partes. No se necesita una nueva migración para esta corrección; requiere desplegar el backend actualizado y observar las siguientes pasadas.

Aplicar `npx prisma migrate deploy --schema ../prisma/schema.prisma` desde `backend`, regenerar el cliente Prisma y compilar antes de desplegar. La migración `20261022010000_integration_logs_retention` permite desvincular los marcadores SFTP y añade un índice para buscar ejecuciones antiguas por fecha de finalización. No ejecuta una limpieza inmediata.
