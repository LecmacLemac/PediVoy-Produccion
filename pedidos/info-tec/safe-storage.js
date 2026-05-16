(function attachSafeStorage(global) {
  if (global.safeStorage) return;

  const BLOCKED_KEY_RE = /(token|auth|jwt|bearer|secret|passwd|password|passphrase|cookie|sessionid|access[_-]?key|api[_-]?key|refresh)/i;

  function isAllowedKey(key, allowlist) {
    const normalized = String(key || '').trim();
    if (!normalized) return false;

    if (Array.isArray(allowlist) && allowlist.length > 0) {
      return allowlist.includes(normalized);
    }

    return !BLOCKED_KEY_RE.test(normalized);
  }

  function wrap(storage) {
    return {
      get(key, fallback = null, opts = {}) {
        try {
          if (!isAllowedKey(key, opts.allowlist)) return fallback;
          const value = storage.getItem(key);
          return value == null ? fallback : value;
        } catch {
          return fallback;
        }
      },
      set(key, value, opts = {}) {
        try {
          if (!isAllowedKey(key, opts.allowlist)) return false;
          storage.setItem(key, String(value));
          return true;
        } catch {
          return false;
        }
      },
      remove(key, opts = {}) {
        try {
          if (!isAllowedKey(key, opts.allowlist)) return false;
          storage.removeItem(key);
          return true;
        } catch {
          return false;
        }
      }
    };
  }

  global.safeStorage = {
    local: wrap(global.localStorage),
    session: wrap(global.sessionStorage)
  };
})(window);
