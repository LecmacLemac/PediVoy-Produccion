# Operación y activación de agentes personales

Este documento complementa `docs/mi-agente.md`. La implementación local no autoriza ni ejecuta migraciones, publicación o despliegue en producción.

## Estado seguro por defecto

- Las rutas de gestión y la pantalla existen, pero crear y usar credenciales requiere `PERSONAL_AGENTS_ENABLED=1` y un `AGENT_CANONICAL_ORIGIN` HTTPS exacto, sin ruta ni barra final.
- No se obtiene el origen de `Host` ni de cabeceras forwarded. Debe coincidir con el dominio desde el que se abre la pantalla; otro dominio/alias no puede crear ni revocar credenciales mediante una petición de navegador.
- El apagado de la función bloquea el uso operativo; la gestión de conexiones existentes, su revocación y la auditoría siguen disponibles si el esquema existe. No requiere licencia vigente para revocar.
- El esquema no se crea por peticiones HTTP ni mediante la simple carga del módulo. Antes de migrar, las consultas que lo requieran fallan sin acceder a datos de negocio.

## Secuencia de despliegue del operador

1. Verificar respaldo restaurable del destino, versión de Node dentro de la rama 22 y dependencias instaladas con el lockfile. No ejecutar `npm audit fix` ni actualizaciones generales como parte de esta activación.
2. Publicar exclusivamente los archivos de la mejora y desplegar inicialmente con la función deshabilitada.
3. En un entorno administrativo autorizado, con `DATABASE_URL` ya configurada de forma segura para el destino correcto, ejecutar:

   ```sh
   node scripts/init-agent-integrations.js --apply
   ```

   El runner no carga `.env`, exige el argumento explícito y aplica el SQL dentro de una transacción con `search_path` local y lock de migración. No copiar la URL ni contraseñas al chat, documentación o logs. Ante fallo no habilitar la función ni asumir una migración parcial correcta.
4. Configurar `AGENT_CANONICAL_ORIGIN` con el origen HTTPS público exacto y `PERSONAL_AGENTS_ENABLED=1`; reiniciar/desplegar el proceso para tomar la configuración.
5. Hacer un piloto consentido en una empresa de prueba, con datos sintéticos y permisos de lectura antes de habilitar una escritura opcional. No verificar esta mejora aprobando pagos, marcando entregas físicas o enviando mensajes reales.
6. Comprobar creación y visualización única de token, herramientas anunciadas para el rol, aislamiento de empresa/asignación, auditoría y revocación. Una prueba local no verifica la configuración de Render, el dominio ni la compatibilidad con un producto comercial.

## Permisos y credenciales

- El token es independiente de la sesión humana y sólo se envía como `Authorization: Bearer` a la API de agentes. No usarlo en otras APIs, cookies, query strings, URLs o enlaces.
- Cada conexión tiene una empresa explícita. Para super tampoco existe acceso global automático ni excepción a la licencia de la empresa seleccionada.
- Duración por defecto: 7 días; máximo: 30 días. Máximo: 10 conexiones activas por usuario. Cuota de altas: 30/hora por usuario; cuota de autenticaciones/operaciones: 60/minuto por usuario y conexión. El puente realiza descubrimiento además de la ejecución, por lo que una acción puede consumir varias unidades de cuota.
- Los permisos efectivos nunca superan los scopes concedidos ni las políticas del rol al emitir y del rol vigente. Cambios de empresa, vínculo operativo o baja revocan de forma persistente, incluso si el vínculo se restaura después.
- Un token perdido no se recupera: revocar la conexión y crear otra. Si se filtra, revocar inmediatamente; borrar una copia local no revoca el acceso.

## Escrituras y respuestas inciertas

Sólo están delegadas la toma de un pedido pendiente vacante y la reapertura de cancelado a pendiente, cada una con scope de escritura opcional. No hay delegación de entregas, pagos, emisión fiscal, WhatsApp, borrados o administración de permisos.

Conservar un `operation_id` UUID por operación lógica. La misma clave con otra herramienta o argumentos se rechaza. El servidor vuelve a validar autorización antes de devolver un resultado guardado. No generar una clave nueva para resolver un timeout ni reintentar automáticamente: una respuesta perdida puede ocurrir después del COMMIT. Consultar el estado y conciliar; sólo recuperar la operación con su clave original y una credencial todavía autorizada.

## Incidentes y observabilidad

- Detención global: quitar `PERSONAL_AGENTS_ENABLED=1` y reiniciar el proceso. No borrar tablas, historial o claves como mecanismo de corte.
- Detención individual: revocar desde Mi agente. La revocación puede ordenarse después de una operación que ya adquirió sus locks; no revierte una operación confirmada anteriormente.
- Auditar resultados `ok`, `error`, `replayed` y `rate_limited`. No registrar argumentos, resultados completos, tokens, errores SQL detallados o datos personales en diagnósticos.
- Supervisar errores 401/403, 429, resultados inciertos y crecimiento de las tablas `agent_audit`, `agent_idempotency` y `agent_connections`. Esta entrega no configura cron de mantenimiento ni elimina registros automáticamente. El operador debe definir retención y respaldo antes de abrir el acceso masivamente; nunca purgar claves de idempotencia de conexiones activas ni ampliar límites sin revisar capacidad.

## Compatibilidad real

La API es REST de herramientas cerradas. El puente incluido habla MCP **stdio local** usando el SDK oficial; requiere un cliente que pueda ejecutar ese proceso y dependencias al lado del script descargado. No es un servidor MCP remoto OAuth ni una promesa de compatibilidad automática con cualquier plataforma. La excepción HTTP loopback es exclusivamente para desarrollo, no para un servidor público.
