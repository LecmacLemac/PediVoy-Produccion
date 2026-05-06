export function getAndroidBridgeConfig() {
  return {
    provider: String(process.env.CALL_PROVIDER || 'asterisk').trim().toLowerCase(),
    baseUrl: String(process.env.ANDROID_BRIDGE_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, ''),
    authToken: String(process.env.ANDROID_BRIDGE_TOKEN || ''),
    mode: String(process.env.ANDROID_BRIDGE_MODE || 'helper').trim().toLowerCase(),
  };
}

export function isAndroidBridgeConfigured(config = getAndroidBridgeConfig()) {
  return config.provider === 'android_bridge' && Boolean(config.baseUrl);
}
