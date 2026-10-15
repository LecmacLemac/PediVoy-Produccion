# Mi agente: conexión personal por MCP local

`/pedidos/mi-agente.html` permite conectar un agente **externo** mediante MCP stdio. No es un chat interno ni el panel de agentes/jobs del super. La página consulta la identidad de sesión en `/api/me` (`{user}`) y los permisos vigentes en `/api/mi-agente/policy`.

## Crear y conectar

1. Abrí **Mi agente** desde la navegación e ingresá un nombre identificable.
2. Seleccioná sólo los permisos necesarios. Las lecturas autorizadas aparecen seleccionadas; los permisos de escritura aparecen **desmarcados**. La vigencia inicial es 7 días, nunca más de 30 ni del máximo de la política.
3. Sólo el rol `super` debe indicar un ID positivo de empresa. Los demás roles no eligen empresa: el servidor determina el ámbito desde la sesión.
4. Creá la conexión y guardá el token de un solo uso visual. Es una credencial dedicada, **no un JWT de sesión humana**. El token no se guarda en localStorage, sessionStorage ni URLs. Cerrar el diálogo, pulsar Escape, abandonar la página u ocultar la pestaña elimina el token y la configuración privada de la pantalla. La memoria administrada del navegador no garantiza borrado criptográfico y el portapapeles puede conservar copias: borrá su contenido cuando termines.
5. Descargá `/pedidos/agent-bridge.mjs` mediante el botón. Usá Node.js 22.12 o posterior dentro de la rama 22, acorde al `engines` del proyecto. En una carpeta propia, guardá el archivo con su nombre original y ejecutá:

```sh
npm init -y
npm install --save-exact @modelcontextprotocol/sdk@1.32.1 zod@3.25.76
```

Esto instala el SDK oficial al lado del script; no existe un paquete PediVoy que debas ejecutar con `npx`. Dentro del repositorio, las dependencias ya están declaradas y se instalan con `npm ci`.

6. En un cliente que admita servidores MCP **locales stdio**, agregá una configuración como ésta, ajustando el origen HTTPS y la ruta absoluta:

```json
{
  "mcpServers": {
    "pedivoy": {
      "command": "node",
      "args": ["/ruta/absoluta/agent-bridge.mjs"],
      "env": {
        "PEDIVOY_AGENT_URL": "https://tu-instancia.example",
        "PEDIVOY_AGENT_TOKEN": "TOKEN_DE_LA_CONEXION"
      }
    }
  }
}
```

La página ofrece **Mostrar configuración con token** y una copia separada, ambas explícitas, mientras el diálogo de creación está abierto. La configuración contiene un secreto: no la compartas ni la subas a Git. Conservá la credencial en el mecanismo seguro de tu cliente. Los datos que consulte el agente pueden salir hacia su proveedor de IA; revisá sus condiciones antes de conectar.

No se garantiza compatibilidad con un producto de IA específico. OAuth remoto, servidores HTTP MCP y registro dinámico de clientes no forman parte de esta entrega.

## Permisos y límites

La API determina los permisos finales y los verifica en cada operación, junto con vigencia, revocación y rol actual. La interfaz no es una barrera de autorización.

| Scope | Roles |
| --- | --- |
| `identity:read` | todos |
| `catalog:read` | user, admin, super, referente |
| `orders:read` | user, admin, super |
| `deliveries:read` | repartidor |
| `referrals:read` | referente |
| `billing:read` | user, facturacion, contable, admin, super |
| `deliveries:claim` | repartidor, opt-in |
| `orders:reopen` | admin, super, opt-in |

No registra entregas, cobros, pagos, mensajes de WhatsApp ni emisión de comprobantes. Sólo lectura y, con selección explícita, tomar/reabrir pedidos. Cada escritura exige `operation_id` UUID: el agente debe conservar **el mismo UUID al reintentar la misma operación**. El puente no genera UUIDs ni reintenta automáticamente; después de un timeout el resultado puede ser incierto y debe consultarse antes de reintentar. La idempotencia y la confirmación de acciones pertenecen a la API y al cliente, no a un supuesto buffer del puente.

## Transporte y seguridad

El puente usa `Server` y `StdioServerTransport` del SDK oficial. Descubre herramientas mediante `GET /api/agent/v1/tools` y ejecuta únicamente herramientas anunciadas con `POST /api/agent/v1/tools/:name`, JSON `{arguments}` y `Authorization: Bearer` dedicado. Vuelve a consultar herramientas en cada listado y llamada para reflejar revocación/cambios de rol. No expone una herramienta HTTP libre ni acepta URLs arbitrarias de llamada.

`PEDIVOY_AGENT_URL` debe ser un **origen** HTTPS sin ruta, credenciales, query ni fragmento. Sólo para desarrollo sintético puede usarse HTTP en `localhost`, `127.0.0.1` o `::1` con `PEDIVOY_AGENT_ALLOW_HTTP_LOOPBACK=1`. Nunca activar esa excepción para un servidor público. Timeout por defecto: 15 segundos; `PEDIVOY_AGENT_TIMEOUT_MS` permite entre 100 y 30.000 ms. El tamaño máximo de solicitud/respuesta es 1 MiB, sin redirecciones ni reintentos. stdout está reservado a mensajes MCP; stderr y errores MCP usan diagnósticos sanitizados, sin cuerpos remotos ni tokens. Los errores de API son `isError: true`, nunca respuestas exitosas ficticias.

## Estados y operación

- **Alta pendiente al ocultar o abandonar la página:** se descarta el token de la respuesta tardía y no se abre el diálogo, aunque vuelvas a la pestaña antes de recibirla. Esto no cancela ni revierte la creación en el servidor: revisá el listado y revocá la conexión antes de crear otra. La pantalla no reintenta el alta automáticamente.

- **401:** redirección al login con `next=/pedidos/mi-agente.html`, un destino interno fijo.
- **403:** falta de permisos, sin redirección que oculte la causa.
- **402:** licencia vencida; el listado, revocación y auditoría siguen disponibles cuando la API permite su consulta. Crear y usar conexiones requiere licencia vigente.
- **Feature apagada/origen sin configurar:** no se habilita crear. La pantalla explica la situación y mantiene consulta/revocación disponibles.
- **Revocar:** confirmación, botón bloqueado durante envío y relectura del listado. No es necesario recuperar el token.
- **Auditoría:** paginación por cursor; muestra sólo herramienta, estado, fecha e identificador de conexión. Nunca argumentos/resultados ni campos adicionales del evento.

## Pruebas reproducibles

```sh
npx puppeteer browsers install chrome
node --test tests/mi-agente.test.js tests/agent-bridge.test.js
```

Las pruebas levantan Express sintético en puertos efímeros loopback, sin app completa, DB ni servicios externos. El navegador carga el HTML/JS real y bloquea solicitudes fuera del origen sintético. El cliente MCP oficial inicia el puente por stdio y comprueba descubrimiento, replay con el mismo UUID, revocación, falta de UUID, error HTTP, JSON inválido, redirección, límite de tamaño, timeout y no filtrado del token. Las capturas se escriben en `$TMPDIR/mi-agente-desktop.png` y `$TMPDIR/mi-agente-mobile.png`. Para ejecutarlas fuera de Hermes definí `TMPDIR` a una carpeta temporal de tu elección.

Estas pruebas no prueban autorización real, base de datos, despliegue, políticas de un proveedor de IA ni compatibilidad específica con clientes comerciales. El backend es un contrato separado; sus mounts y controles de permisos deben validarse con sus propias pruebas antes de habilitar la función.
