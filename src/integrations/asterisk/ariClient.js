import { getAsteriskConfig, isAsteriskConfigured } from './config.js';

function authHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function endpointFromTemplate(template, phone) {
  return String(template || '').replaceAll('{phone}', phone);
}

export class AsteriskAriClient {
  constructor(config = getAsteriskConfig()) {
    this.config = config;
  }

  isEnabled() {
    return isAsteriskConfigured(this.config);
  }

  async originateCall({ phone, sessionId, empresaId, campaignId, metadata = {} }) {
    if (!this.isEnabled()) {
      return { skipped: true, reason: 'ASTERISK no configurado' };
    }

    const endpoint = endpointFromTemplate(this.config.endpointTemplate, phone);
    const url = new URL(`${this.config.ariBaseUrl}/channels`);
    url.searchParams.set('endpoint', endpoint);
    url.searchParams.set('app', this.config.ariApp);
    url.searchParams.set('appArgs', `sessionId=${sessionId},empresaId=${empresaId},campaignId=${campaignId}`);
    url.searchParams.set('callerId', this.config.callerId);
    url.searchParams.set('timeout', '30000');
    url.searchParams.set('variables', [
      `SESSION_ID=${sessionId}`,
      `EMPRESA_ID=${empresaId}`,
      `CAMPAIGN_ID=${campaignId}`,
      `PHONE=${phone}`,
      `METADATA_JSON=${encodeURIComponent(JSON.stringify(metadata || {}))}`,
    ].join(','));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader(this.config.ariUsername, this.config.ariPassword),
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ARI originate failed ${response.status}: ${text}`);
    }

    return response.json();
  }
}

export const asteriskAriClient = new AsteriskAriClient();
