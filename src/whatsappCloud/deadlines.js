export const CLOUD_DEADLINES = Object.freeze({
  graph: Object.freeze({ default: 8_000, min: 100, max: 120_000 }),
  cancel: Object.freeze({ default: 100, min: 10, max: 5_000 }),
  poll: Object.freeze({ default: 1_000, min: 50, max: 60_000 }),
  lease: Object.freeze({ default: 120_000, min: 1_000, max: 900_000 }),
  drain: Object.freeze({ default: 10_000, min: 100, max: 120_000 }),
  shutdown: Object.freeze({ default: 10_000, min: 100, max: 300_000 }),
});

function parseStrictMilliseconds(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function normalizeCloudDeadline(name, value) {
  const policy = CLOUD_DEADLINES[name];
  if (!policy) throw new TypeError(`deadline Cloud desconocido: ${name}`);
  const parsed = parseStrictMilliseconds(value);
  if (parsed === null || parsed < policy.min || parsed > policy.max) return policy.default;
  return parsed;
}

export function unrefTimer(timer) {
  timer?.unref?.();
  return timer;
}
