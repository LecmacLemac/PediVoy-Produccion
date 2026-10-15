// Deliberately closed tool surface; never accept tenant, URL or SQL overrides.
/**
 * Security inventory (all queries use context.query from service.execute's transaction):
 * mi_identidad / identity:read -> authenticated context only -> rol, empresa_id, scopes.
 * listar_catalogo / catalog:read -> productos + referentePortal /productos rule ->
 *   id,nombre,precio; selected empresa, active/nondeleted; public catalog flag except
 *   referentes, who require their own active referente_productos with current dates.
 * listar_pedidos / orders:read -> pedidos backoffice tenant rule ->
 *   id,estado,fecha,fecha_entrega,monto; selected empresa only, no customer contacts.
 * listar_entregas / deliveries:read -> repartidor tenant+assignment rule (stricter
 *   than general /pedidos) -> same five columns; chofer_id=current actor only.
 * listar_pedidos_disponibles / deliveries:read -> canonical /tomar availability ->
 *   id,estado ONLY; same empresa, NULL chofer, exact pendiente; no contact/amount data.
 * listar_pedidos_referidos / referrals:read -> referentePortal /pedidos interval ->
 *   same five order columns; own referente, same empresa, association start inclusive,
 *   unlink end exclusive at COALESCE(fecha,fecha_entrega,NOW()); EXISTS avoids duplicates.
 * resumen_facturacion / billing:read -> facturas read-only aggregation ->
 *   estado,cantidad,importe_total; selected empresa only; no schema/PDF/emission helper.
 * tomar_pedido / deliveries:claim -> takeVacantPedido (shared /tomar primitive) ->
 *   pedido_id,ok; pendiente+vacant under pedido UPDATE lock, active tenant driver
 *   under SHARE lock; only chofer_id changes, no physical/payment state changes.
 * reabrir_pedido_cancelado / orders:reopen -> createUpdatePedidoHandler ->
 *   pedido_id,estado; canonical actor lock, tenant+cancelado UPDATE lock beforehand,
 *   only estado:pendiente (plus selected empresa for super); all effects overridden.
 * All record lists: ascending ID cursor from returned authorized rows only, default
 * 50 / maximum 100; aggregate has at most 100 state groups. No SELECT *, inferred
 * endpoint access, free-form filters, tenant arguments, cross-tenant counters or URLs.
 * Mutations require operation_id UUID. The HTTP adapter binds idempotency to name
 * plus canonical args (excluding operation_id); replay/audit belongs to the service.
 */
export function agentToolError(statusCode, code, message = 'Operación no permitida') {
  return Object.assign(new Error(message), { statusCode, code });
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function validate(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
    throw agentToolError(400, 'INVALID_ARGUMENTS');
  }
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))
      || schema.required.some(key => !Object.hasOwn(args, key))) {
    throw agentToolError(400, 'INVALID_ARGUMENTS');
  }
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum)
        || rule.type === 'string' && (typeof value !== 'string' || !new RegExp(rule.pattern).test(value))) {
      throw agentToolError(400, 'INVALID_ARGUMENTS');
    }
  }
}

const int4 = (minimum = 1, maximum = 2147483647) => ({ type: 'integer', minimum, maximum });
const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const pageSchema = () => objectSchema({ limit: int4(1, 100), after_id: int4(0) });
const positiveId = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const rolesForScope = {
  'catalog:read': ['user', 'admin', 'super', 'referente'],
  'orders:read': ['user', 'admin', 'super'],
  'deliveries:read': ['repartidor'],
  'deliveries:claim': ['repartidor'],
  'referrals:read': ['referente'],
  'billing:read': ['user', 'facturacion', 'contable', 'admin', 'super'],
  'orders:reopen': ['admin', 'super'],
};
const orderColumns = ['id', 'estado', 'fecha', 'fecha_entrega', 'monto'];
const project = (row, columns) => Object.fromEntries(columns.map(key => [key, row[key]]));

