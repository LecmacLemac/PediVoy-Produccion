# Personal Agent Integrations Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Cada usuario conecta su agente externo con credencial propia, permisos explícitos limitados por su identidad vigente, y acceso únicamente a su empresa/registros autorizados.

**Architecture:** API de herramientas cerradas autenticada con credenciales personales opacas, distintas del JWT humano. Las conexiones guardan solamente hash del secreto; verifican usuario/rol/empresa/vínculos vigentes. Un puente MCP stdio oficial convierte herramientas en llamadas HTTPS a esta API: no se presenta un endpoint remoto con autenticación casera como OAuth/MCP universal.

**Tech Stack:** Node ESM, Express 4, PostgreSQL, node:test, Puppeteer; SDK MCP oficial para el puente stdio.

## Alcance y límites deliberados

- Gestión personal disponible para siete roles exactos: user, repartidor, referente, facturacion, contable, admin, super.
- Consultas permitidas por rol; repartidor no recibe el listado general de pedidos y referente no recibe datos de otros referentes.
- Primeras escrituras delegables, opcionales y desmarcadas: tomar pedido disponible (repartidor) y reabrir Cancelado a Pendiente (admin/super), reutilizando validaciones transaccionales canónicas.
- No delegar entregas físicas, acreditación de pagos, emisión fiscal, WhatsApp, borrados, administración de usuarios, claves, SQL ni HTTP arbitrario.
- La conexión nunca hereda una promoción: autorización efectiva = scopes concedidos ∩ política del rol al emitir ∩ política del rol vigente. Cambio de empresa o vínculo operativo invalida el acceso; baja/revocación/expiración bloquean inmediatamente nuevas operaciones.
- Cada conexión de super queda atada a UNA empresa seleccionada; no hay acceso global implícito.
- Tokens sólo en Authorization Bearer, nunca query/cookie, logs, auditoría, listados ni almacenamiento persistente del navegador. Se muestran una vez al crear; copiar/exportar es decisión explícita del usuario.
- Habilitación operativa con PERSONAL_AGENTS_ENABLED=1 y AGENT_CANONICAL_ORIGIN HTTPS explícito. No habilitar ni migrar producción durante desarrollo. Gestión/revocación permanece disponible con licencia vencida; creación/uso operativo exige licencia vigente.
- Origen canónico exacto + JSON en mutaciones humanas. Sin DDL dentro de requests. Respuestas privadas no-store, límites por usuario/conexión y límites de paginación/tamaño.

## Contratos entre componentes

### Núcleo: src/agents/policy.js, src/agents/service.js, src/agents/schema.sql; src/routes/miAgente.js

`policy.js` exporta `SCOPES` (array {scope,label,description,write,roles}), `allowedScopesForRole(role)` y `effectiveScopes(connection, actor)`.
Scopes acordados: identity:read (todos), catalog:read (user/admin/super/referente), orders:read (user/admin/super), deliveries:read (repartidor), referrals:read (referente), billing:read (user/facturacion/contable/admin/super), deliveries:claim (repartidor), orders:reopen (admin/super).

`createAgentService({query,withTransaction,enabled,canonicalOrigin,now})`:
- `getPolicy(actor)` -> {enabled,scopes,maxConnections,maxExpiryDays,canonicalOrigin}; sólo metadatos públicos de configuración.
- `listConnections(actor)` -> array de metadatos sin secretos/hashes.
- `createConnection(actor,{name,scopes,expires_in_days,empresa_id?})` -> {connection,token}; super debe elegir empresa; restantes no pueden modificarla.
- `revokeConnection(actor,id)` -> resultado idempotente propio.
- `listAudit(actor,{limit,before})` -> registros propios con cursor, nunca argumentos/PII/secreto.
- `authenticate(token,{scope?,txQuery?,lock?})` -> {actor,connection,empresaId,scopes}; token inválido/usuario desactivado/tenant o vínculo cambiado -> error seguro status/code. Reusar la validación canónica de identidad, no aceptar JWT humano como token de agente.
- `execute(token,{scope,tool,idempotencyKey?,requestHash?,write},work)` -> resultado de `work(context)`; context incluye `query` de la transacción, `actor`, `connection`, `empresaId`, `scopes`. Para escrituras bloquear conexión/usuario, revalidar dentro de transacción, exigir clave UUID, persistir idempotencia y auditoría en la misma transacción; mismo key/payload devuelve resultado guardado, distinto payload 409. Sin reintento automático ante outcome ambiguo.

