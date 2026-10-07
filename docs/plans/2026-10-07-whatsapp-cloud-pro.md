# WhatsApp Cloud PRO Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Convertir `/pedidos/whatsapp-cloud.html` en una bandeja profesional, rápida y segura para operación diaria multiempresa, sin alterar la frontera outbound ni exponer información sensible.

**Architecture:** La entrega se construye sobre la proyección durable existente. Se agrega una identidad estable de conversación tenant-scoped, estado operativo con control optimista, lectura por usuario, búsqueda server-side, contexto allowlisted y respuestas rápidas. El frontend mantiene estado sólo en memoria, sincroniza lecturas con polling visible-only y conserva selección, scroll y borradores. Los replies siguen pasando exclusivamente por `src/wpp/enqueue.js` y `wpp_outbox`.

**Tech Stack:** Node.js 22, Express, PostgreSQL, HTML/CSS/JavaScript sin framework, `node:test`, navegador real.

---

## Invariantes no negociables

- `admin` sólo opera `req.user.empresa_id`; `super` selecciona empresa explícita y canónica.
- No existe vista global ni fallback a empresa `1`.
- No se persisten teléfonos, mensajes, búsquedas, borradores ni secretos en almacenamiento del navegador.
- No se exponen teléfonos completos, provider IDs, media IDs, URLs Meta, payloads, tokens ni errores SQL.
- Todo contenido remoto se renderiza con APIs seguras de texto; no `innerHTML` ni equivalentes.
- `wpp_outbox` permanece como única frontera outbound y `src/wpp/enqueue.js` conserva el único INSERT productivo.
- No retry automático de POST replies, especialmente ante timeout o `outcome_unknown`.
- No tocar archivos bajo `pages/**`.
- Las mutaciones usan `Content-Type: application/json`, Origin exacto e idempotencia.

## Task 1: Contrato confiable de reply y catálogo de errores

**Objective:** Tratar correctamente los replies nuevos e idempotentes y mostrar errores precisos, sanitizados y accionables.

**Files:**
- Modify: `pedidos/whatsapp-cloud.js`
- Modify: `pedidos/whatsapp-cloud-ui.js`
- Modify: `src/routes/whatsappCloudInboxAdmin.js`
- Test: `tests/whatsapp-cloud-inbox-frontend.test.js`
- Test: `tests/whatsapp-cloud-inbox-admin-api.test.js`

**Steps:**
1. Escribir tests RED para HTTP `200` replay, `202` alta, `409` conflicto, errores de sesión/origen/configuración y `503 outcome_unknown`.
2. Confirmar que `200` falla con la UI actual y que los errores hoy colapsan en mensajes genéricos.
3. Implementar contratos `accepted/deduplicated` y mapa allowlisted de errores.
4. Verificar que sólo `200/202` limpian borrador; errores deterministas conservan texto; outcome incierto bloquea reenvío.
5. Ejecutar suites focales y commit.

## Task 2: Identidad estable y estado operativo de conversaciones

**Objective:** Crear una conversación estable por `(empresa_id, participant_wa_id)` y permitir prioridad/estado con concurrencia optimista.

**Files:**
- Modify: `initDb.sql`
- Modify: `src/whatsappCloud/inboxRepository.js`
- Modify: `src/routes/whatsappCloudInboxAdmin.js`
- Test: `tests/whatsapp-cloud-inbox-postgres.test.js`
- Test: `tests/whatsapp-cloud-inbox-admin-api.test.js`
- Test: `tests/whatsapp-cloud-inbox-admin-postgres.test.js`

**Steps:**
1. Escribir tests RED de migración idempotente, backfill multiempresa, ID estable y `version` optimista.
2. Crear `whatsapp_cloud_conversations` con ID opaco, tenant, participante, `workflow_status`, `priority`, `version` y timestamps; constraints cerrados e índices.
3. Integrar creación/actualización idempotente con el protocolo de proyección existente sin invertir locks.
4. Cambiar listado e historial a IDs estables manteniendo compatibilidad controlada con URLs antiguas durante la migración.
5. Agregar `PATCH /conversations/:id/state` con `expectedVersion`; exactamente un ganador en carreras.
6. Ejecutar PostgreSQL real, suites focales y commit.

