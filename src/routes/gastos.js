// src/routes/gastos.js
import express from 'express';
import multer from 'multer';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createWriteStream, unlink } from 'node:fs';

import {
  withAuth as defaultWithAuth,
  checkLicencia as defaultCheckLicencia,
  isSuper as defaultIsSuper,
  isRepartidor as defaultIsRepartidor,
  getEmpresaIdFromToken as defaultGetEmpresaIdFromToken
} from '../services.js';
import { query, withTransaction as defaultWithTransaction } from '../db.js';
import { ensureRetornablesLedgerSchema, registrarRetornableMovimiento } from '../services/retornablesLedger.js';
import { lockStockContext } from '../services/stockLocking.js';

const GASTOS_MIME_EXTENSIONS = new Map([
  ['application/pdf', '.pdf'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/bmp', '.bmp'],
  ['image/tiff', '.tiff'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
]);

export function createExclusiveGastosStorage(destination, { randomId = randomUUID } = {}) {
  const storageDir = path.resolve(destination);
  return {
    _handleFile(_req, file, cb) {
      const extension = GASTOS_MIME_EXTENSIONS.get(file.mimetype);
      if (!extension) return cb(new Error('Tipo no permitido'));

      const filename = `gasto-${randomId()}${extension}`;
      const filePath = path.join(storageDir, filename);
      const output = createWriteStream(filePath, { flags: 'wx' });
      let opened = false;
      let settled = false;
      const finish = (error, info) => {
        if (settled) return;
        settled = true;
        cb(error, info);
      };

      output.once('open', () => { opened = true; });
      output.once('error', error => {
        file.stream.unpipe(output);
        output.destroy();
        if (!opened) return finish(error);
        return unlink(filePath, () => finish(error));
      });
      file.stream.once('error', error => output.destroy(error));
      output.once('finish', () => finish(null, {
        destination: storageDir,
        filename,
        path: filePath,
        size: output.bytesWritten,
      }));
      file.stream.pipe(output);
    },
    _removeFile(_req, file, cb) {
      if (!file?.path) return cb(null);
      return unlink(file.path, cb);
    },
  };
}

export function createGastosRouter({
  GASTOS_DIR,
  query: queryFn = query,
  withAuth: withAuthFn = defaultWithAuth,
  checkLicencia: checkLicenciaFn = defaultCheckLicencia,
  isSuper: isSuperFn = defaultIsSuper,
  isRepartidor: isRepartidorFn = defaultIsRepartidor,
  getEmpresaIdFromToken: getEmpresaIdFromTokenFn = defaultGetEmpresaIdFromToken,
  withTransaction: withTransactionFn = defaultWithTransaction,
} = {}) {
  if (!GASTOS_DIR) throw new Error('createGastosRouter requiere { GASTOS_DIR }');

  const router = express.Router();
  const dbQuery = queryFn;
  const authMiddleware = withAuthFn;
  const licenciaMiddleware = checkLicenciaFn;
  const resolvedGastosDir = path.resolve(GASTOS_DIR);

  function requireCanonicalGastosMutationRole(req, res, next) {
    const role = req.user?.role;
    if (role !== 'repartidor' && role !== 'admin' && role !== 'super') {
      return res.status(403).json({ error: 'No autorizado' });
    }
    if (role !== 'super') {
      const empresaId = req.user?.empresa_id;
      if (!Number.isSafeInteger(empresaId) || empresaId <= 0) {
        return res.status(403).json({ error: 'No autorizado' });
      }
    }
    if (role === 'repartidor') {
      const choferId = req.user?.chofer_id;
      if (!Number.isSafeInteger(choferId) || choferId <= 0) {
        return res.status(403).json({ error: 'No autorizado' });
      }
    }
    return next();
  }

  async function unlinkBestEffort(filePath, label) {
    if (!filePath) return;
    await new Promise(resolve => unlink(filePath, error => {
      if (error && error.code !== 'ENOENT') {
        console.warn(`No se pudo eliminar ${label}:`, error.message);
      }
      resolve();
    }));
  }

  async function cleanupUploadedFile(file) {
    if (!file?.path) return;
    const absolute = path.resolve(file.path);
    if (path.dirname(absolute) !== resolvedGastosDir) return;
    await unlinkBestEffort(absolute, 'comprobante temporal de gasto');
  }

  async function cleanupStoredFile(storedPath) {
    const filename = path.basename(String(storedPath || ''));
    if (!/^gasto-[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(filename)) return;
    await unlinkBestEffort(path.join(resolvedGastosDir, filename), 'comprobante reemplazado de gasto');
  }

  const ensureDepositoRefPromise = (async () => {
    try {
      await dbQuery(`ALTER TABLE chofer_stock_mov ADD COLUMN IF NOT EXISTS deposito_id INTEGER`);
      await dbQuery(`ALTER TABLE chofer_stock_mov ADD COLUMN IF NOT EXISTS gasto_id INTEGER`);
      await dbQuery(`ALTER TABLE gastos_repartidor ADD COLUMN IF NOT EXISTS deposito_id INTEGER`);
      await ensureRetornablesLedgerSchema(dbQuery);
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS deposito_chofer (
          id SERIAL PRIMARY KEY,
          empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
          deposito_id INTEGER NOT NULL REFERENCES depositos(id) ON DELETE CASCADE,
          chofer_id INTEGER NOT NULL REFERENCES choferes(id) ON DELETE CASCADE,
          activo BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (empresa_id, deposito_id, chofer_id)
        )
      `);
    } catch (e) {
      console.warn('gastos/deposito schema warning:', e?.message || e);
    }
  })();

  const isStockIngresoFromGasto = (row) => {
    const tipo = String(row?.tipo || '').toLowerCase();
    const qty = Number(row?.cantidad || 0);
    const pid = Number(row?.producto_id || 0);
    return (tipo === 'carga_llenos' || tipo === 'compra_mercaderia') && qty > 0 && pid > 0;
  };

  function requireExactlyOneAffectedRow(rows, operation) {
    if (!Array.isArray(rows) || rows.length !== 1) {
      const error = new Error(`${operation} de gasto no afectó exactamente una fila`);
      error.code = 'GASTO_WRITE_CONFLICT';
      throw error;
    }
    return rows[0];
  }

  function gastoConflict(message) {
    return Object.assign(new Error(message), { code: 'GASTO_WRITE_CONFLICT', statusCode: 409 });
  }

  function normalizeComparable(value) {
    if (value instanceof Date) return value.toISOString();
    return value == null ? null : String(value);
  }

  function toDateOnly(value) {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const text = String(value || '').trim();
    const isoPrefix = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (isoPrefix) return isoPrefix;
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return text.slice(0, 10);
  }

  function sameGastoSnapshot(left, right) {
    const fields = [
      'id', 'empresa_id', 'chofer_id', 'fecha', 'tipo', 'descripcion', 'monto',
      'comprobante_path', 'cantidad', 'producto_id', 'deposito_id',
    ];
    return fields.every(field => normalizeComparable(left?.[field]) === normalizeComparable(right?.[field]));
  }

  async function lockGastoStockContexts(txQuery, { gastoId, contexts }) {
    const grouped = new Map();
    for (const context of contexts) {
      if (!context || !isStockIngresoFromGasto(context)) continue;
      const empresaId = Number(context.empresa_id);
      const current = grouped.get(empresaId) || { choferIds: [], productoIds: [], depositoIds: [] };
      current.choferIds.push(context.chofer_id);
      current.productoIds.push(context.producto_id);
      if (context.deposito_id) current.depositoIds.push(context.deposito_id);
      grouped.set(empresaId, current);
    }
    for (const empresaId of [...grouped.keys()].sort((a, b) => a - b)) {
      await lockStockContext(txQuery, {
        empresaId,
        referencia: gastoId ? `gasto:${Number(gastoId)}` : null,
        ...grouped.get(empresaId),
      });
    }
  }

  async function validateChoferEmpresa({ empresaId, choferId, queryFn: validationQuery = dbQuery }) {
    const empId = Number(empresaId);
    const chId = Number(choferId);
    if (!Number.isFinite(empId) || empId <= 0 || !Number.isFinite(chId) || chId <= 0) {
      return false;
    }

    const rows = await validationQuery(
      `SELECT id
         FROM choferes
        WHERE id = $1
          AND empresa_id = $2
          AND activo IS TRUE
        FOR SHARE`,
      [chId, empId]
    );
    return rows.length > 0;
  }

  async function isDepositoPermisosEstricto(empresaId, validationQuery = dbQuery) {
    const rows = await validationQuery(
      `SELECT COALESCE((config_operativa->>'deposito_permisos_estricto')::boolean, FALSE) AS estricto
         FROM empresas
        WHERE id = $1
        FOR SHARE`,
      [Number(empresaId)]
    );
    return !!rows?.[0]?.estricto;
  }

  async function choferPuedeUsarDeposito({ empresaId, choferId, depositoId, queryFn: validationQuery = dbQuery }) {
    const empId = Number(empresaId);
    const chId = Number(choferId);
    const depId = Number(depositoId);
    if (!empId || !chId || !depId) return false;

    const depRows = await validationQuery(
      `SELECT id
         FROM depositos
        WHERE id = $1
          AND empresa_id = $2
          AND activo = TRUE
        FOR SHARE`,
      [depId, empId]
    );
    if (!depRows.length) return false;

    const cfgRows = await validationQuery(
      `SELECT deposito_id
         FROM deposito_chofer
        WHERE empresa_id = $1
          AND chofer_id = $2
          AND activo = TRUE
        ORDER BY deposito_id
        FOR SHARE`,
      [empId, chId]
    );
    if (cfgRows.length === 0) return false;
    return cfgRows.some(row => Number(row.deposito_id) === depId);
  }

  async function applyStockIngresoFromGasto(txQuery, { empresaId, choferId, productoId, depositoId, fecha, cantidad, descripcion, gastoId }) {
    const qtyNum = Number(cantidad || 0);
    if (!qtyNum || qtyNum <= 0) return;

    const stockRows = await txQuery(
      `
      INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (empresa_id, chofer_id, producto_id)
      DO UPDATE SET cantidad = chofer_stock.cantidad + EXCLUDED.cantidad
      RETURNING empresa_id, chofer_id, producto_id
      `,
      [Number(empresaId), Number(choferId), Number(productoId), qtyNum]
    );
    requireExactlyOneAffectedRow(stockRows, 'UPSERT stock');

    const movementRows = await txQuery(
      `
      INSERT INTO chofer_stock_mov
        (empresa_id, chofer_id, producto_id, deposito_id, gasto_id, fecha, tipo, cantidad, referencia, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'INGRESO_GASTOS', $7, $8, NOW())
      RETURNING id
      `,
      [
        Number(empresaId),
        Number(choferId),
        Number(productoId),
        (depositoId === undefined || depositoId === null || depositoId === '') ? null : Number(depositoId),
        Number(gastoId),
        fecha || new Date().toISOString(),
        qtyNum,
        `Carga desde Gastos: ${descripcion || 'carga_llenos'}`
      ]
    );
    requireExactlyOneAffectedRow(movementRows, 'INSERT stock_mov');
  }

  async function registrarLedgerRetornableDesdeGasto(txQuery, { empresaId, choferId, productoId, depositoId, fecha, cantidad, tipo, descripcion, gastoId, createdBy }) {
    const qtyNum = Number(cantidad || 0);
    const productoIdNum = Number(productoId || 0);
    const choferIdNum = Number(choferId || 0);
    if (!qtyNum || qtyNum <= 0 || !productoIdNum || !choferIdNum) return null;

    const tipoNorm = String(tipo || '').trim().toLowerCase();
    if (tipoNorm !== 'carga_llenos' && tipoNorm !== 'descarga_vacios') return null;

    const delta = tipoNorm === 'carga_llenos' ? qtyNum : -qtyNum;
    return registrarRetornableMovimiento(txQuery, {
      empresaId,
      sujetoTipo: 'chofer',
      sujetoId: choferIdNum,
      productoId: productoIdNum,
      contraparteTipo: depositoId ? 'deposito' : null,
      contraparteId: depositoId || null,
      choferId: choferIdNum,
      depositoId: depositoId || null,
      gastoId,
      fecha: fecha || new Date().toISOString(),
      tipo: tipoNorm === 'carga_llenos' ? 'carga_chofer' : 'descarga_vacios_chofer',
      origen: 'gastos',
      cantidadLlenos: tipoNorm === 'carga_llenos' ? qtyNum : 0,
      cantidadVacios: tipoNorm === 'descarga_vacios' ? qtyNum : 0,
      deltaSaldo: delta,
      referencia: gastoId ? `Gasto #${gastoId}` : null,
      observacion: descripcion || tipoNorm,
      createdBy,
    });
  }

  async function revertStockIngresoFromGasto(txQuery, {
    empresaId, choferId, productoId, depositoId, fecha, cantidad, descripcion, gastoId,
  }) {
    const qtyNum = Number(cantidad || 0);
    if (!qtyNum || qtyNum <= 0) return;
    const normalizedDepositoId = depositoId ? Number(depositoId) : null;

    let movementRows = await txQuery(
      `SELECT id, empresa_id, chofer_id, producto_id, deposito_id, gasto_id, fecha, tipo, cantidad, referencia
         FROM chofer_stock_mov
        WHERE gasto_id = $1
          AND empresa_id = $2
          AND tipo = 'INGRESO_GASTOS'
        ORDER BY id
        FOR UPDATE`,
      [Number(gastoId), Number(empresaId)]
    );

    if (movementRows.length === 0) {
      movementRows = await txQuery(
        `SELECT id, empresa_id, chofer_id, producto_id, deposito_id, gasto_id, fecha, tipo, cantidad, referencia
           FROM chofer_stock_mov
          WHERE gasto_id IS NULL
            AND empresa_id = $1
            AND chofer_id = $2
            AND producto_id = $3
            AND deposito_id IS NOT DISTINCT FROM $4::integer
            AND fecha::date = $5::date
            AND tipo = 'INGRESO_GASTOS'
            AND cantidad = $6
            AND referencia = $7
          ORDER BY id
          FOR UPDATE`,
        [
          Number(empresaId), Number(choferId), Number(productoId), normalizedDepositoId,
          fecha, qtyNum, `Carga desde Gastos: ${descripcion || 'carga_llenos'}`,
        ]
      );
    }

    if (movementRows.length !== 1) {
      throw gastoConflict('Movimiento de stock del gasto ausente o ambiguo');
    }
    const movement = movementRows[0];
    if (Number(movement.chofer_id) !== Number(choferId)
      || Number(movement.producto_id) !== Number(productoId)
      || Number(movement.cantidad) !== qtyNum
      || (movement.deposito_id == null ? null : Number(movement.deposito_id)) !== normalizedDepositoId) {
      throw gastoConflict('Movimiento de stock del gasto no coincide con el gasto');
    }

    if (normalizedDepositoId) {
      const saldoRows = await txQuery(
        `SELECT COALESCE(SUM(cantidad), 0) AS saldo
           FROM chofer_stock_mov
          WHERE empresa_id = $1
            AND producto_id = $2
            AND deposito_id = $3`,
        [Number(empresaId), Number(productoId), normalizedDepositoId]
      );
      if (Number(saldoRows?.[0]?.saldo || 0) < qtyNum) {
        throw gastoConflict('No se puede retirar el ingreso: el saldo del depósito quedaría negativo');
      }
    }

    const stockRows = await txQuery(
      `UPDATE chofer_stock
          SET cantidad = cantidad - $4
        WHERE empresa_id = $1
          AND chofer_id = $2
          AND producto_id = $3
          AND cantidad >= $4
        RETURNING empresa_id, chofer_id, producto_id`,
      [Number(empresaId), Number(choferId), Number(productoId), qtyNum]
    );
    requireExactlyOneAffectedRow(stockRows, 'UPDATE stock');

    const deletedRows = await txQuery(
      `DELETE FROM chofer_stock_mov
        WHERE id = $1
          AND empresa_id = $2
          AND gasto_id IS NOT DISTINCT FROM $3::integer
        RETURNING id`,
      [Number(movement.id), Number(empresaId), movement.gasto_id == null ? null : Number(gastoId)]
    );
    requireExactlyOneAffectedRow(deletedRows, 'DELETE stock_mov');
  }

  const gastosUploader = multer({
    storage: createExclusiveGastosStorage(GASTOS_DIR),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_, file, cb) => {
      const ok = GASTOS_MIME_EXTENSIONS.has(file.mimetype);
      cb(ok ? null : new Error('Tipo no permitido'), ok);
    }
  });

  // GET /api/gastos
  router.get('/', authMiddleware, licenciaMiddleware, async (req, res) => {
    try {
      await ensureDepositoRefPromise;
      const { from, to, chofer_id, empresa_id, deposito_id, limit } = req.query || {};
      const esSuperUser = isSuperFn(req);
      const esRepartidorUser = isRepartidorFn(req);
      const myEmpresa = getEmpresaIdFromTokenFn(req);

      let sql = `
        SELECT 
          g.*,
          c.nombre AS chofer_nombre,
          COALESCE(d.nombre, dmv.nombre) AS deposito_nombre
        FROM gastos_repartidor g
        LEFT JOIN choferes c ON g.chofer_id = c.id
        LEFT JOIN depositos d ON d.id = g.deposito_id
        LEFT JOIN LATERAL (
          SELECT m.deposito_id
          FROM chofer_stock_mov m
          WHERE m.empresa_id = g.empresa_id
            AND m.chofer_id = g.chofer_id
            AND m.tipo = 'INGRESO_GASTOS'
            AND m.fecha::date = g.fecha::date
            AND COALESCE(m.producto_id, 0) = COALESCE(g.producto_id, 0)
            AND COALESCE(m.cantidad, 0)::numeric = COALESCE(g.cantidad, 0)::numeric
            AND m.referencia = ('Carga desde Gastos: ' || COALESCE(g.descripcion, ''))
            AND m.deposito_id IS NOT NULL
          ORDER BY m.id DESC
          LIMIT 1
        ) md ON TRUE
        LEFT JOIN depositos dmv ON dmv.id = md.deposito_id
        WHERE 1=1
      `;

      const params = [];
      let idx = 1;

      if (!esSuperUser) {
        sql += ` AND g.empresa_id = $${idx++}`;
        params.push(myEmpresa);
      } else if (empresa_id) {
        sql += ` AND g.empresa_id = $${idx++}`;
        params.push(Number(empresa_id));
      }

      // Repartidor: siempre ve su propio historial (evita depender de chofer_id enviado por front)
      if (esRepartidorUser) {
        const myChoferId = Number(req.user?.chofer_id || 0);
        if (!myChoferId) {
          return res.status(400).json({ error: 'Usuario repartidor sin chofer_id asociado' });
        }
        sql += ` AND g.chofer_id = $${idx++}`;
        params.push(myChoferId);
      } else if (chofer_id) {
        sql += ` AND g.chofer_id = $${idx++}`;
        params.push(Number(chofer_id));
      }

      if (deposito_id) {
        sql += ` AND COALESCE(g.deposito_id, md.deposito_id) = $${idx++}`;
        params.push(Number(deposito_id));
      }

      if (from) {
        sql += ` AND g.fecha >= $${idx++}::date`;
        params.push(from.toString().slice(0, 10));
      }
      if (to) {
        sql += ` AND g.fecha <= $${idx++}::date`;
        params.push(to.toString().slice(0, 10));
      }

      const limitNum = Math.min(Math.max(Number(limit || 200) || 200, 1), 500);
      sql += ` ORDER BY g.fecha DESC, g.id DESC LIMIT $${idx++}`;
      params.push(limitNum);

      const rows = await dbQuery(sql, params);
      return res.json(rows);
    } catch (e) {
      console.error('Error cargando gastos:', e);
      return res.status(500).json({ error: 'Error cargando gastos' });
    }
  });

  // POST /api/gastos (multipart: comprobante)
  router.post('/', authMiddleware, requireCanonicalGastosMutationRole, licenciaMiddleware, gastosUploader.single('comprobante'), async (req, res) => {
    let uploadCommitted = false;
    try {
      await ensureDepositoRefPromise;
      const {
        fecha, tipo, descripcion, cantidad, producto_id, monto,
        empresa_id, chofer_id, deposito_id
      } = req.body;

      const file = req.file;
      const role = req.user.role;
      const bodyEmpresa = (empresa_id === undefined || empresa_id === null || empresa_id === '') ? null : Number(empresa_id);
      const bodyChofer = (chofer_id === undefined || chofer_id === null || chofer_id === '') ? null : Number(chofer_id);
      const targetEmpresa = role === 'super'
        ? (bodyEmpresa ?? Number(getEmpresaIdFromTokenFn(req)))
        : req.user.empresa_id;
      const targetChofer = role === 'repartidor' ? req.user.chofer_id : bodyChofer;

      if (!Number.isSafeInteger(Number(targetEmpresa)) || Number(targetEmpresa) <= 0
          || !Number.isSafeInteger(Number(targetChofer)) || Number(targetChofer) <= 0) {
        return res.status(400).json({ error: 'Faltan datos de empresa o chofer' });
      }
      if (role === 'repartidor' && bodyChofer !== null && bodyChofer !== req.user.chofer_id) {
        return res.status(403).json({ error: 'No podés registrar gastos para otro chofer' });
      }

      const tipoOp = String(tipo || '').trim();
      const esMovimientoRetornable = tipoOp === 'carga_llenos' || tipoOp === 'descarga_vacios';
      const cantidadNum = (cantidad === undefined || cantidad === null || cantidad === '') ? null : Number(cantidad);
      const productoIdNum = (producto_id === undefined || producto_id === null || producto_id === '') ? null : Number(producto_id);
      const depositoId = (deposito_id === undefined || deposito_id === null || deposito_id === '') ? null : Number(deposito_id);

      if (esMovimientoRetornable) {
        if (!productoIdNum || !Number.isFinite(productoIdNum) || productoIdNum <= 0) {
          return res.status(400).json({ error: 'Producto requerido para movimientos de retornables.' });
        }
        if (!cantidadNum || !Number.isFinite(cantidadNum) || cantidadNum <= 0) {
          return res.status(400).json({ error: 'Cantidad requerida para movimientos de retornables.' });
        }
      }

      const result = await withTransactionFn(async (txQuery) => {
        const stockContext = {
          empresa_id: Number(targetEmpresa),
          chofer_id: Number(targetChofer),
          producto_id: productoIdNum,
          deposito_id: depositoId,
          tipo: tipoOp,
          cantidad: cantidadNum,
        };
        await lockGastoStockContexts(txQuery, { contexts: [stockContext] });

        if (!(await validateChoferEmpresa({ empresaId: targetEmpresa, choferId: targetChofer, queryFn: txQuery }))) {
          return { status: 400, error: 'Chofer inválido para la empresa' };
        }

        if (productoIdNum) {
          const productRows = await txQuery(
            `SELECT id
               FROM productos
              WHERE id = $1
                AND empresa_id = $2
                AND deleted_at IS NULL
                AND ($3::boolean = FALSE OR COALESCE(retornable, false) = TRUE)
              FOR SHARE`,
            [productoIdNum, Number(targetEmpresa), esMovimientoRetornable]
          );
          if (!productRows.length) {
            return { status: 400, error: 'El producto no es retornable o no pertenece a la empresa.' };
          }
        }

        if (depositoId && (tipoOp === 'carga_llenos' || tipoOp === 'descarga_vacios' || tipoOp === 'compra_mercaderia')) {
          const permitido = await choferPuedeUsarDeposito({
            empresaId: targetEmpresa,
            choferId: targetChofer,
            depositoId,
            queryFn: txQuery,
          });
          if (!permitido) return { status: 403, error: 'Chofer no habilitado para ese depósito' };
        }

        const inserted = await txQuery(
          `
          INSERT INTO gastos_repartidor (
              empresa_id, chofer_id, fecha, tipo, descripcion,
              monto, comprobante_path, cantidad, producto_id, deposito_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id
          `,
          [
            Number(targetEmpresa),
            Number(targetChofer),
            fecha || new Date().toISOString(),
            tipo,
            descripcion,
            monto || 0,
            file ? file.filename : null,
            cantidadNum,
            productoIdNum,
            depositoId
          ]
        );
        const insertedRow = requireExactlyOneAffectedRow(inserted, 'INSERT');
        const insertedId = Number(insertedRow.id);
        if (!Number.isSafeInteger(insertedId) || insertedId <= 0) {
          throw new Error('INSERT de gasto devolvió un id inválido');
        }

        if (productoIdNum && cantidadNum && (tipoOp === 'carga_llenos' || tipoOp === 'compra_mercaderia')) {
          await applyStockIngresoFromGasto(txQuery, {
            empresaId: targetEmpresa,
            choferId: targetChofer,
            productoId: productoIdNum,
            depositoId,
            fecha: fecha || new Date().toISOString(),
            cantidad: cantidadNum,
            descripcion: descripcion || tipo,
            gastoId: insertedId
          });
        }

        if (esMovimientoRetornable) {
          await registrarLedgerRetornableDesdeGasto(txQuery, {
            empresaId: targetEmpresa,
            choferId: targetChofer,
            productoId: productoIdNum,
            depositoId,
            fecha: fecha || new Date().toISOString(),
            cantidad: cantidadNum,
            tipo: tipoOp,
            descripcion: descripcion || tipo,
            gastoId: insertedId,
            createdBy: req.user?.username || req.user?.id || null,
          });
        }
        return { ok: true, gastoId: insertedId };
      });
      if (!result?.ok) {
        return res.status(result?.status || 500).json({ error: result?.error || 'Error guardando gasto' });
      }
      uploadCommitted = Boolean(!req.file || result.gastoId);
      return res.json({ ok: true, id: result.gastoId });
    } catch (e) {
      console.error('ERROR POST GASTOS:', e);
      if (e?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
        uploadCommitted = Boolean(req.file);
        return res.status(503).json({ error: 'Resultado del gasto indeterminado', code: 'TRANSACTION_OUTCOME_UNKNOWN' });
      }
      return res.status(500).json({ error: 'Error guardando gasto' });
    } finally {
      if (req.file && !uploadCommitted) await cleanupUploadedFile(req.file);
    }
  });

  // PUT /api/gastos/:id (multipart: comprobante)
  router.put('/:id', authMiddleware, requireCanonicalGastosMutationRole, licenciaMiddleware, gastosUploader.single('comprobante'), async (req, res) => {
    let uploadCommitted = false;
    try {
      await ensureDepositoRefPromise;
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });

      const role = req.user.role;
      const esSuperUser = role === 'super';
      const esAdminUser = role === 'admin';
      const esRepartidorUser = role === 'repartidor';
      if (!(esSuperUser || esAdminUser || esRepartidorUser)) return res.status(403).json({ error: 'No autorizado' });

      const myEmpresa = Number(getEmpresaIdFromTokenFn(req));
      const myChoferId = esRepartidorUser ? Number(req.user?.chofer_id || 0) : null;
      if (esRepartidorUser && !myChoferId) {
        return res.status(400).json({ error: 'Usuario repartidor sin chofer_id asociado' });
      }

      const {
        fecha,
        tipo,
        descripcion,
        monto,
        empresa_id,
        chofer_id,
        cantidad,
        producto_id,
        deposito_id
      } = req.body || {};

      const result = await withTransactionFn(async (txQuery) => {
        const scopeParams = [id];
        let scopeSql = `
          SELECT id, empresa_id, chofer_id, fecha, tipo, descripcion, monto, comprobante_path, cantidad, producto_id, deposito_id
          FROM gastos_repartidor
          WHERE id = $1
        `;
        if (!esSuperUser) {
          scopeParams.push(myEmpresa);
          scopeSql += ` AND empresa_id = $${scopeParams.length}`;
        }
        if (esRepartidorUser) {
          scopeParams.push(myChoferId);
          scopeSql += ` AND chofer_id = $${scopeParams.length}`;
        }

        const snapshotRows = await txQuery(scopeSql, scopeParams);
        if (snapshotRows.length === 0) return { status: 404, error: 'Gasto no encontrado' };
        if (snapshotRows.length !== 1) throw gastoConflict('Lectura ambigua de gasto');
        const snapshot = snapshotRows[0];

        const targetEmpresa = (esSuperUser && empresa_id !== undefined && empresa_id !== null && empresa_id !== '')
          ? Number(empresa_id)
          : Number(snapshot.empresa_id);
        const targetChofer = esRepartidorUser
          ? myChoferId
          : ((chofer_id !== undefined && chofer_id !== null && chofer_id !== '') ? Number(chofer_id) : Number(snapshot.chofer_id));
        const fechaDate = fecha ? toDateOnly(fecha) : toDateOnly(snapshot.fecha);
        const newTipo = tipo || snapshot.tipo;
        const newDesc = descripcion !== undefined ? descripcion : snapshot.descripcion;
        const newMonto = (monto !== undefined && monto !== null && monto !== '') ? Number(monto) : Number(snapshot.monto || 0);
        const newCantidad = (cantidad === undefined || cantidad === null || cantidad === '') ? snapshot.cantidad : Number(cantidad);
        const newProductoId = (producto_id === undefined || producto_id === null || producto_id === '') ? snapshot.producto_id : Number(producto_id);
        const newDepositoId = (deposito_id === undefined || deposito_id === null || deposito_id === '') ? snapshot.deposito_id : Number(deposito_id);
        const newComprobantePath = req.file ? req.file.filename : snapshot.comprobante_path;
        const nextSnapshot = {
          empresa_id: targetEmpresa,
          chofer_id: targetChofer,
          tipo: newTipo,
          cantidad: newCantidad,
          producto_id: newProductoId,
          deposito_id: newDepositoId,
        };

        // Gasto y stock nunca se bloquean en orden inverso: primero namespaces stock,
        // luego la fila exacta del gasto, que se relee y compara con el snapshot.
        await lockGastoStockContexts(txQuery, { gastoId: id, contexts: [snapshot, nextSnapshot] });
        const lockedRows = await txQuery(`${scopeSql} FOR UPDATE`, scopeParams);
        if (lockedRows.length === 0) return { status: 404, error: 'Gasto no encontrado' };
        if (lockedRows.length !== 1 || !sameGastoSnapshot(snapshot, lockedRows[0])) {
          throw gastoConflict('El gasto cambió durante la operación');
        }
        const g0 = lockedRows[0];

        if (!(await validateChoferEmpresa({ empresaId: targetEmpresa, choferId: targetChofer, queryFn: txQuery }))) {
          return { status: 400, error: 'Chofer inválido para la empresa' };
        }

        const oldTipoNorm = String(g0.tipo || '').trim().toLowerCase();
        const oldEsRet = oldTipoNorm === 'carga_llenos' || oldTipoNorm === 'descarga_vacios';
        const newTipoNorm = String(newTipo || '').trim().toLowerCase();
        const newEsRet = newTipoNorm === 'carga_llenos' || newTipoNorm === 'descarga_vacios';

        if (newEsRet) {
          if (!newProductoId || !Number.isFinite(Number(newProductoId)) || Number(newProductoId) <= 0) {
            return { status: 400, error: 'Producto requerido para movimientos de retornables.' };
          }
          if (!newCantidad || !Number.isFinite(Number(newCantidad)) || Number(newCantidad) <= 0) {
            return { status: 400, error: 'Cantidad requerida para movimientos de retornables.' };
          }

          const productRows = await txQuery(
            `SELECT id
               FROM productos
              WHERE id = $1
                AND empresa_id = $2
                AND COALESCE(retornable, false) = true
                AND deleted_at IS NULL
              FOR SHARE`,
            [Number(newProductoId), targetEmpresa]
          );
          if (!productRows.length) {
            return { status: 400, error: 'El producto no es retornable o no pertenece a la empresa.' };
          }
        }

        if (newDepositoId && (newTipoNorm === 'carga_llenos' || newTipoNorm === 'descarga_vacios' || newTipoNorm === 'compra_mercaderia')) {
          const permitido = await choferPuedeUsarDeposito({
            empresaId: targetEmpresa,
            choferId: targetChofer,
            depositoId: newDepositoId,
            queryFn: txQuery,
          });
          if (!permitido) return { status: 403, error: 'Chofer no habilitado para ese depósito' };
        }

        if (isStockIngresoFromGasto(g0)) {
          await revertStockIngresoFromGasto(txQuery, {
            empresaId: g0.empresa_id,
            choferId: g0.chofer_id,
            productoId: g0.producto_id,
            depositoId: g0.deposito_id,
            fecha: g0.fecha,
            cantidad: g0.cantidad,
            descripcion: g0.descripcion,
            gastoId: id
          });
        }

        if (oldEsRet && g0.producto_id && Number(g0.cantidad || 0) > 0) {
          await registrarLedgerRetornableDesdeGasto(txQuery, {
            empresaId: g0.empresa_id,
            choferId: g0.chofer_id,
            productoId: g0.producto_id,
            depositoId: g0.deposito_id,
            fecha: g0.fecha,
            cantidad: Number(g0.cantidad || 0),
            tipo: oldTipoNorm === 'carga_llenos' ? 'descarga_vacios' : 'carga_llenos',
            descripcion: `Reversión por edición de gasto #${id}`,
            gastoId: id,
            createdBy: req.user?.username || req.user?.id || null,
          });
        }

        const updatedRows = await txQuery(
          `
          UPDATE gastos_repartidor
          SET empresa_id = $1,
              chofer_id = $2,
              fecha = $3::date,
              tipo = $4,
              descripcion = $5,
              monto = $6,
              comprobante_path = $7,
              cantidad = $8,
              producto_id = $9,
              deposito_id = $10
          WHERE id = $11
            AND empresa_id = $12
          RETURNING id
          `,
          [
            targetEmpresa,
            targetChofer,
            fechaDate,
            newTipo,
            newDesc,
            newMonto,
            newComprobantePath,
            newCantidad,
            newProductoId,
            newDepositoId,
            id,
            Number(g0.empresa_id)
          ]
        );
        requireExactlyOneAffectedRow(updatedRows, 'UPDATE');

        if (isStockIngresoFromGasto({ tipo: newTipoNorm, cantidad: newCantidad, producto_id: newProductoId })) {
          await applyStockIngresoFromGasto(txQuery, {
            empresaId: targetEmpresa,
            choferId: targetChofer,
            productoId: newProductoId,
            depositoId: newDepositoId,
            fecha: fechaDate,
            cantidad: newCantidad,
            descripcion: newDesc || newTipo,
            gastoId: id
          });
        }

        if (newEsRet && newProductoId && Number(newCantidad || 0) > 0) {
          await registrarLedgerRetornableDesdeGasto(txQuery, {
            empresaId: targetEmpresa,
            choferId: targetChofer,
            productoId: newProductoId,
            depositoId: newDepositoId,
            fecha: fechaDate,
            cantidad: newCantidad,
            tipo: newTipoNorm,
            descripcion: newDesc || newTipo,
            gastoId: id,
            createdBy: req.user?.username || req.user?.id || null,
          });
        }

        return { ok: true, previousComprobantePath: g0.comprobante_path };
      });

      if (!result?.ok) return res.status(result?.status || 500).json({ error: result?.error || 'Error actualizando gasto' });

      uploadCommitted = Boolean(req.file);
      if (req.file && result.previousComprobantePath && result.previousComprobantePath !== req.file.filename) {
        await cleanupStoredFile(result.previousComprobantePath);
      }
      return res.json({ ok: true });
    } catch (e) {
      console.error('ERROR PUT GASTOS:', e);
      if (e?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
        uploadCommitted = Boolean(req.file);
        return res.status(503).json({ error: 'Resultado del gasto indeterminado', code: 'TRANSACTION_OUTCOME_UNKNOWN' });
      }
      if (e?.statusCode) return res.status(e.statusCode).json({ error: e.message, code: e.code });
      return res.status(500).json({ error: 'Error actualizando gasto' });
    } finally {
      if (req.file && !uploadCommitted) await cleanupUploadedFile(req.file);
    }
  });

  // DELETE /api/gastos/:id
  router.delete('/:id', authMiddleware, requireCanonicalGastosMutationRole, licenciaMiddleware, async (req, res) => {
    try {
      await ensureDepositoRefPromise;
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });

      const role = req.user.role;
      const esSuperUser = role === 'super';
      const esAdminUser = role === 'admin';
      const esRepartidorUser = role === 'repartidor';
      if (!(esSuperUser || esAdminUser || esRepartidorUser)) return res.status(403).json({ error: 'No autorizado' });

      const myEmpresa = Number(getEmpresaIdFromTokenFn(req));
      const myChoferId = esRepartidorUser ? Number(req.user?.chofer_id || 0) : null;
      if (esRepartidorUser && !myChoferId) {
        return res.status(400).json({ error: 'Usuario repartidor sin chofer_id asociado' });
      }

      const result = await withTransactionFn(async (txQuery) => {
        const scopeParams = [id];
        let scopeSql = `
          SELECT id, empresa_id, chofer_id, fecha, tipo, descripcion, monto, cantidad, producto_id, deposito_id, comprobante_path
          FROM gastos_repartidor
          WHERE id = $1
        `;
        if (!esSuperUser) {
          scopeParams.push(myEmpresa);
          scopeSql += ` AND empresa_id = $${scopeParams.length}`;
        }
        if (esRepartidorUser) {
          scopeParams.push(myChoferId);
          scopeSql += ` AND chofer_id = $${scopeParams.length}`;
        }

        const snapshotRows = await txQuery(scopeSql, scopeParams);
        if (snapshotRows.length === 0) return { status: 404, error: 'Gasto no encontrado' };
        if (snapshotRows.length !== 1) throw gastoConflict('Lectura ambigua de gasto');
        const snapshot = snapshotRows[0];
        await lockGastoStockContexts(txQuery, { gastoId: id, contexts: [snapshot] });

        const lockedRows = await txQuery(`${scopeSql} FOR UPDATE`, scopeParams);
        if (lockedRows.length === 0) return { status: 404, error: 'Gasto no encontrado' };
        if (lockedRows.length !== 1 || !sameGastoSnapshot(snapshot, lockedRows[0])) {
          throw gastoConflict('El gasto cambió durante la operación');
        }
        const g0 = lockedRows[0];

        if (isStockIngresoFromGasto(g0)) {
          await revertStockIngresoFromGasto(txQuery, {
            empresaId: g0.empresa_id,
            choferId: g0.chofer_id,
            productoId: g0.producto_id,
            depositoId: g0.deposito_id,
            fecha: g0.fecha,
            cantidad: g0.cantidad,
            descripcion: g0.descripcion,
            gastoId: id
          });
        }

        const oldTipoNorm = String(g0.tipo || '').trim().toLowerCase();
        if ((oldTipoNorm === 'carga_llenos' || oldTipoNorm === 'descarga_vacios') && g0.producto_id && Number(g0.cantidad || 0) > 0) {
          await registrarLedgerRetornableDesdeGasto(txQuery, {
            empresaId: g0.empresa_id,
            choferId: g0.chofer_id,
            productoId: g0.producto_id,
            depositoId: g0.deposito_id,
            fecha: g0.fecha,
            cantidad: Number(g0.cantidad || 0),
            tipo: oldTipoNorm === 'carga_llenos' ? 'descarga_vacios' : 'carga_llenos',
            descripcion: `Reversión por borrado de gasto #${id}`,
            gastoId: id,
            createdBy: req.user?.username || req.user?.id || null,
          });
        }

        const deletedRows = await txQuery(
          `DELETE FROM gastos_repartidor
            WHERE id = $1
              AND empresa_id = $2
          RETURNING id`,
          [id, Number(g0.empresa_id)]
        );
        requireExactlyOneAffectedRow(deletedRows, 'DELETE');
        return { ok: true, previousComprobantePath: g0.comprobante_path };
      });

      if (!result?.ok) return res.status(result?.status || 500).json({ error: result?.error || 'Error borrando gasto' });
      await cleanupStoredFile(result.previousComprobantePath);
      return res.json({ ok: true });
    } catch (e) {
      console.error('ERROR DELETE GASTOS:', e);
      if (e?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
        return res.status(503).json({ error: 'Resultado del gasto indeterminado', code: 'TRANSACTION_OUTCOME_UNKNOWN' });
      }
      if (e?.statusCode) return res.status(e.statusCode).json({ error: e.message, code: e.code });
      return res.status(500).json({ error: 'Error borrando gasto' });
    }
  });

  return router;
}
