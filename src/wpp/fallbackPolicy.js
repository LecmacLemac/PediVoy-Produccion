export const EMPRESA_WPP_FALLBACK_STALE_MINUTES = 15;

export function buildEmpresaWppFallbackCondition({ staleMinutes = EMPRESA_WPP_FALLBACK_STALE_MINUTES } = {}) {
  const minutes = Number(staleMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('staleMinutes inválido');
  }

  return `
          AND (
            e.id IS NULL
            OR COALESCE(e.wpp_status, 'disconnected') IN ('disconnected', 'error')
            OR (
              COALESCE(e.wpp_status, 'disconnected') = 'connected'
              AND COALESCE(e.wpp_heartbeat_at, TO_TIMESTAMP(0)) < NOW() - INTERVAL '${minutes} minutes'
            )
            OR (
              COALESCE(e.wpp_status, 'disconnected') IN ('initializing', 'resetting', 'awaiting_scan')
              AND COALESCE(e.wpp_heartbeat_at, e.updated_at, o.created_at) < NOW() - INTERVAL '${minutes} minutes'
            )
          )`;
}
