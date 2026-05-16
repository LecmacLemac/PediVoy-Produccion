export function getConfig() {
  return {
    port: Number(process.env.ANDROID_BRIDGE_PORT || 8787),
    authToken: String(process.env.ANDROID_BRIDGE_TOKEN || ''),
    adbPath: String(process.env.ADB_PATH || 'adb'),
    serial: String(process.env.ANDROID_SERIAL || ''),
    defaultCountryPrefix: String(process.env.ANDROID_DEFAULT_COUNTRY_PREFIX || '+54'),
    mode: String(process.env.ANDROID_BRIDGE_MODE || 'helper').trim().toLowerCase(),
  };
}