`createMiAgenteRouter({withAuth,service,canonicalOrigin})` expone bajo `/api/mi-agente`: GET /policy, GET /connections, POST /connections, POST /connections/:id/revoke, GET /audit. Propietario siempre de req.user.uid; mutaciones JSON + Origin configurado exacto; errores sanitizados, no-store. Listar/revocar no requiere licencia vigente.

Esquema idempotente en archivo SQL dedicado y esquema canónico initDb.sql; runner manual scripts/init-agent-integrations.js exige --apply. Pruebas con PostgreSQL aislado, nunca DB del .env.

### Herramientas: src/agents/tools.js, src/routes/agentTools.js

`createAgentTools({query,withTransaction,...domainDeps})` exporta registry inmutable de {name,description,scope,inputSchema,readOnly} y métodos `list(context)`, `get(name)`, `call(name,args,context)`.

`createAgentToolsRouter({service,tools})`, montado `/api/agent/v1`:
- GET /tools: autentica credencial dedicada y entrega sólo herramientas efectivas.
- POST /tools/:name: body JSON estricto {arguments}; validar contra esquema cerrado; auth de nuevo, scope, clave operation_id UUID obligatoria para escrituras. Usar service.execute y hash canónico del nombre/argumentos; ninguna URL/path/headers arbitrarios. Respuesta {ok:true,result}; errores {ok:false,error:{code,message}} sanitizados.
- Middleware Bearer sólo; rechazar tokens de query/cookie, exceso body, campos desconocidos; limitar tamaño de respuestas y por principal. No CORS permisivo para este protocolo.
- Lecturas parametrizadas y paginadas con campos mínimos, empresa explícita; assigned-only en mis entregas y relaciones históricas correctas del referente.
- Escrituras reutilizan el handler canónico bajo la transacción del contexto, sin crear JWT humano interno ni fabricar confirmaciones de entrega/pago. El handler no puede abrir transacción independiente de la revalidación y auditoría.

### UI/puente: pedidos/mi-agente.html, pedidos/mi-agente.js, pedidos/agent-bridge.mjs

UI en español, accesible y responsive: estado de activación, alta con nombre/expiración/scopes y empresa explícita para super, listas propias, revocar, auditoría paginada y secreto de una sola visualización. Sin localStorage/sessionStorage de secretos; borrar token del DOM al cerrar/abandonar, configuración copiada sólo con click explícito; advertencia sobre envío de datos a proveedor externo. Sin pedir JWT humano. authFetch con credentials include; /api/me; login next interno en 401; 402/403 diferenciados.

Navegación: dashboard.html, inicio/inicial.html, repartidor.html (href sin data-sec), referente-{panel,clientes,pedidos,comisiones,perfil}.html. No editar otros cambios ajenos.

Puente stdio con @modelcontextprotocol/sdk versión verificada en npm, stdout sólo MCP, HTTPS obligatorio salvo loopback, token desde PEDIVOY_AGENT_TOKEN y origen desde PEDIVOY_AGENT_URL, timeout, redirects rechazados, sin reintentos automáticos; herramientas descubiertas de la API y autorización revalidada por llamada. No afirmar compatibilidad universal ni OAuth. Entregar instrucciones reales para instalar dependencia y configurar el script externo; no inventar paquete npm publicado.

## Secuencia TDD y revisión

