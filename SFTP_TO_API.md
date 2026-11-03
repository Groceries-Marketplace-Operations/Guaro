# SFTP to API

Ruta: `/guaro/integrations/sftp-api`. Disponible en **Integrations → SFTP to API**.

## Configuración

Una configuración por marca del catálogo. El asistente selecciona una aplicación API de **Admin → Applications** y una de **Admin → Aplicaciones SFTP**, además del regex de archivos, separador, encabezados, columnas y horarios diarios. La aplicación API debe corresponder al país de la marca; la SFTP debe estar activa y pertenecer a esa marca o no tener marca asignada. La programación se guarda pausada por defecto.

Las credenciales y la **Ruta raíz** se consultan desde las aplicaciones vinculadas al iniciar cada ejecución. El formulario muestra la ruta como dato de consulta, sin pedir ni guardar una carpeta independiente. Para cambiarla, edita **Ruta raíz** en **Aplicaciones SFTP**; el cambio se aplica a las siguientes ejecuciones. Si está vacía, se usa `/upload`, igual que en el resto de los flujos SFTP. La migración `20261008010000_sftp_api_use_application_root` elimina la columna duplicada de las reglas, conservando los metadatos de ejecuciones históricas.

Las columnas usan letras Excel (A, B, …, AA). El ID de tienda puede venir de una columna o del primer grupo de captura del regex de nombre de archivo; se conservan ceros iniciales. Por defecto los archivos se leen como UTF-8, con o sin BOM. El check **Convertir archivos que no están en UTF-8** habilita Windows-1252 (ANSI / Latin-1), UTF-16 LE o UTF-16 BE. Se decodifican antes de interpretar las columnas y se envían como JSON UTF-8; no se reescribe el contenido remoto. Se admiten campos entrecomillados y saltos de línea dentro de ellos.

El UPC es un identificador de texto obligatorio: admite letras y números Unicode (incluida Ñ), sin símbolos ni límite de 14 caracteres. Se eliminan espacios al inicio y al final. Para exportaciones especiales, un UPC alfanumérico terminado en `.0` pierde ese sufijo (`000123.0` → `000123`, `00A123.0` → `00A123`), sin convertirlo a número y conservando ceros iniciales. Otros símbolos o formatos como `123.5`, `ABC-123` o `ABC.0.0` producen un error con la fila correspondiente en el reporte del archivo. La misma normalización se aplica a `app_item_id` en Full y Delta y a `item_name` cuando es un código alfanumérico terminado en `.0`. Los nombres descriptivos (por ejemplo, `Leche 1.0`) se conservan. Los duplicados y el límite de productos se calculan con el ID normalizado, que también se utiliza en las referencias de categorías. Delta no envía ni valida UPC.

- **Full**: `/v3/item/item/uploadGrocery`, `merge_policy: 1`. Reemplaza menú e incluye stock. Entre los archivos nuevos elegibles selecciona el más reciente por tienda según modificación SFTP y nombre; los anteriores quedan registrados como sustituidos. Genera el menú Grocery y categorías Despensa, hasta 3,000 productos por categoría y 30,000 por tienda.
- **Delta**: `/v1/item/item/setstockSync`. Envía exclusivamente `app_item_id` y `stock`, en lotes de hasta 2,000. Redis coordina el límite por aplicación y tienda entre archivos, ejecuciones y workers: se espera al menos un minuto después de completar una petición, también si falla. Las demás tiendas tienen límites independientes. Procesa archivos nuevos de más antiguo a más reciente. Al fallar un lote se detienen los lotes restantes de esa tienda en ese archivo y continúan las demás tiendas y archivos.

