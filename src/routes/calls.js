import express from 'express';
import { dispatchCalls } from '../calls/dispatcherService.js';
import {
  createCallEvent,
  createCallTask,
  getCallSession,
  updateCallSession,
  updateContactResult,
} from '../calls/repository.js';
import { asteriskAriClient } from '../integrations/asterisk/index.js';
import { requireCanonicalBackofficeRole } from './canonicalBackofficeRole.js';
import { requireSharedSecret } from './secretGuard.js';

function ensureAsteriskSecret(req, res, next) {
  if (!requireSharedSecret({
    expected: process.env.ASTERISK_WEBHOOK_SECRET,
    provided: req.headers['x-asterisk-secret'],
    res,
    invalidStatus: 401,
  })) return;
  return next();
}

export function createCallsRouter(deps) {
  const {
    withAuth,
    resolveEmpresaId,
    createCallEvent: createCallEventFn = createCallEvent,
    createCallTask: createCallTaskFn = createCallTask,
    getCallSession: getCallSessionFn = getCallSession,
    updateCallSession: updateCallSessionFn = updateCallSession,
    updateContactResult: updateContactResultFn = updateContactResult,
  } = deps;
  const router = express.Router();

  router.post('/call-dispatch/run', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      const empresaId = resolveEmpresaId(req);
      const limit = Number(req.body?.limit || req.query?.limit || 10);
      const sessions = await dispatchCalls({ empresaId, limit });
      res.json({ ok: true, queued: sessions.length, sessions });
    } catch (error) {
      console.error('call dispatch error:', error);
      res.status(500).json({ error: 'Error ejecutando dispatcher de llamadas' });
    }
  });

  router.post('/asterisk/events', ensureAsteriskSecret, async (req, res) => {
    try {
      const { session_id, event_type, payload, status, final_disposition, next_retry_at, empresa_id } = req.body || {};
      if (!session_id || !event_type || !empresa_id) {
        return res.status(400).json({ error: 'session_id, event_type y empresa_id requeridos' });
      }

      const session = await updateCallSessionFn({
        sessionId: Number(session_id),
        empresaId: Number(empresa_id),
        fields: {
          status: status || undefined,
          answered_at: event_type === 'answer' ? new Date().toISOString() : undefined,
          ended_at: event_type === 'hangup' ? new Date().toISOString() : undefined,
        },
      });

      if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

      await createCallEventFn({
        callSessionId: session.id,
        eventType: event_type,
        payload: payload || req.body,
      });

      if (status || final_disposition || next_retry_at) {
        await updateContactResultFn({
          contactId: session.campaign_contact_id,
          empresaId: session.empresa_id,
          status: status === 'failed' ? 'retry' : status === 'completed' ? 'done' : undefined,
          finalDisposition: final_disposition,
          nextRetryAt: next_retry_at || null,
        });
      }

      res.json({ ok: true });
    } catch (error) {
      console.error('asterisk event error: procesamiento fallido');
      res.status(500).json({ error: 'Error procesando evento Asterisk' });
    }
  });

  router.get('/calls/:sessionId', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaId(req);
      const session = await getCallSessionFn({ sessionId: Number(req.params.sessionId), empresaId });
      if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
      res.json(session);
    } catch (error) {
      console.error('get call session error:', error);
      res.status(500).json({ error: 'Error obteniendo sesión' });
    }
  });

  router.post('/calls/:sessionId/ai-result', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      const empresaId = resolveEmpresaId(req);
      const sessionId = Number(req.params.sessionId);
      const session = await getCallSessionFn({ sessionId, empresaId });
      if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

      const { disposition, confidence, summary, transcript_text, callback_at, transfer_to_human } = req.body || {};
      const updated = await updateCallSessionFn({
        sessionId,
        empresaId,
        fields: {
          ai_disposition: disposition || null,
          ai_confidence: confidence ?? null,
          ai_summary: summary || null,
          transcript_text: transcript_text || null,
          transferred_to_human: Boolean(transfer_to_human),
          status: transfer_to_human ? 'transferred' : 'completed',
          ended_at: transfer_to_human ? undefined : new Date().toISOString(),
        },
      });

      await createCallEventFn({
        callSessionId: sessionId,
        eventType: 'ai_result',
        payload: req.body || {},
      });

      await updateContactResultFn({
        contactId: session.campaign_contact_id,
        empresaId,
        status: disposition === 'callback' ? 'retry' : 'done',
        finalDisposition: disposition || null,
        nextRetryAt: callback_at || null,
      });

      if (disposition === 'callback' && callback_at) {
        await createCallTaskFn({
          callSessionId: sessionId,
          taskType: 'callback',
          dueAt: callback_at,
          notes: summary || 'Callback generado por IA',
        });
      }

      res.json({ ok: true, session: updated });
    } catch (error) {
      console.error('save ai result error:', error);
      res.status(500).json({ error: 'Error guardando resultado IA' });
    }
  });

  router.post('/calls/:sessionId/transfer-human', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      const empresaId = resolveEmpresaId(req);
      const sessionId = Number(req.params.sessionId);
      const session = await getCallSessionFn({ sessionId, empresaId });
      if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

      const queue = String(req.body?.queue || 'ventas');
      const updated = await updateCallSessionFn({
        sessionId,
        empresaId,
        fields: {
          transferred_to_human: true,
          status: 'transferred',
        },
      });

      let ariResult = { skipped: true, reason: 'ASTERISK transfer endpoint pendiente de dialplan/bridge' };
      if (asteriskAriClient.isEnabled()) {
        ariResult = {
          skipped: true,
          reason: 'ARI conectado; falta implementar bridge/redirect específico de la cola humana en el dialplan',
        };
      }

      await createCallEventFn({
        callSessionId: sessionId,
        eventType: 'transfer_human_requested',
        payload: { queue, requested_by: req.user?.id || null, ariResult },
      });

      res.json({ ok: true, queue, session: updated, asterisk: ariResult });
    } catch (error) {
      console.error('transfer human error:', error);
      res.status(500).json({ error: 'Error solicitando transferencia humana' });
    }
  });

  return router;
}
