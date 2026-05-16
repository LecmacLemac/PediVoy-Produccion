import express from 'express';
import {
  createCampaign,
  getCampaignById,
  importCampaignContacts,
  listCampaignContacts,
  listCampaigns,
  updateCampaignStatus,
} from '../calls/repository.js';

export function createCallCampaignsRouter(deps) {
  const { withAuth, resolveEmpresaId } = deps;
  const router = express.Router();

  router.get('/', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaId(req);
      const rows = await listCampaigns({ empresaId });
      res.json(rows);
    } catch (error) {
      console.error('call campaigns list error:', error);
      res.status(500).json({ error: 'Error obteniendo campañas de llamadas' });
    }
  });

  router.post('/', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaId(req);
      const { name, purpose, prompt_version, max_attempts, allowed_start_time, allowed_end_time, metadata } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name requerido' });

      const campaign = await createCampaign({
        empresaId,
        createdBy: req.user?.id || null,
        name,
        purpose,
        promptVersion: prompt_version,
        maxAttempts: max_attempts,
        allowedStartTime: allowed_start_time,
        allowedEndTime: allowed_end_time,
        metadata,
      });

      res.status(201).json({ ok: true, campaign });
    } catch (error) {
      console.error('call campaigns create error:', error);
      res.status(500).json({ error: 'Error creando campaña de llamadas' });
    }
  });

  router.get('/:id', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaId(req);
      const campaign = await getCampaignById({ id: Number(req.params.id), empresaId });
      if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });
      res.json(campaign);
    } catch (error) {
      console.error('call campaign get error:', error);
      res.status(500).json({ error: 'Error obteniendo campaña' });
    }
  });

  router.post('/:id/start', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaId(req);
      const campaign = await updateCampaignStatus({ id: Number(req.params.id), empresaId, status: 'active' });
      if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });
      res.json({ ok: true, campaign });
    } catch (error) {
      console.error('call campaign start error:', error);
      res.status(500).json({ error: 'Error iniciando campaña' });
    }
  });

  router.post('/:id/pause', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaId(req);
      const campaign = await updateCampaignStatus({ id: Number(req.params.id), empresaId, status: 'paused' });
      if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });
      res.json({ ok: true, campaign });
    } catch (error) {
      console.error('call campaign pause error:', error);
      res.status(500).json({ error: 'Error pausando campaña' });
    }
  });

  router.post('/:id/contacts/import', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaId(req);
      const campaignId = Number(req.params.id);
      const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
      if (!contacts.length) return res.status(400).json({ error: 'contacts requerido' });

      const campaign = await getCampaignById({ id: campaignId, empresaId });
      if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });

      const inserted = await importCampaignContacts({ campaignId, empresaId, contacts });
      res.json({ ok: true, imported: inserted.length, contacts: inserted });
    } catch (error) {
      console.error('call campaign import contacts error:', error);
      res.status(500).json({ error: 'Error importando contactos' });
    }
  });

  router.get('/:id/contacts', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaId(req);
      const campaignId = Number(req.params.id);
      const rows = await listCampaignContacts({ campaignId, empresaId });
      res.json(rows);
    } catch (error) {
      console.error('call campaign contacts list error:', error);
      res.status(500).json({ error: 'Error obteniendo contactos de campaña' });
    }
  });

  return router;
}