También se admiten registros completos envueltos en comillas: si el lector obtiene una sola columna que contiene separadores, vuelve a interpretar ese registro como una fila delimitada. Las filas estándar con varias columnas, incluidas columnas entrecomilladas, conservan su lectura habitual. La opción de encabezado sigue controlando si se omite la primera fila (por ejemplo, `didiformato`).
- En Full se omiten las filas con precio regular cero y se reportan fila, tienda y producto. No se envían menús vacíos: si no queda ningún producto válido, el archivo queda con error. Delta conserva estas filas para actualizar stock.
- Los precios se convierten de pesos a centavos con redondeo decimal; el stock fraccionario se redondea hacia abajo. El precio de oferta es opcional y se incluye cuando el descuento es al menos 1%. El estado por defecto es 1 con stock y 2 sin stock, o se puede mapear una columna.
- Todas las lecturas programadas se calculan en `America/Mexico_City`, independientemente de la zona horaria del servidor. Tras una interrupción del servicio se recupera una ejecución vencida y se continúa con el próximo horario futuro; no se reproducen todos los horarios perdidos.

La autenticación y las cargas utilizan `https://openapi.didi-food.com`, compartido con los demás flujos DiDi Food.

**Antigüedad máxima del archivo (minutos)**: entero de 1 a 525600, inicialmente 30. Se compara una sola hora de selección con la última modificación (`mtime`) reportada por SFTP, que no necesariamente coincide con la hora de carga si el cliente conserva fechas originales. Solo se descargan archivos que coincidan con el regex, estén dentro del límite (inclusive) y no tengan un registro previo. Fechas futuras se omiten. Al descargar se comprueba que tamaño y modificación no hayan cambiado.

**Archivos registrados**: la clave es marca/configuración + nombre exacto, compartida entre Full y Delta. Un nombre registrado no se vuelve a descargar, aunque cambie su contenido, carpeta, modo o configuración. Los registros guardan fecha de modificación, hash, ejecución, resultado y error. Los archivos con errores o respuesta incierta también quedan registrados para evitar reintentos automáticos no deseados.

En el modal de una ejecución se puede eliminar un registro o todos los de esa ejecución, con permiso de configuración. El borrado se bloquea si hay ejecuciones pendientes o en curso. Solo elimina la marca de procesamiento: conserva el archivo remoto y los reportes históricos de envíos. La siguiente lectura puede procesarlo de nuevo, siempre que cumpla regex y antigüedad. Si el archivo incluye varias tiendas, se vuelven a enviar todas; revisa los reportes antes de repetir envíos inciertos.


### Opciones de archivo

- **Cambiar nombre del archivo**: configura **Reemplazar (regex)** y **Nuevo texto**. Se sustituye la primera coincidencia por texto literal; las demás partes se conservan. Por ejemplo, ^DJ_PVP_DIDI → Procesed produce Procesed_02112026_174910_0103.csv. Se renombra en la misma carpeta SFTP después de que todos los envíos aplicables del archivo sean aceptados, nunca ante rechazos o respuestas inciertas. Los archivos completamente sustituidos por otros más recientes no se renombran. Un regex sin coincidencia deja el nombre intacto. No se permiten rutas ni sobrescrituras. Se conserva el registro original y se reserva un marcador del nuevo nombre antes del renombrado para evitar repetir envíos, incluso si la conexión se interrumpe. Un fallo al renombrar queda en el reporte, sin repetir los envíos ya aceptados.
- **Varias tiendas en un mismo archivo**: corresponde a shopSource: column, por lo que las configuraciones existentes conservan su comportamiento. Se agrupa por la columna app_shop_id y cada tienda recibe su propio menú o stock. Sin marcar, se extrae la tienda del nombre original, antes del renombrado.
- **Usar formato preciosdidi**: configura separador |, encabezados, Windows-1252 y varias tiendas. Mapea tienda A, ID/UPC/nombre B, oferta C, precio regular D y stock F; la columna E no se utiliza. Conserva códigos como FALPAÑ009 y tiendas como 01.

Antes de desplegar, aplicar la migración 20261103010000_sftp_api_file_options y regenerar Prisma Client. Las opciones nuevas quedan desactivadas en reglas existentes; no se cambia su programación. La conversión, separación y payloads se verifican localmente; la aceptación de los códigos por la API real requiere una ejecución con la aplicación configurada.

## Historial y credenciales