## Task 3: No leídos por usuario y cola priorizada

**Objective:** Distinguir trabajo pendiente y ordenar la bandeja por prioridad operacional.

**Files:**
- Modify: `initDb.sql`
- Modify: `src/whatsappCloud/inboxRepository.js`
- Modify: `src/routes/whatsappCloudInboxAdmin.js`
- Modify: `pedidos/whatsapp-cloud.js`
- Modify: `pedidos/whatsapp-cloud-ui.js`
- Test: API/PostgreSQL/frontend/browser focales.

**Steps:**
1. Escribir tests RED para watermarks independientes, inbound concurrente y contadores tenant-scoped.
2. Crear `whatsapp_cloud_conversation_reads` con FK compuesta y usuario.
3. Implementar mark-read en transacción corta coordinada con el lock tenant de la proyección.
4. Añadir `unreadCount`, `workflowStatus`, `priority`, `version` y contadores al DTO.
5. Implementar filtros rápidos y orden canónico: por responder, revisar, en proceso, respondidas.
6. Verificar carreras con PostgreSQL real y commit.

## Task 4: Búsqueda y contexto cliente/pedido

**Objective:** Encontrar conversaciones fuera de la primera página y brindar contexto operativo sin ambigüedad de identidad.

**Files:**
- Modify: `src/whatsappCloud/inboxRepository.js`
- Modify: `src/routes/whatsappCloudInboxAdmin.js`
- Modify: `pedidos/whatsapp-cloud.html`
- Modify: `pedidos/whatsapp-cloud.js`
- Modify: `pedidos/whatsapp-cloud-ui.js`
- Test: API/PostgreSQL/frontend/browser focales.

**Steps:**
1. Escribir tests RED de búsqueda server-side, paginación, aislamiento, query sensible en body y contexto `exact|ambiguous|none`.
2. Implementar `POST /conversations/search` con query de 2–80 caracteres y filtros allowlisted.
3. Buscar sólo nombre, dirección, teléfono normalizado y pedido; no texto de mensajes.
4. Implementar `GET /conversations/:id/context`; exigir una coincidencia tenant-scoped inequívoca.
5. Renderizar panel/context drawer con datos allowlisted y sin notas libres.
6. Ejecutar pruebas y commit.

## Task 5: Respuestas rápidas tenant-scoped

**Objective:** Acelerar respuestas frecuentes sin crear una nueva vía de envío.

**Files:**
- Modify: `initDb.sql`
- Modify: `src/whatsappCloud/inboxRepository.js`
- Modify: `src/routes/whatsappCloudInboxAdmin.js`
- Modify: `pedidos/whatsapp-cloud.html`
- Modify: `pedidos/whatsapp-cloud.js`
- Modify: `pedidos/whatsapp-cloud-ui.js`
- Test: API/PostgreSQL/frontend/browser focales.

**Steps:**
1. Escribir tests RED para CRUD, shortcut único normalizado, límites, orden, soft-disable y tenant isolation.
2. Crear `whatsapp_cloud_quick_replies` con auditoría, checks e índices.
3. Exponer GET/CRUD bajo el router admin existente y autorización exacta.
4. Insertar texto editable en el cursor; nunca enviar al seleccionar.
5. Verificar que ningún endpoint de respuestas rápidas toca `wpp_outbox` o Meta.
6. Ejecutar pruebas y commit.

## Task 6: Auto-refresh robusto y merge no destructivo

**Objective:** Mantener lista, historial y estados actualizados sin saltos, duplicados ni pérdida de trabajo.

