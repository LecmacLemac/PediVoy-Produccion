export const DELIVERY_POINT_ADDRESS_SQL = "LOWER(TRIM(COALESCE(direccion, '')))";
export const GENERAL_PHONE_LOCK_CLASS = 0x57505047;

export function normalizeGeneralPhoneIdentity(normalizePhoneFn, value) {
  const normalized = String(normalizePhoneFn(value || '') || '').replace(/\D+/g, '');
  return normalized.length > 10 ? normalized.slice(-10) : normalized;
}

export function normalizeDeliveryPointPhone(normalizePhoneFn, value) {
  const normalized = String(normalizePhoneFn(value || '') || '').replace(/\D+/g, '');
  return normalized.length > 7 ? normalized.slice(-7) : normalized;
}

export function normalizeDeliveryPointAddress(value) {
  return String(value || '').trim().toLowerCase();
}

export function deliveryPointIdentity({ normalizePhoneFn, telefono, direccion }) {
  const phone = normalizeDeliveryPointPhone(normalizePhoneFn, telefono);
  const generalPhone = normalizeGeneralPhoneIdentity(normalizePhoneFn, telefono);
  const address = normalizeDeliveryPointAddress(direccion);
  if (!phone || !generalPhone || !address) return null;
  return { phone, generalPhone, address, namespace: `point:${phone}:${address}` };
}

export function deliveryPointIdentityFromRow(normalizePhoneFn, row) {
  return deliveryPointIdentity({
    normalizePhoneFn,
    telefono: row?.telefono_normalizado || row?.telefono,
    direccion: row?.direccion,
  });
}

export async function lockDeliveryPointIdentity(queryFn, { empresaId, identity, globalPhoneLocked = false }) {
  if (!identity) return;
  if (!globalPhoneLocked) await lockGeneralPhoneIdentities(queryFn, { identities: [identity] });
  await queryFn(
    'SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))',
    [empresaId, identity.namespace]
  );
}

export async function lockDeliveryPointIdentities(queryFn, { empresaId, identities }) {
  const validIdentities = (identities || []).filter(Boolean);
  await lockGeneralPhoneIdentities(queryFn, { identities: validIdentities });
  const namespaces = [...new Set(validIdentities.map(identity => identity.namespace))].sort();
  for (const namespace of namespaces) {
    await queryFn(
      'SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))',
      [empresaId, namespace]
    );
  }
}

export async function lockGeneralPhoneIdentities(queryFn, { identities }) {
  const phones = [...new Set((identities || [])
    .filter(Boolean)
    .map(identity => identity.generalPhone)
    .filter(Boolean))].sort();
  for (const phone of phones) {
    await queryFn(
      'SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))',
      [GENERAL_PHONE_LOCK_CLASS, `whatsapp-general-phone:${phone}`]
    );
  }
}

export async function lockGeneralPhoneIdentity(queryFn, { normalizePhoneFn, telefono }) {
  const generalPhone = normalizeGeneralPhoneIdentity(normalizePhoneFn, telefono);
  if (!generalPhone) return null;
  await lockGeneralPhoneIdentities(queryFn, { identities: [{ generalPhone }] });
  return generalPhone;
}

export async function resolveTenantDeliveryPointByPhone(queryFn, {
  empresaId,
  telefono,
  normalizePhoneFn,
}) {
  const phone = normalizeGeneralPhoneIdentity(normalizePhoneFn, telefono);
  if (!phone) return { status: 'none', phone, point: null };
  const rows = await queryFn(
    `SELECT id, empresa_id
       FROM puntos_entrega
      WHERE empresa_id = $1
        AND RIGHT(REGEXP_REPLACE(COALESCE(telefono_normalizado, telefono, ''), '\\D', '', 'g'), LENGTH($2)) = $2
      ORDER BY id
      LIMIT 2`,
    [empresaId, phone]
  );
  if (!rows.length) return { status: 'none', phone, point: null };
  if (rows.length !== 1) return { status: 'ambiguous', phone, point: null };
  return { status: 'unique', phone, point: rows[0] };
}

export async function findDeliveryPointsByIdentity(queryFn, { empresaId, identity, excludeId = null }) {
  if (!identity) return [];
  return queryFn(
    `SELECT id, empresa_id, cliente, telefono, telefono_normalizado, direccion,
            ciudad, provincia, pais, notas, latitud, longitud, zona_id
       FROM puntos_entrega
      WHERE empresa_id = $1
        AND RIGHT(REGEXP_REPLACE(COALESCE(telefono_normalizado, telefono, ''), '\\D', '', 'g'), 7) = $2
        AND ${DELIVERY_POINT_ADDRESS_SQL} = $3
        AND ($4::int IS NULL OR id <> $4)
      ORDER BY id
      LIMIT 2`,
    [empresaId, identity.phone, identity.address, excludeId]
  );
}

export function sameDeliveryPointIdentity(left, right) {
  return Boolean(left && right && left.phone === right.phone && left.address === right.address);
}

export async function lockDeliveryPointRows(queryFn, { empresaId, rows, normalizePhoneFn }) {
  const initialRows = [...(rows || [])].sort((a, b) => Number(a.id) - Number(b.id));
  const identities = initialRows.map(row => deliveryPointIdentityFromRow(normalizePhoneFn, row));
  const lockIdentities = identities.map((identity, index) => identity || {
    namespace: `point-row:${Number(initialRows[index].id)}`,
  });
  await lockDeliveryPointIdentities(queryFn, { empresaId, identities: lockIdentities });
  if (!initialRows.length) return [];

  const ids = initialRows.map(row => Number(row.id));
  const lockedRows = await queryFn(
    `SELECT pe.id, pe.empresa_id,
            to_jsonb(pe)->>'telefono' AS telefono,
            to_jsonb(pe)->>'telefono_normalizado' AS telefono_normalizado,
            to_jsonb(pe)->>'direccion' AS direccion
       FROM puntos_entrega pe
      WHERE pe.empresa_id = $1 AND pe.id = ANY($2::int[])
      ORDER BY pe.id
      FOR UPDATE`,
    [empresaId, ids]
  );
  if (lockedRows.length !== initialRows.length) {
    throw deliveryPointConflict('El conjunto de puntos cambió durante la operación');
  }
  for (let index = 0; index < lockedRows.length; index += 1) {
    const before = identities[index];
    const after = deliveryPointIdentityFromRow(normalizePhoneFn, lockedRows[index]);
    if ((before || after) && !sameDeliveryPointIdentity(before, after)) {
      throw deliveryPointConflict('La identidad de un punto cambió durante la operación');
    }
  }
  return lockedRows;
}

export function deliveryPointConflict(message = 'Identidad de punto de entrega ambigua') {
  const error = new Error(message);
  error.code = 'DELIVERY_POINT_IDENTITY_CONFLICT';
  error.statusCode = 409;
  return error;
}
