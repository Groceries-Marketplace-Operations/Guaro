# Gestor de promociones en Tequila

Esta carpeta conserva la lógica de la herramienta local de promociones: lectura de CSV/XLSX y SFTP, diagnóstico, vista previa, envío por tienda, consulta de Task ID y auditoría. El servidor corre en el servicio Docker `promo-manager` con Node 22, separado del backend que acepta órdenes. No inicia cargas ni trabajos programados por sí solo.

## Acceso y datos

- Interfaz: **Custom integrations → Gestor de promociones**, o `/guaro/promo-manager/index.html`.
- API pública: `/guaro/api/promo-manager/*`. Caddy la envía al backend de Tequila; el proxy Nest exige JWT y rol `admin` o `super_admin`, y reenvía a `promo-manager:5373/api/*` en la red interna. El token de sesión no se reenvía al servicio de promociones.
- Las cuentas SFTP, tiendas y secretos de aplicación se consultan en PostgreSQL de Tequila mediante el script `scripts/remote-soriana-sftp.cjs` ejecutado **dentro del contenedor de promociones**. No se copian `.env`, llaves SSH ni el inventario local de tiendas al repositorio o a la imagen.
- `stores.json` contiene los parámetros generales y `stores: []`. Al cargar `/api/config`, el catálogo real se obtiene de las cuentas SFTP y marcas activas de Tequila. Si esa consulta falla, el catálogo no muestra tiendas para evitar destinos obsoletos.
- Los archivos de auditoría nuevos se guardan en el volumen Docker `promo_manager_output` (`/app/promo-manager/output`). Los ~624 MB de auditorías históricas de la herramienta local permanecen en la computadora original; no se incluyen en la imagen ni se eliminan.
- La imagen incluye `/usr/bin/openssl` 3 desde la etapa de compilación. Prisma lo necesita para seleccionar el motor compatible con `linux-musl-openssl-3.0.x` al consultar PostgreSQL.

## Dependencia XLSX

La herramienta usa SheetJS `xlsx` 0.20.3, cuya versión original se distribuye fuera de npm. Para hacer reproducible el build sin depender de `cdn.sheetjs.com`, `vendor/xlsx-0.20.3.tgz` se generó con `npm pack` a partir de la instalación local existente de esa misma versión. SHA-256: `A2DAB7F6BC139351376492C6238E5CA0F68B5859CD630CFC66C4B3BB7D46D738`. El lockfile usa `file:vendor/xlsx-0.20.3.tgz`.

## Verificación

```bash
cd promo-manager
npm ci
npm test
```

Las pruebas usan `test/test.env`, que solo apunta a `test/stores.fixture.json` con tiendas ficticias y ningún token. Para la imagen de producción, `PROMO_SFTP_LOCAL_RUNNER=1`, `DATABASE_URL`, `APP_SECRET_ENCRYPTION_KEY` y `PROMO_API_URL` se configuran en `docker-compose.prod.yml`. `/api/health` es un chequeo de proceso; `/api/config` confirma además la lectura de cuentas y tiendas.
