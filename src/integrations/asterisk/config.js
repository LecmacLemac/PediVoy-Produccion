export function getAsteriskConfig() {
  return {
    enabled: String(process.env.ASTERISK_ENABLED || '0') === '1',
    ariBaseUrl: String(process.env.ASTERISK_ARI_BASE_URL || 'http://127.0.0.1:8088/ari').replace(/\/$/, ''),
    ariUsername: String(process.env.ASTERISK_ARI_USERNAME || ''),
    ariPassword: String(process.env.ASTERISK_ARI_PASSWORD || ''),
    ariApp: String(process.env.ASTERISK_ARI_APP || 'pedivoy-call-app'),
    endpointTemplate: String(process.env.ASTERISK_ENDPOINT_TEMPLATE || 'PJSIP/{phone}@proveedor-trunk'),
    callerId: String(process.env.ASTERISK_CALLER_ID || 'PediVoy'),
    amiHost: String(process.env.ASTERISK_AMI_HOST || '127.0.0.1'),
    amiPort: Number(process.env.ASTERISK_AMI_PORT || 5038),
    amiUsername: String(process.env.ASTERISK_AMI_USERNAME || ''),
    amiPassword: String(process.env.ASTERISK_AMI_PASSWORD || ''),
    amiReconnectMs: Number(process.env.ASTERISK_AMI_RECONNECT_MS || 5000),
  };
}

export function isAsteriskConfigured(config = getAsteriskConfig()) {
  return Boolean(config.enabled && config.ariUsername && config.ariPassword);
}
