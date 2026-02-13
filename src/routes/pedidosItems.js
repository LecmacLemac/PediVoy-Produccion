// src/routes/pedidosItems.js
import express from 'express';
import { withAuth, isSuper, getEmpresaIdFromToken } from '../services.js';
import { query, pool } from '../db.js';

export function createPedidosItemsRouter() {
  const router = express.Router();

  // PUT /api/pedidos/:id/items
  router.put('/:id/items', withAuth, async (req, res) => {
    const pedidoId = req.params.id;
    const { items: nuevosItems } = req.body;
    const empresaId = getEmpresaIdFromToken(req);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const pedData = await client.query(
        'SELECT chofer_id, estado, empresa_id FROM pedidos WHERE id = $1 AND empresa_id = $2',
        [pedidoId, empresaId]
      );

      if (pedData.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }

      const { chofer_id, estado } = pedData.rows[0];
      const stockYaDescontado = (estado === 'entregado');

      if (chofer_id && stockYaDescontado) {
        const itemsViejos = await client.query(
          'SELECT producto, cantidad FROM items_pedido WHERE pedido_id = $1',
          [pedidoId]
        );

        for (const oldIt of itemsViejos.rows) {
          const prod = await client.query(
            'SELECT id FROM productos WHERE nombre = $1 AND empresa_id = $2',
            [oldIt.producto, empresaId]
          );

          if (prod.rows.length > 0) {
            const prodId = prod.rows[0].id;

            await client.query(
              `
              INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (empresa_id, chofer_id, producto_id)
              DO UPDATE SET cantidad = chofer_stock.cantidad + EXCLUDED.cantidad
              `,
              [empresaId, chofer_id, prodId, Number(oldIt.cantidad)]
            );

            await client.query(
              `
              INSERT INTO chofer_stock_mov (empresa_id, chofer_id, producto_id, cantidad, tipo, motivo, referencia)
              VALUES ($1, $2, $3, $4, 'DEVOLUCION', 'Corrección items pedido (Restauración)', $5)
              `,
              [empresaId, chofer_id, prodId, Number(oldIt.cantidad), `Edit Pedido #${pedidoId}`]
            );
          }
        }
      }

      await client.query('DELETE FROM items_pedido WHERE pedido_id=$1', [pedidoId]);

      if (Array.isArray(nuevosItems)) {
        for (const it of nuevosItems) {
          await client.query(
            'INSERT INTO items_pedido (pedido_id, producto, cantidad, precio_unitario) VALUES ($1, $2, $3, $4)',
            [pedidoId, it.producto, Number(it.cantidad), Number(it.precio_unitario)]
          );

          if (chofer_id && stockYaDescontado) {
            const prod = await client.query(
              'SELECT id FROM productos WHERE nombre = $1 AND empresa_id = $2',
              [it.producto, empresaId]
            );

            if (prod.rows.length > 0) {
              const prodId = prod.rows[0].id;
              const cantidadDescontar = Number(it.cantidad);

              await client.query(
                `
                UPDATE chofer_stock
                SET cantidad = cantidad - $1
                WHERE empresa_id = $2 AND chofer_id = $3 AND producto_id = $4
                `,
                [cantidadDescontar, empresaId, chofer_id, prodId]
              );

              await client.query(
                `
                INSERT INTO chofer_stock_mov (empresa_id, chofer_id, producto_id, cantidad, tipo, motivo, referencia)
                VALUES ($1, $2, $3, $4, 'venta', 'Corrección items pedido (Nueva salida)', $5)
                `,
                [empresaId, chofer_id, prodId, -cantidadDescontar, `Edit Pedido #${pedidoId}`]
              );
            }
          }
        }
      }

      await client.query(
        `
        UPDATE pedidos
        SET monto = (
          SELECT COALESCE(SUM(cantidad*precio_unitario),0)
          FROM items_pedido
          WHERE pedido_id=$1
        )
        WHERE id=$1 AND empresa_id=$2
        `,
        [pedidoId, empresaId]
      );

      await client.query('COMMIT');
      client.release();
      return res.json({ ok: true });

    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
      console.error('Error editando ítems y stock:', e);
      return res.status(500).json({ error: 'Error procesando cambios y stock' });
    }
  });

  // GET /api/pedidos/:id/items
  router.get('/:id/items', withAuth, async (req, res) => {
    try {
      const pedidoId = Number(req.params.id);
      if (!Number.isInteger(pedidoId)) {
        return res.status(400).json({ error: 'ID de pedido inválido' });
      }

      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const ped = await query(
        'SELECT empresa_id FROM pedidos WHERE id=$1 AND ($2::int IS NULL OR empresa_id=$2) LIMIT 1',
        [pedidoId, esSuperUser ? null : Number(myEmpresa)]
      );
      if (!ped.length) return res.status(404).json({ error: 'Pedido no encontrado' });

      const items = await query(
        `SELECT id, producto, cantidad, precio_unitario
           FROM items_pedido
          WHERE pedido_id=$1
          ORDER BY id`,
        [pedidoId]
      );

      return res.json(items);
    } catch (e) {
      console.error('ERROR GET ITEMS PEDIDO:', e);
      return res.status(500).json({ error: 'Error cargando ítems' });
    }
  });

  return router;
}
