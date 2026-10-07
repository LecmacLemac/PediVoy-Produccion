export const POSTGRES_INT4_MAX = 2147483647;

export function backofficeMutationError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function parseCanonicalPositiveInt4(value, message = 'ID inválido') {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw backofficeMutationError(400, message);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > POSTGRES_INT4_MAX) {
    throw backofficeMutationError(400, message);
  }
  return parsed;
}

export function requireCanonicalActorUid(user) {
  const actorUid = user?.uid;
  if (!Number.isSafeInteger(actorUid) || actorUid <= 0 || actorUid > POSTGRES_INT4_MAX) {
    throw backofficeMutationError(403, 'Usuario autenticado inválido');
  }
  return actorUid;
}

export async function lockCanonicalBackofficeActor(txQuery, user, actorUid = requireCanonicalActorUid(user)) {
  const actorRows = await txQuery(
    `SELECT id, role, empresa_id, activo
       FROM usuarios
      WHERE id = $1
      FOR SHARE`,
    [actorUid]
  );
  if (actorRows.length !== 1) throw backofficeMutationError(403, 'Actor no autorizado');

  const actor = actorRows[0];
  const tokenRole = user?.role;
  const tokenEmpresa = user?.empresa_id;
  const actorRoleValid = actor.role === 'admin' || actor.role === 'super';
  const adminEmpresa = Number(actor.empresa_id);
  const adminScopeValid = actor.role !== 'admin'
    || (Number.isSafeInteger(adminEmpresa) && adminEmpresa > 0 && adminEmpresa <= POSTGRES_INT4_MAX
      && tokenRole === 'admin' && tokenEmpresa === adminEmpresa);
  const superScopeValid = actor.role !== 'super'
    || (actor.empresa_id === null && tokenRole === 'super' && tokenEmpresa == null);
  if (actor.activo !== true || !actorRoleValid || !adminScopeValid || !superScopeValid) {
    throw backofficeMutationError(403, 'Actor no autorizado');
  }

  return {
    actor,
    tenantEmpresa: actor.role === 'admin' ? adminEmpresa : null,
  };
}
