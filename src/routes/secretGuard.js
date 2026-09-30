import { timingSafeEqual } from 'node:crypto';

export function compareCanonicalSecret(expectedValue, providedValue) {
  const expected = typeof expectedValue === 'string' ? expectedValue.trim() : '';
  if (!expected) return { ok: false, configurationMissing: true };

  const provided = typeof providedValue === 'string' ? providedValue : '';
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  if (expectedBytes.length !== providedBytes.length) return { ok: false, configurationMissing: false };
  return { ok: timingSafeEqual(expectedBytes, providedBytes), configurationMissing: false };
}

export function requireSharedSecret({ expected, provided, res, missingStatus = 503, invalidStatus = 403 }) {
  const result = compareCanonicalSecret(expected, provided);
  if (result.configurationMissing) {
    res.status(missingStatus).json({ error: 'credential_not_configured' });
    return false;
  }
  if (!result.ok) {
    res.status(invalidStatus).json({ error: 'invalid_credential' });
    return false;
  }
  return true;
}
