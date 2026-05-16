import {
  createCallEvent,
  createCallSession,
  findDispatchableContacts,
  markContactCalling,
  updateCallSession,
} from './repository.js';
import { asteriskAriClient } from '../integrations/asterisk/index.js';
import { androidBridgeClient } from '../integrations/androidBridge/index.js';

async function originateByProvider({ phone, sessionId, empresaId, campaignId, metadata }) {
  if (androidBridgeClient.isEnabled()) {
    return androidBridgeClient.originateCall({ phone, sessionId, empresaId, campaignId, metadata });
  }

  return asteriskAriClient.originateCall({ phone, sessionId, empresaId, campaignId, metadata });
}

export async function dispatchCalls({ empresaId, limit = 10 }) {
  const contacts = await findDispatchableContacts({ empresaId, limit });
  const sessions = [];

  for (const contact of contacts) {
    await markContactCalling({ contactId: contact.id, empresaId });
    const session = await createCallSession({
      campaignContactId: contact.id,
      empresaId,
      campaignId: contact.campaign_id,
      metadata: {
        phone: contact.phone,
        phone_normalized: contact.phone_normalized,
        contact_name: contact.name,
        campaign_name: contact.campaign_name,
        prompt_version: contact.prompt_version,
      },
    });

    await createCallEvent({
      callSessionId: session.id,
      eventType: 'dispatch_queued',
      payload: {
        phone: contact.phone,
        contactId: contact.id,
        campaignId: contact.campaign_id,
      },
    });

    try {
      const originateResult = await originateByProvider({
        phone: contact.phone,
        sessionId: session.id,
        empresaId,
        campaignId: contact.campaign_id,
        metadata: {
          contactId: contact.id,
          contactName: contact.name,
          promptVersion: contact.prompt_version,
        },
      });

      if (!originateResult?.skipped) {
        await updateCallSession({
          sessionId: session.id,
          empresaId,
          fields: {
            asterisk_channel_id: originateResult.id || originateResult.sessionId || null,
            status: 'initiated',
          },
        });
      }

      await createCallEvent({
        callSessionId: session.id,
        eventType: originateResult?.skipped ? 'originate_skipped' : 'originate_sent',
        payload: originateResult,
      });

      sessions.push({ ...session, originate: originateResult });
    } catch (error) {
      await updateCallSession({
        sessionId: session.id,
        empresaId,
        fields: {
          status: 'failed',
          hangup_cause: error.message,
          ended_at: new Date().toISOString(),
        },
      });
      await createCallEvent({
        callSessionId: session.id,
        eventType: 'originate_error',
        payload: { message: error.message },
      });
      sessions.push({ ...session, originate_error: error.message });
    }
  }

  return sessions;
}
