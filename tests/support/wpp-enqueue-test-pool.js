export function createWppEnqueueTestPool({
  configIntegraciones = {},
  companyExists = true,
  recentRows = [],
  insertedRow = { id: 90, status: 'pending', transport_origin: null },
  onQuery = null,
} = {}) {
  const calls = [];
  let releases = 0;
  const pool = {
    calls,
    get releases() { return releases; },
    async connect() {
      return {
        async query(input, params = []) {
          const request = typeof input === 'string' ? { text: input, values: params } : input;
          calls.push(request);
          if (onQuery) {
            const overridden = await onQuery(request, calls);
            if (overridden !== undefined) return overridden;
          }
          const { text } = request;
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
          if (/pg_advisory_xact_lock/i.test(text)) return { rows: [] };
          if (/SELECT config_integraciones FROM empresas/i.test(text)) {
            return { rows: companyExists ? [{ config_integraciones: configIntegraciones }] : [] };
          }
          if (/FROM wpp_outbox/i.test(text) && !/INSERT INTO wpp_outbox/i.test(text)) return { rows: recentRows };
          if (/INSERT INTO wpp_outbox/i.test(text)) {
            return { rows: [{ ...insertedRow, transport_origin: insertedRow.transport_origin || request.values[3] }] };
          }
          throw new Error(`SQL inesperado: ${text}`);
        },
        release() { releases += 1; },
      };
    },
  };
  return pool;
}
