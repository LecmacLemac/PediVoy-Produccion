// src/routes/tracking.js
import express from 'express';
import { withAuth } from '../services.js';
import { query } from '../db.js';

export function createTrackingRouter() {
  const router = express.Router();

  // POST /api/track/update
  router.post('/update', withAuth, async (req, res) => {
    try {
      const { pedido_id, lat, lng } = req.body;
      const choferId = req.user?.chofer_id;
      const empresaId = req.user?.empresa_id;

      if (!choferId) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      const pid = Number(pedido_id);
      const latN = Number(lat);
      const lngN = Number(lng);

      if (!Number.isFinite(pid) || !Number.isFinite(latN) || !Number.isFinite(lngN)) {
        return res.status(400).json({ error: 'Datos inválidos' });
      }

      const pedRows = await query(
        `
        SELECT empresa_id, chofer_id
        FROM pedidos
        WHERE id = $1
          AND empresa_id = $2
        LIMIT 1
        `,
        [pid, empresaId]
      );

      if (!pedRows.length) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }

      const ped = pedRows[0];
      if (ped.chofer_id !== choferId) {
        return res.status(403).json({ error: 'No puedes actualizar este pedido' });
      }

      await query(
        `
        INSERT INTO pedido_track_points (pedido_id, latitud, longitud, timestamp, source, precision, speed, heading)
        VALUES ($1, $2, $3, NOW(), 'gps', 0, 0, 0)
        `,
        [pid, latN, lngN]
      );

      res.json({ ok: true });
    } catch (e) {
      console.error('TRACK UPDATE ERROR:', e);
      res.status(500).json({ error: 'Error guardando ubicación' });
    }
  });

  return router;
}
