import net from 'node:net';
import {
  createCallEvent,
  findCallSessionByChannel,
  getCallSessionById,
  updateCallSession,
  updateContactResult,
} from '../../calls/repository.js';
import { getAsteriskConfig } from './config.js';

function parseMessage(raw) {
  const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
  const data = {};

  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();

    if (data[key] === undefined) data[key] = value;
    else if (Array.isArray(data[key])) data[key].push(value);
    else data[key] = [data[key], value];
  }

  return data;
}

function parseAmiVariables(message) {
  const values = Array.isArray(message.Variable)
    ? message.Variable
    : message.Variable
      ? [message.Variable]
      : [];

  return values.reduce((acc, item) => {
    const [key, ...rest] = String(item).split('=');
    if (!key) return acc;
    acc[key] = rest.join('=');
    return acc;
  }, {});
}

function mapEventType(message) {
  switch (message.Event) {
    case 'DialBegin': return 'ringing';
    case 'DialEnd': return message.DialStatus === 'ANSWER' ? 'answer' : 'dial_end';
    case 'BridgeEnter': return 'bridge_enter';
    case 'Hangup': return 'hangup';
    default: return null;
  }
}

async function resolveSession(message) {
  const vars = parseAmiVariables(message);
  const explicitSessionId = vars.SESSION_ID || message.SessionId || message.session_id;

  if (/^\d+$/.test(String(explicitSessionId || ''))) {
    const byId = await getCallSessionById(Number(explicitSessionId));
    if (byId) return byId;
  }

  const channelIds = [message.Uniqueid, message.Linkedid, message.DestUniqueid].filter(Boolean);
  for (const channelId of channelIds) {
    const found = await findCallSessionByChannel({ channelId });
    if (found) return found;
  }

  return null;
}

export class AsteriskAmiListener {
  constructor(config = getAsteriskConfig()) {
    this.config = config;
    this.socket = null;
    this.buffer = '';
    this.started = false;
    this.reconnectTimer = null;
  }

  start() {
    if (this.started || !this.config.enabled || !this.config.amiUsername || !this.config.amiPassword) return;
    this.started = true;
    this.connect();
  }

  connect() {
    this.socket = net.createConnection({ host: this.config.amiHost, port: this.config.amiPort }, () => {
      this.socket.write(`Action: Login\r\nUsername: ${this.config.amiUsername}\r\nSecret: ${this.config.amiPassword}\r\nEvents: on\r\n\r\n`);
    });

    this.socket.on('data', (chunk) => this.handleData(chunk.toString('utf8')));
    this.socket.on('error', (error) => {
      console.error('[asterisk:ami] error:', error.message);
    });
    this.socket.on('close', () => {
      this.socket = null;
      if (this.started) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.config.amiReconnectMs);
  }

  handleData(chunk) {
    this.buffer += chunk;
    let boundary = this.buffer.indexOf('\r\n\r\n');
    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 4);
      boundary = this.buffer.indexOf('\r\n\r\n');
      const message = parseMessage(raw);
      void this.processMessage(message);
    }
  }

  async processMessage(message) {
    if (!message?.Event) return;
    const eventType = mapEventType(message);
    if (!eventType) return;

    const session = await resolveSession(message);
    if (!session) return;

    const fields = {};
    if (message.Uniqueid) fields.asterisk_channel_id = message.Uniqueid;
    if (message.Linkedid) fields.asterisk_linkedid = message.Linkedid;
    if (eventType === 'answer') {
      fields.status = 'answered';
      fields.answered_at = new Date().toISOString();
    }
    if (eventType === 'ringing') fields.status = 'ringing';
    if (eventType === 'hangup') {
      fields.status = 'completed';
      fields.ended_at = new Date().toISOString();
      fields.hangup_cause = message.CauseTxt || message.Cause || null;
    }

    await updateCallSession({ sessionId: session.id, empresaId: session.empresa_id, fields });
    await createCallEvent({ callSessionId: session.id, eventType, payload: message });

    if (eventType === 'hangup') {
      await updateContactResult({
        contactId: session.campaign_contact_id,
        empresaId: session.empresa_id,
        status: 'done',
        finalDisposition: session.ai_disposition || 'completed',
        nextRetryAt: null,
      });
    }
  }
}

export const asteriskAmiListener = new AsteriskAmiListener();
