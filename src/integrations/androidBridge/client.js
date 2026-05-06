import { getAndroidBridgeConfig, isAndroidBridgeConfigured } from './config.js';

export class AndroidBridgeClient {
  constructor(config = getAndroidBridgeConfig()) {
    this.config = config;
  }

  isEnabled() {
    return isAndroidBridgeConfigured(this.config);
  }

  async originateCall({ phone, sessionId, empresaId, campaignId, metadata = {} }) {
    if (!this.isEnabled()) {
      return { skipped: true, reason: 'ANDROID_BRIDGE no configurado' };
    }

    const response = await fetch(`${this.config.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.authToken ? { 'x-bridge-token': this.config.authToken } : {}),
      },
      body: JSON.stringify({
        phone,
        mode: this.config.mode,
        sessionId,
        empresaId,
        campaignId,
        metadata,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.error || `Android bridge call failed ${response.status}`);
    }

    return {
      provider: 'android_bridge',
      mode: this.config.mode,
      ...data,
    };
  }
}

export const androidBridgeClient = new AndroidBridgeClient();