1. Núcleo: escribir y ejecutar pruebas rojas de tokens/scopes/CSRF; implementar; verificar con node --test tests/agent-identity*.test.js tests/agent-connections*.test.js tests/agent-service*.test.js. Incluir PG aislado: expiración, revocación, usuario activo, cambios de rol/empresa/chofer/referente, dos usuarios de igual empresa, super acotado, secretos sólo una vez, idempotencia y carrera de revocación.
2. Herramientas: pruebas rojas de inventario y lecturas cruzadas; implementar consultas/handlers; verificar tests/agent-tools*.test.js con fixtures sintéticos. Probar intentos de usar SQL/URL/body arbitrarios, otra empresa/repartidor/referente, escritura sin scope, repetir key/cambiar payload y ausencia de efectos financieros/notificaciones.
3. UI/puente: pruebas rojas y navegador con backend sintético; implementar; verificar tests/mi-agente*.test.js tests/agent-bridge*.test.js. Ejercitar escritorio/móvil, teclado, errores, revocación, scopes y ausencia de secretos persistidos. Puente usando cliente MCP oficial, no un JSON fabricado.
4. Integración padre: montar factories en src/routes/mountApiModules.js usando dependencias reales, sin bypasses ni inicialización del esquema por request; incorporar inventario de mutaciones/contratos de autoridad. Verificar app factory estática y suites de auth/tenancy/repartidor/backoffice existentes.
5. Revisión independiente de cumplimiento; resolver hallazgos. Después revisión de calidad/seguridad y resolver hallazgos antes de finalizar.
6. Ejecutar suites enfocadas agregadas, inspeccionar capturas reales y comprobar diff/whitespace/secretos y archivos permitidos. Reportar lo realmente probado, alcance limitado, activación/migración necesaria y publicación/despliegue separados. No publicar sin autorización posterior.

## Puertas adicionales del modelo de amenazas

- Invalidez permanente de conexiones ante cambio de empresa/vínculo operativo o baja, incluso si se restaura A→B→A; usar revocación persistida mediante triggers idempotentes para cubrir también actualizaciones directas. El cambio de rol aplica intersección de permisos y no puede ampliar los scopes originalmente concedidos.
- Orden de locks uniforme: localizar conexión sin lock para identificar propietario, bloquear usuario, vínculo operativo, licencia de empresa y conexión; después recursos de negocio. Revalidar todo antes de mutar o devolver un resultado idempotente.
- La licencia operativa es la de la empresa seleccionada también para conexiones de super. La excepción de licencia de la sesión humana no habilita a sus agentes a operar empresas vencidas.
- `withTransaction` debe recibir `maxRetries:0` explícito para escrituras del agente; no reejecutar callbacks automáticamente ni ejecutar efectos externos dentro o fuera de la transacción. Un commit ambiguo requiere recuperación con la misma clave y autorización vigente, nunca una nueva operación automática.
- Cuotas atómicas por propietario además de conexión: rotar credenciales no evade límites. Pruebas de altas y llamadas concurrentes, claves repetidas, cambio de payload/herramienta, rollback y revocación durante operaciones.
- Boundary HTTP antes de CORS/parser legacy para lecturas y escrituras personales; tamaño máximo también para cuerpos chunked y descomprimidos, rechazo de Origin:null/ajeno y formatos alternativos. Errores nunca reflejan cuerpos o secretos.
- Proyección explícita de columnas por herramienta; no SELECT *, SQL/URL/cabeceras libres, cursores ajenos ni lectura general de pedidos para roles operativos. Verificar intervalos de asociación del referente.
- Provocar fallos SQL/upstream/MCP con datos señuelo para verificar ausencia de secretos o PII en logs, auditoría, errores y almacenamiento del navegador.

## Fuentes consultadas

Documentación primaria MCP: especificación de autorización 2026-07-28 (OAuth para HTTP remoto), documentación SDK TypeScript (stdio y Streamable HTTP). Registro npm consultado: @modelcontextprotocol/sdk 1.32.1, engines Node >=18, dependencia Zod ^3.25 o ^4. El puente stdio evita declarar una autenticación HTTP MCP incompatible y deja OAuth remoto para una entrega específica posterior.