La limpieza automática se ejecuta diariamente a las 03:00, hora de Ciudad de México (`America/Mexico_City`) y elimina las ejecuciones finalizadas hace más de 72 horas junto con sus envíos, JSON, respuestas y reportes de archivos. No elimina ejecuciones pendientes o en curso ni modifica las configuraciones, horarios o archivos remotos. Se conservan marcadores internos de nombre de archivo por regla, desvinculados del historial y sin hash ni reporte, para no repetir envíos después de la limpieza. Estos marcadores no aparecen en el historial; la acción explícita de eliminar registros de la regla también puede borrarlos. Requiere aplicar la migración `20261022010000_integration_logs_retention` antes de desplegar el backend. Consulta [INTEGRATION_LOG_RETENTION.md](INTEGRATION_LOG_RETENTION.md) para detalles operativos.

La base guarda por ejecución el modo, origen manual/programado, responsable, configuración utilizada, archivos leídos, archivos omitidos, estado y tiempos. Cada intento de envío tiene tienda, nombre y SHA-256 del archivo, endpoint, cantidad de productos, JSON, HTTP, respuesta API, taskID y duración.

En **Historial de lecturas y cargas**, seleccionar una fila o pulsar **Ver envíos** abre un modal con los archivos registrados de esa ejecución, incluidos los errores de lectura, y sus envíos a la API. Ambos listados tienen paginación. **Ver JSON** despliega el detalle justo debajo del envío seleccionado, con opciones para ocultarlo y descargarlo. Puede cerrarse el modal con el botón Cerrar, Escape o al pulsar fuera del modal.

Los timestamps se guardan como `TIMESTAMPTZ` y se muestran en horario MX. Cada envío también conserva `sent_at_mx` con su zona horaria. `lastUploadAt` indica aceptación de un envío, no finalización de toda la ejecución.

El cuerpo JSON exacto enviado se cifra con AES-256-GCM, usando `APP_SECRET_ENCRYPTION_KEY`, igual que las credenciales de los catálogos centrales. Las ejecuciones guardan las relaciones, sin copiar secretos, y consultan las credenciales vigentes al iniciar el procesamiento. Si una aplicación se elimina, se desactiva o deja de ser compatible, la ejecución falla antes de conectarse. La consulta/descarga expone el JSON con `auth_token` oculto. Las respuestas se depuran de tokens, contraseñas y secretos. No se publican archivos de auditoría en carpetas estáticas.

**Aceptado por API** significa que uploadGrocery recibió el menú. Este módulo conserva el taskID, pero no consulta el estado posterior de publicación. Stock completado corresponde a `errno: 0` del endpoint síncrono.

## Procesamiento y recuperación

La cola BullMQ `sftp-api` usa ejecuciones persistidas primero en PostgreSQL. Cada minuto se reconcilian ejecuciones pendientes con Redis. Hay exclusión por marca mediante bloqueo transaccional y un índice único parcial de ejecuciones activas.

Si una tienda falla al autenticarse, la API rechaza su envío o la respuesta no se puede confirmar, se registra el reporte y se continúa con otras tiendas. La ejecución termina **Con errores** y los horarios permanecen activos; el registro del archivo impide repetirlo automáticamente. Una interrupción del worker o un fallo general después de preparar un envío conserva la auditoría y deja la ejecución **Requiere revisión**, sin modificar la activación ni la próxima lectura programada. Los horarios activos continúan con archivos nuevos; los archivos afectados mantienen su registro para evitar reintentos automáticos y los envíos pendientes de confirmación quedan **Por confirmar**. Las configuraciones que ya estaban pausadas requieren reactivación manual.

Se conservan los primeros 30,000 IDs de producto únicos por tienda y archivo, tanto en Full como en Delta. Las filas de IDs adicionales se descartan y se reporta su cantidad. Si se repite un ID seleccionado, incluso después del límite, se conserva la fila con menor precio efectivo (oferta válida o precio regular), incluido su stock. En empate se conserva la primera; si Delta no tiene precios comparables, también se conserva la primera y se informa. Delta sigue enviando solo ID y stock. Los duplicados, sus filas y la selección quedan en el detalle del archivo registrado, sin convertir la ejecución en error.