**Files:**
- Modify: `pedidos/whatsapp-cloud.js`
- Modify: `pedidos/whatsapp-cloud-ui.js`
- Test: `tests/whatsapp-cloud-inbox-frontend.test.js`
- Test: `tests/whatsapp-cloud-inbox-browser.test.js`

**Steps:**
1. Escribir tests RED con timers falsos: visible-only, un ciclo en vuelo, backoff GET, cancelación y cero POST automático.
2. Implementar scheduler con timeout encadenado, `AbortController`, generación por tenant/conversación y backoff acotado.
3. Fusionar objetos por ID estable, conservar páginas antiguas y evitar vacío transitorio.
4. Preservar selección, scroll, foco, filtros, búsqueda y borrador.
5. Mantener historial anclado: auto-scroll sólo si el usuario estaba al final.
6. Ejecutar pruebas unitarias/browser y commit.

## Task 7: UI/UX profesional desktop y mobile

**Objective:** Entregar una interfaz de tres paneles en desktop y lista-detalle accesible en mobile.

**Files:**
- Modify: `pedidos/whatsapp-cloud.html`
- Modify: `pedidos/whatsapp-cloud.js`
- Modify: `pedidos/whatsapp-cloud-ui.js`
- Test: frontend/browser focales.

**Steps:**
1. Escribir tests RED para buscador, chips, contadores, contexto, estados vacíos/error/stale y tamaños móviles.
2. Implementar desktop: cola 360–400 px, chat flexible y contexto 300–340 px colapsable.
3. Implementar mobile: lista-detalle, filtros drawer, contexto bottom sheet y safe-area.
4. Añadir skeleton discreto, sincronización, datos stale, resultados y acciones recuperables.
5. Garantizar targets de 44 px, contraste, foco visible, landmarks, aria-live y reduced-motion.
6. Ejecutar browser tests en 320×568, 360×800, 390×844, 1024 y 1440×900; commit.

## Task 8: Compositor PRO

**Objective:** Hacer el envío rápido, inequívoco y seguro.

**Files:**
- Modify: `pedidos/whatsapp-cloud.html`
- Modify: `pedidos/whatsapp-cloud.js`
- Modify: `pedidos/whatsapp-cloud-ui.js`
- Test: frontend/browser focales.

**Steps:**
1. Escribir tests RED para autosize 1–6 líneas, contador, Enter newline, Ctrl/Cmd+Enter envío, IME y límite 4096.
2. Implementar textarea autosize, contador y validación accesible.
3. Mostrar empresa/destinatario protegido y estado de envío.
4. Bloquear cambios de contexto durante submit y preservar clave ante resultado incierto.
5. Agregar/actualizar optimistamente el mensaje por idempotency key sin duplicarlo.
6. Ejecutar pruebas y commit.

## Task 9: Gate integral de seguridad, calidad y release

**Objective:** Probar que la evolución es segura, consistente y desplegable.

**Files:** Todas las modificadas en tareas 1–8.

**Steps:**
1. Ejecutar suites focales con `/home/lemac/.nvm/versions/node/v22.22.0/bin/node`.
2. Ejecutar pruebas PostgreSQL reales y carreras controladas.
3. Ejecutar suite completa y browser tests.
4. Ejecutar `git diff --check`, revisión de secretos/PII y verificar que `pages/**` no cambió.
5. Verificar mecánicamente un solo `INSERT INTO wpp_outbox` productivo en `src/wpp/enqueue.js`.
6. Revisión independiente de cumplimiento de especificación.
7. Revisión independiente de calidad/seguridad/concurrencia.
8. Corregir toda severidad Critical/High/Medium y repetir ambos gates.
9. Integrar por fast-forward a `main`, publicar y desplegar web/worker sólo si el cambio lo requiere.
10. Verificar producción con sesión real: búsqueda, filtros, contexto, respuesta rápida editable, reply 202/200, refresh y mobile; restaurar `browser.use_real_profile=true`.
