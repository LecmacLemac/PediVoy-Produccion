function tenantError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeSlug(value) {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase();
  return /^[a-z0-9_-]+$/.test(slug) ? slug : null;
}

function parseCanonicalEmpresaId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

async function resolveUnique(queryFn, sql, params) {
  const rows = await queryFn(sql, params);
  if (rows.length > 1) throw tenantError('PUBLIC_TENANT_AMBIGUOUS', 'Canal público de empresa ambiguo', 409);
  const id = Number(rows[0]?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function resolvePublicPedidoEmpresaId(req, queryFn) {
  if (typeof queryFn !== 'function') throw tenantError('PUBLIC_TENANT_UNRESOLVED', 'No se pudo resolver la empresa pública', 400);

  const candidates = [];
  if (req.query?.slug !== undefined) {
    const slug = normalizeSlug(req.query.slug);
    if (!slug) throw tenantError('PUBLIC_TENANT_UNRESOLVED', 'Slug público inválido', 400);
    candidates.push(['slug', await resolveUnique(
      queryFn,
      `SELECT id
         FROM empresas
        WHERE LOWER(TRIM(landing_slug)) = $1
          AND COALESCE(plan_estado, 'active') = 'active'
          AND (plan_vencimiento IS NULL OR plan_vencimiento >= NOW())
        ORDER BY id
        LIMIT 2`,
      [slug]
    )]);
  }

  if (req.query?.empresa_id !== undefined) {
    const id = parseCanonicalEmpresaId(req.query.empresa_id);
    if (id == null) throw tenantError('PUBLIC_TENANT_UNRESOLVED', 'Empresa pública inválida', 400);
    candidates.push(['empresa_id', await resolveUnique(
      queryFn,
      `SELECT id
         FROM empresas
        WHERE id = $1
          AND COALESCE(plan_estado, 'active') = 'active'
          AND (plan_vencimiento IS NULL OR plan_vencimiento >= NOW())
        ORDER BY id
        LIMIT 2`,
      [id]
    )]);
  }

  const resolved = candidates.filter(([, id]) => id != null);
  if (!resolved.length || candidates.some(([, id]) => id == null)) {
    throw tenantError('PUBLIC_TENANT_UNRESOLVED', 'No se pudo resolver la empresa pública', 400);
  }
  const resolvedId = resolved[0][1];
  if (resolved.some(([, id]) => id !== resolvedId)) {
    throw tenantError('PUBLIC_TENANT_CONFLICT', 'Los canales públicos de empresa no coinciden', 403);
  }

  if (req.method !== 'GET' && req.body?.empresa_id !== undefined && Number(req.body.empresa_id) !== resolvedId) {
    throw tenantError('PUBLIC_TENANT_CONFLICT', 'empresa_id no coincide con el canal público', 403);
  }
  return resolvedId;
}

export async function assertPublicPedidoEmpresaActive(queryFn, empresaId) {
  const rows = await queryFn(
    `SELECT id
       FROM empresas
      WHERE id = $1
        AND COALESCE(plan_estado, 'active') = 'active'
        AND (plan_vencimiento IS NULL OR plan_vencimiento >= NOW())
      FOR SHARE`,
    [empresaId]
  );
  if (rows.length !== 1 || Number(rows[0].id) !== Number(empresaId)) {
    throw tenantError('PUBLIC_TENANT_UNRESOLVED', 'No se pudo resolver la empresa pública', 400);
  }
  return Number(rows[0].id);
}
