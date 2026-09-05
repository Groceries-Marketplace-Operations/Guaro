# Acceso local temporal a producción

Este modo ejecuta **sólo el frontend local** y envía sus llamadas a
`https://workspace.didi-shop.com/guaro/api` mediante un proxy Vite ligado a
`127.0.0.1`. No inicia un backend, scheduler o worker local.

La sesión se emite dentro del contenedor productivo mediante SSH. El JWT:

- dura como máximo 15 minutos;
- queda únicamente en una variable del proceso servidor de Vite;
- no se incluye en variables `VITE_*`, bundles, URLs, query strings,
  `localStorage` ni `sessionStorage`;
- se agrega como `Authorization` sólo al upstream `/guaro/api`;
- se revoca al terminar el launcher, además de expirar automáticamente.

## Uso

Desde la raíz del repositorio:

```powershell
.\scripts\start-local-production.ps1 -Reason 'Diagnóstico del módulo de inventario'
```

El launcher elige un puerto dinámico alto distinto para cada sesión e imprime
la URL exacta `http://127.0.0.1:<puerto>/guaro/`. Ábrela manualmente: el
launcher no abre el navegador. No uses `localhost`; el proxy acepta únicamente
el host y origen numérico `127.0.0.1`. La interfaz muestra una franja roja
permanente para dejar claro que cada operación afecta producción.

Parámetros opcionales:

```powershell
.\scripts\start-local-production.ps1 `
  -Reason 'Validación puntual' `
  -Email 'eduardolarazarrabal@didi-labs.com' `
  -TtlMinutes 10 `
  -SshHost 'root@209.38.73.188' `
  -SshKey "$env:USERPROFILE\.ssh\guaro_digitalocean_ed25519" `
  -Port 55123
```

`Reason` tiene un valor seguro por defecto, pero conviene describir cada uso.
`Email` siempre debe corresponder a una cuenta activa en Tequila; el CLI no
acepta roles ni permisos suministrados desde local. Omite `Port` (o usa `0`)
para seleccionar un puerto aleatorio disponible entre 49152 y 65535.

El launcher deriva la identidad de auditoría en el servidor usando el usuario
SSH y la IP origen de `SSH_CONNECTION`; ningún parámetro local puede elegirla.
Inicia Node/Vite directamente con `--use-system-ca`, elimina `NODE_OPTIONS` y
otras variables Node sensibles del entorno hijo, y coloca el JWT únicamente en
ese hijo. El entorno del proceso PowerShell padre nunca recibe el JWT.

## Cierre y revocación

Usa **Cerrar sesión** en Tequila o `Ctrl+C` en la terminal. Ambos terminan el
servidor local; el bloque `finally` mata el proceso hijo si siguiera vivo,
elimina su copia de configuración y solicita la revocación por SSH. Si la
revocación no pudiera confirmarse, el JWT vence por sí solo dentro del límite
emitido.

No copies el JWT a archivos `.env`, comandos, consola del navegador o gestores
de secretos del frontend. El launcher fue diseñado para que no sea necesario
verlo ni copiarlo.
