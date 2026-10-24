# Limpieza de logs de integraciones

`IntegrationLogsCleanupService`, registrado en `SchedulerModule`, ejecuta una limpieza diaria a las 03:00 en `America/Mexico_City`. El corte es la hora de inicio menos 72 horas exactas; los registros exactamente en el corte se conservan hasta la siguiente ejecución diaria. El horario no depende de la zona horaria del servidor.

## Order webhooks logs

Se eliminan físicamente las solicitudes de `didi_order_webhook_request` creadas antes del corte, con resultado distinto de `processing` y `completed_at` registrado. Esto aplica al historial global y al de cada aplicación y reduce sus contadores y resúmenes a los registros conservados. Las solicitudes en curso se mantienen.

Los eventos de `didi_order_webhook_event` se conservan: son el registro operativo de deduplicación, del máximo de confirmaciones por orden y de los importes reconocidos. Borrarlos permitiría que una notificación repetida volviera a confirmar una orden antigua. La limpieza de logs no borra órdenes en DiDi, aplicaciones ni destinos de forwarding; tampoco modifica la cola de forwarding.

## SFTP to API

Se eliminan físicamente las ejecuciones creadas y finalizadas antes del corte, excepto estados `pending` y `running`. También se eliminan todos sus envíos, incluidos payloads cifrados, respuestas y errores. Las ejecuciones con errores o que requieren revisión están sujetas al mismo plazo una vez finalizadas.

Los registros de archivos se compactan: se conservan su identidad por regla/nombre, estado y fechas para impedir un reenvío automático. Se eliminan hash y reporte y se desvinculan de la ejecución eliminada (`run_id = NULL`). No se muestran en el historial. El lector sigue consultándolos, incluso si se configura una antigüedad de archivos superior a tres días. El borrado explícito de registros por regla mantiene su comportamiento y permite eliminar estos marcadores.

Las configuraciones, horarios, última lectura, último envío y archivos remotos no se modifican. Cada lote SFTP es una transacción: si alguna operación falla, se revierten tanto la compactación como el borrado de envíos y ejecuciones.

## Ejecución y despliegue

- Hasta 100 lotes por historial en cada ciclo: 1,000 solicitudes webhook o 100 ejecuciones SFTP por lote. El remanente se procesa en la siguiente ejecución diaria para limitar la carga sobre la base.
- Un bloqueo transaccional de PostgreSQL coordina los lotes entre réplicas; una guardia local evita solapamientos en la misma instancia.
- Los errores se registran y se reintentan en la siguiente ejecución diaria; un fallo en un historial no impide limpiar el otro.
- No hay limpieza al arrancar ni borrado de datos dentro de la migración. La primera limpieza ocurre a las siguientes 03:00 de Ciudad de México después del despliegue.
- Si el backend estuvo detenido, el siguiente ciclo usa la hora actual y recupera la limpieza pendiente en lotes.

Aplicar `npx prisma migrate deploy --schema ../prisma/schema.prisma` desde `backend`, regenerar el cliente Prisma y compilar antes de desplegar. La migración `20261022010000_integration_logs_retention` permite desvincular los marcadores SFTP y añade un índice para buscar ejecuciones antiguas por fecha de finalización. No ejecuta una limpieza inmediata.