export function createAgentTools(_deps = {}) {
  const definitions = [{
    name: 'mi_identidad', description: 'Rol y empresa de esta conexión, sin datos personales.',
    scope: 'identity:read', readOnly: true,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  }];
  const add = (name, description, scope, inputSchema = pageSchema(), readOnly = true) => {
    definitions.push({ name, description, scope, inputSchema, readOnly });
  };
  add('listar_catalogo', 'Catálogo de la empresa; referentes sólo productos de su portal vigente.', 'catalog:read');
  add('listar_pedidos', 'Pedidos de la empresa seleccionada, paginados por ID.', 'orders:read');
  add('listar_entregas', 'Sólo pedidos asignados a tu chofer actual.', 'deliveries:read');
  add('listar_pedidos_disponibles', 'Sólo IDs y estado de pedidos pendientes vacantes; tomar requiere deliveries:claim.', 'deliveries:read');
  add('listar_pedidos_referidos', 'Pedidos vinculados a tu referente dentro del intervalo de asociación.', 'referrals:read');
  add('resumen_facturacion', 'Resumen contable por estado; no emite facturas ni genera PDF.', 'billing:read', objectSchema());
  const mutationSchema = () => objectSchema({
    pedido_id: int4(),
    operation_id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' },
  }, ['pedido_id', 'operation_id']);
  add('tomar_pedido', 'Tomar un pedido pendiente vacante para tu chofer. operation_id UUID estable para reenvíos.', 'deliveries:claim', mutationSchema(), false);
  add('reabrir_pedido_cancelado', 'Reabrir únicamente Cancelado a Pendiente, sin notificaciones. operation_id UUID estable para reenvíos.', 'orders:reopen', mutationSchema(), false);
  const registry = freeze(definitions);
  const get = name => registry.find(tool => tool.name === name);
  const authorized = (tool, context) => {
    if (!context?.actor || !Array.isArray(context.scopes) || !context.scopes.includes(tool.scope)) return false;
    if (tool.scope === 'identity:read') return true;
    const actor = context.actor;
    if (!rolesForScope[tool.scope]?.includes(actor.role) || !positiveId(context.empresaId)) return false;
    if (actor.role !== 'super' && actor.empresa_id !== context.empresaId) return false;
    if (actor.role === 'repartidor' && !positiveId(actor.chofer_id)) return false;
    if (actor.role === 'referente' && !positiveId(actor.referente_id)) return false;
    return true;
  };
  const list = context => registry.filter(tool => authorized(tool, context));
  async function executeTool(name, args, context) {
    const tool = get(name);
    if (!tool) throw agentToolError(404, 'TOOL_NOT_FOUND');
    if (!authorized(tool, context)) throw agentToolError(403, 'FORBIDDEN');
    validate(tool.inputSchema, args);
    if (name === 'mi_identidad') {
      return { rol: context.actor.role, empresa_id: context.empresaId ?? null, scopes: [...context.scopes] };
    }
    const { query, actor, empresaId } = context;
    if (typeof query !== 'function') throw agentToolError(500, 'INTERNAL_ERROR');
    if (name === 'tomar_pedido') {
      const { takeVacantPedido } = await import('../routes/repartidorApi.js');
      const outcome = await takeVacantPedido(query, { pedidoId: args.pedido_id, empresaId, choferId: actor.chofer_id });
      if (outcome === 'invalid-driver') throw agentToolError(403, 'FORBIDDEN');
      if (outcome !== 'taken') throw agentToolError(404, 'ORDER_UNAVAILABLE');
      return { pedido_id: args.pedido_id, ok: true };
    }
    if (name === 'reabrir_pedido_cancelado') {
      const { lockCanonicalBackofficeActor } = await import('../routes/pedidoBackofficeMutation.js');
      // Preserve actor -> pedido lock order, and revalidate canonical actor in the handler too.
      await lockCanonicalBackofficeActor(query, actor);
      const rows = await query(`SELECT id FROM pedidos
        WHERE id = $1 AND empresa_id = $2 AND estado = 'cancelado' FOR UPDATE`, [args.pedido_id, empresaId]);
      if (!Array.isArray(rows) || rows.length !== 1) throw agentToolError(409, 'ORDER_NOT_CANCELLED');
      const { createUpdatePedidoHandler } = await import('../routes/pedidos.js');
      const noEffect = async () => {};
      const handler = (_deps.createUpdatePedidoHandlerFn || createUpdatePedidoHandler)({
        withTransactionFn: work => work(query),
        notifyEstadoFn: noEffect, notifyEnRutaFn: noEffect, awardPointsFn: noEffect,
        generateComisionesFn: noEffect, postEntregaFn: noEffect,
        // Sensitive DB context does not redact handler logs; never pass diagnostics here.
        logErrorFn: () => console.error('AGENT.PEDIDO.UPDATE.ERROR'),
      });
      let status = 200;
      let response;
      const res = { status(code) { status = code; return this; }, json(body) { response = body; return this; } };
      await handler({ user: actor, params: { id: String(args.pedido_id) },
        body: { estado: 'pendiente', ...(actor.role === 'super' ? { empresa_id: empresaId } : {}) },
      }, res);
      // A handler error must reject work so the outer credential/audit transaction rolls back.
      if (status >= 400 || response?.ok !== true) {
        if (response?.code === 'TRANSACTION_OUTCOME_UNKNOWN') throw agentToolError(503, 'TRANSACTION_OUTCOME_UNKNOWN');
        throw agentToolError(status >= 400 && status < 500 ? status : 500, 'DOMAIN_REJECTED');
      }
      return { pedido_id: args.pedido_id, estado: 'pendiente' };
    }
    const limit = args.limit ?? 50;
    const afterId = args.after_id ?? 0;
    let sql;
    let values;
    let columns = orderColumns;
    if (name === 'resumen_facturacion') {
      const rows = await query(`SELECT estado, COUNT(*)::text AS cantidad, SUM(importe_total)::text AS importe_total
        FROM facturas WHERE empresa_id = $1 GROUP BY estado ORDER BY estado LIMIT 100`, [empresaId]);
      if (!Array.isArray(rows)) throw agentToolError(500, 'INTERNAL_ERROR');
      return { rows: rows.slice(0, 100).map(row => project(row, ['estado', 'cantidad', 'importe_total'])) };
    }
    if (name === 'listar_catalogo') {
      columns = ['id', 'nombre', 'precio'];
      sql = `SELECT p.id, p.nombre, p.precio FROM productos p
        WHERE p.empresa_id = $1 AND p.id > $2 AND p.activo IS TRUE AND p.deleted_at IS NULL`;
      values = [empresaId, afterId, limit];
      if (actor.role === 'referente') {
        sql += ` AND EXISTS (SELECT 1 FROM referente_productos rp
          WHERE rp.empresa_id = p.empresa_id AND rp.producto_id = p.id AND rp.referente_id = $4
            AND rp.activo IS TRUE AND (rp.vigente_desde IS NULL OR rp.vigente_desde <= CURRENT_DATE)
            AND (rp.vigente_hasta IS NULL OR rp.vigente_hasta >= CURRENT_DATE))`;
        values.push(actor.referente_id);
      } else {
        sql += ' AND p.mostrar_en_catalogo IS TRUE';
      }
    } else {
      sql = `SELECT p.id, p.estado, p.fecha, p.fecha_entrega, p.monto FROM pedidos p
        WHERE p.empresa_id = $1 AND p.id > $2`;
      values = [empresaId, afterId, limit];
      if (name === 'listar_entregas') {
        sql += ' AND p.chofer_id = $4';
        values.push(actor.chofer_id);
      } else if (name === 'listar_pedidos_disponibles') {
        columns = ['id', 'estado'];
        sql = `SELECT p.id, p.estado FROM pedidos p WHERE p.empresa_id = $1 AND p.id > $2
          AND p.chofer_id IS NULL AND p.estado = 'pendiente'`;
      } else if (name === 'listar_pedidos_referidos') {
        sql += ` AND EXISTS (SELECT 1 FROM cliente_referentes cr
          WHERE cr.empresa_id = p.empresa_id AND cr.punto_entrega_id = p.punto_entrega_id
            AND cr.referente_id = $4 AND cr.estado IN ('activo', 'desvinculado')
            AND COALESCE(p.fecha, p.fecha_entrega, NOW()) >= COALESCE(cr.asociado_at, '-infinity'::timestamptz)
            AND (cr.desvinculado_at IS NULL OR COALESCE(p.fecha, p.fecha_entrega, NOW()) < cr.desvinculado_at))`;
        values.push(actor.referente_id);
      }
    }
    const rows = await query(`${sql} ORDER BY p.id ASC LIMIT $3`, values);
    if (!Array.isArray(rows)) throw agentToolError(500, 'INTERNAL_ERROR');
    const bounded = rows.slice(0, limit).map(row => project(row, columns));
    return { rows: bounded, next_cursor: bounded.length === limit ? bounded.at(-1).id : null };
  }
  async function call(name, args, context) {
    const result = await executeTool(name, args, context);
    const json = JSON.stringify(result);
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > 2 * 1024 * 1024) {
      throw agentToolError(500, 'RESULT_TOO_LARGE');
    }
    return result;
  }
  return Object.freeze({ registry, list, get, call });
}