Se valida la selección antes del primer envío. Los productos y reportes de cada archivo se guardan temporalmente cifrados en disco; durante los envíos se carga un archivo a la vez, sin acumular todos los menús en memoria. Full conserva el menú completo más reciente por tienda y Delta mantiene el orden de los archivos y sus lotes de stock. Los temporales se eliminan al finalizar o al manejar un error; una terminación forzada del proceso puede dejar temporales cifrados en el directorio temporal del sistema. Un archivo vacío, con datos seleccionados inválidos o modificaciones durante la descarga queda registrado con error; los demás archivos continúan. Límites por lectura: 500 archivos nuevos, 500 MiB en total y 25 MiB por archivo. Los errores de volumen indican la cantidad o el tamaño que excedió su límite. Las expresiones regulares tienen un límite de ejecución de un segundo.

## Instalación

Requiere PostgreSQL, Redis y la clave de cifrado ya utilizada por el proyecto. Antes de iniciar el backend actualizado:

```powershell
cd backend
npx prisma migrate deploy --schema ../prisma/schema.prisma
npm run prisma:generate
npm run build
```

La migración `20261007010000_sftp_to_api` crea tres tablas e incorpora los permisos de consulta, configuración y ejecución para Admin. Super Admin los obtiene del catálogo. Otros roles pueden recibirlos desde Roles y permisos. Recargar la sesión actualiza los permisos del frontend.

La migración `20261007020000_sftp_api_application_relations` enlaza configuraciones existentes por App ID y por conexión SFTP compatible única; si falta una entrada, importa su credencial cifrada al catálogo. Elimina las copias de secretos en reglas y snapshots. Las configuraciones migradas quedan pausadas y las ejecuciones pendientes requieren iniciarse de nuevo, para revisar las relaciones antes de usar el destino DiDi Food. No debe haber ejecuciones en curso durante la migración.

La migración `20261008020000_sftp_api_file_tracking` agrega el límite de antigüedad y los registros de archivos. Recupera los nombres de archivos que ya tienen reportes de envío, vinculándolos con su última ejecución, para no repetirlos tras actualizar. Los reportes de autenticación fallida se muestran con endpoint de autenticación e `itemCount: 0`, porque no se envió una carga de productos.

No se incluyen credenciales ni marcas de ejemplo en la base. La primera conexión real debe realizarse con los datos de una marca configurada desde la interfaz.

## Verificación

```powershell
cd backend
node --test --require ts-node/register --require tsconfig-paths/register test/sftp-api.test.ts test/sftp-api-processor.test.ts test/sftp-api-service.test.ts test/sftp-api-stock-limiter.test.ts
npm run build
cd ../frontend
npm run build
```

Las pruebas de procesamiento simulan SFTP y la API: no modifican tiendas reales. Cubren Full, Delta, mapeo, dinero, CSV, horarios MX, auditoría cifrada, aislamiento de fallos por tienda, límites de antigüedad, interrupciones, deduplicación por nombre y reprocesamiento después de borrar registros.

## Revisión de CodeQL

El buscador valida que `q` sea un texto antes de truncarlo: parámetros repetidos o estructurados reciben HTTP 400. Los regex son configurables de forma intencional; se limitan a 500 caracteres y tanto su compilación como sus coincidencias pasan por el mismo límite de ejecución de un segundo, sin interpolar patrones en código. Escapar los metacaracteres impediría configurar filtros y grupos de captura.

La alerta de MD5 en `didi-header-sign` se conserva visible para revisión: corresponde al esquema de firma que utiliza la integración DiDi Grocery, sobre HTTPS. Sustituirlo por SHA-256 sin soporte del proveedor cambiaría la firma enviada. No se ha desactivado la regla de CodeQL ni descartado la alerta; cualquier excepción de compatibilidad requiere revisión. El cifrado de auditorías usa AES-256-GCM y los hashes de archivos usan SHA-256.
