import webpush from 'web-push'
import {
  query,
  geocodeIfNeeded,
  withAuth as defaultWithAuth,
  resolveEmpresaId as defaultResolveEmpresaId,
  isSuper as defaultIsSuper,
  normalizePhone,
  digitsOnly,
  moneyARS0,
  pointInAnyZone as corePointInAnyZone,
  enqueueWppMessage,
} from './src/services.js'
import { ejecutarEstrategiaVecinos } from './src/estrategias.js';
import { armarMensajeConfirmado } from './src/utils.js';
import jwt from 'jsonwebtoken'; 

// -------------------------------------------------------------------
// Debug
// -------------------------------------------------------------------
const DEBUG_ORDERS = process.env.DEBUG_ORDERS === '1'
const tStart = (label) => { if (DEBUG_ORDERS) console.time(label) }
const tEnd   = (label) => { if (DEBUG_ORDERS) console.timeEnd(label) }

// -------------------------------------------------------------------
// WebPush (VAPID)
// -------------------------------------------------------------------
const {
  VAPID_PUBLIC_KEY = '',
  VAPID_PRIVATE_KEY = '',
  VAPID_SUBJECT = 'mailto:admin@example.com'
} = process.env

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}

// -------------------------------------------------------------------
// Push templates por estado
// -------------------------------------------------------------------
const STATE_PUSH_TEMPLATES = {
  pendiente: (pedido_id) => ({
    title: '¡Recibimos tu pedido!',
    body: `Tu pedido fue recibido correctamente.`,
    url: `/Pedidos/pedido.html?id=${pedido_id}`,
    pedido_id
  }),
  en_ruta: (pedido_id) => ({
    title: 'Estamos llegando',
    body: `Tu pedido ya está en camino.`,
    url: `/Pedidos/pedido.html?id=${pedido_id}`,
    pedido_id
  }),
  entregado: (pedido_id) => ({
    title: 'Pedido entregado',
    body: `Tu pedido fue entregado. ¡Gracias!`,
    url: `/Pedidos/pedido.html?id=${pedido_id}`,
    pedido_id
  })
}

function buildPushForEstado (pedido_id, estado) {
  const tpl = STATE_PUSH_TEMPLATES[String(estado || '').toLowerCase()]
  return tpl ? tpl(pedido_id) : null
}

// NUEVO: helper de alto nivel para notificar un cambio de estado por Web Push
export async function notifyEstadoPedidoPush (pedido_id, estado) {
  const payload = buildPushForEstado(pedido_id, estado);
  if (!payload) return;               // si el estado no tiene template, no hacemos nada
  await notifyByPedido(pedido_id, payload);
}

// -------------------------------------------------------------------
// Helpers numéricos / coords
// -------------------------------------------------------------------
const toNum = (v) => {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const inRange = (n, a, b) => Number.isFinite(n) && n >= a && n <= b
const round   = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d

// Texto: normalizar para comparar direcciones
const normalizeText = (v) => {
  return String(v || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// -------------------------------------------------------------------
// Dinero + resumen de ítems
// -------------------------------------------------------------------
function formatMoneyARS0 (n) {
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(Math.round(Number(n || 0)))
  } catch {
    return '$' + String(Math.round(Number(n || 0))).replace('.', ',')
  }
}

function buildOrderSummary (normItems) {
  const totalCantidad = normItems.reduce((acc, it) => acc + it.cantidad, 0)
  const totalMonto    = normItems.reduce((acc, it) => acc + (it.cantidad * it.precio_unitario), 0)

  if (normItems.length === 1) {
    const it  = normItems[0]
    const sub = it.cantidad * it.precio_unitario
    return `${it.cantidad} × ${it.producto} — ${formatMoneyARS0(sub)}`
  }

  return `${totalCantidad} artículos — ${formatMoneyARS0(totalMonto)}`
}

// -------------------------------------------------------------------
// Alias de empresa (transferencia)
// -------------------------------------------------------------------
async function getAliasEmpresa (empresa_id) {
  try {
    const rows = await query(`
      SELECT alias
      FROM empresa_cuentas_bancarias
      WHERE empresa_id = $1
      ORDER BY COALESCE(activa, false) DESC,
               COALESCE(prioridad, 999),
               id
      LIMIT 1
    `, [empresa_id])

    if (rows.length && rows[0].alias) {
      return String(rows[0].alias).trim()
    }
  } catch { }

  try {
    const rows = await query(`
      SELECT alias
      FROM empresas
      WHERE id = $1
      LIMIT 1
    `, [empresa_id])
    if (rows.length && rows[0].alias) {
      return String(rows[0].alias).trim()
    }
  } catch { }

  return null
}


// ------------------------------------------------------------
// Helper: IP → país / provincia (sin pedir permisos al navegador)
// ------------------------------------------------------------
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '';
}

async function getLocationFromIp(req) {
  // Valores por defecto si falla todo
  let pais = 'Argentina';
  let provincia = 'Córdoba';

  const ip = getClientIp(req);

  // En desarrollo / localhost no tiene sentido pedir geolocalización
  if (!ip || ip === '::1' || ip.startsWith('127.')) {
    return { pais, provincia };
  }

  try {
    // Ejemplo usando ipapi.co (podés cambiarlo por otro servicio o una base local)
    const resp = await fetch(`https://ipapi.co/${ip}/json/`);
    if (!resp.ok) return { pais, provincia };

    const data = await resp.json();

    if (data.country_name) pais = data.country_name;
    if (data.region) provincia = data.region;

    return { pais, provincia };
  } catch (e) {
    console.error('IP GEO ERROR', e);
    return { pais, provincia };
  }
}

// -------------------------------------------------------------------
// Registro de rutas
// -------------------------------------------------------------------
export function registerOrderRoutes (
  app,
  {
    withAuth      = defaultWithAuth,
    resolveEmpresaId = defaultResolveEmpresaId,
    isSuper       = defaultIsSuper
  } = {}
) {

  // ------------------------------------------------------------
  // Config pública (multi-tenant por dominio / query)
  // ------------------------------------------------------------
app.get('/public/config', async (req, res) => {
  try {
    // 1) Si ya viene empresa_id en la URL, lo respetamos SIEMPRE
    const rawId = req.query.empresa_id;
    if (rawId !== undefined && rawId !== null && rawId !== '') {
      const parsed = Number(rawId);
      if (Number.isFinite(parsed) && parsed > 0) {
        // Buscamos la empresa para también devolver el nombre
        const rows = await query(
          `SELECT id, nombre
             FROM empresas
            WHERE id = $1
            LIMIT 1`,
          [parsed]
        );

        if (rows.length) {
          const empresa_id = Number(rows[0].id);
          const nombre_empresa = rows[0].nombre ? String(rows[0].nombre) : null;
          const loc = await getLocationFromIp(req);

          return res.json({
            empresa_id,
            nombre_empresa,
            nombre: nombre_empresa,
            ...loc
          });
        }
        // Si no existe esa empresa, seguimos con la lógica de slug/dominio
      }
    }

    // 2) Intentar por slug explícito (?slug=hidro-cba)
    const rawSlug = (req.query.slug || '').toString().trim().toLowerCase();

    let host = (req.headers.host || '').split(':')[0].trim().toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);

    let row = null;

    // 2a) Buscar por slug
    if (rawSlug) {
      const rows = await query(
        `SELECT id, nombre
           FROM empresas
          WHERE LOWER(landing_slug) = $1
          LIMIT 1`,
        [rawSlug]
      );
      if (rows.length) row = rows[0];
    }

    // 3) Si no hay slug o no matcheó, buscamos por dominio
    if (!row && host) {
      const rows = await query(
        `SELECT id, nombre
           FROM empresas
          WHERE LOWER(landing_domain) = $1
          LIMIT 1`,
        [host]
      );
      if (rows.length) row = rows[0];
    }

    // 4) Fallback dinámico: primera empresa por ID (normalmente id = 1)
    if (!row) {
      const rows = await query(
        `SELECT id, nombre
           FROM empresas
          ORDER BY id ASC
          LIMIT 1`
      );
      if (rows.length) {
        row = rows[0];
      }
    }

    // Si todavía no hay empresa, devolvemos error claro
    if (!row) {
      return res.status(404).json({ error: 'No hay empresas configuradas' });
    }

    const empresa_id = Number(row.id);
    const nombre_empresa = row.nombre ? String(row.nombre) : null;
    const loc = await getLocationFromIp(req);

    return res.json({
      empresa_id,
      nombre_empresa,
      nombre: nombre_empresa,
      ...loc
    });
  } catch (e) {
    console.error('PUBLIC CONFIG ERROR', e);
    // Último fallback: empresa 1 + localización por defecto
    return res.json({
      empresa_id: 1,
      nombre_empresa: null,
      nombre: null,
      pais: 'Argentina',
      provincia: 'Córdoba'
    });
  }
});
  
  // ------------------------------------------------------------
  // Datos públicos de la empresa (contacto, etc.)
  // ------------------------------------------------------------
  app.get('/public/empresa', async (req, res) => {
    try {
      const rawId = req.query.empresa_id;
      const empresaId = Number(rawId);

      if (!Number.isFinite(empresaId) || empresaId <= 0) {
        return res.status(400).json({ error: 'empresa_id inválido' });
      }

      const rows = await query(
        `SELECT
           id,
           nombre,
           razon_social,
           cuit,
           direccion,
           ciudad,
           provincia,
           pais,
           telefono,
           email
         FROM empresas
         WHERE id = $1
         LIMIT 1`,
        [empresaId]
      );

      if (!rows.length) {
        return res.status(404).json({ error: 'Empresa no encontrada' });
      }

      const e = rows[0];

      return res.json({
        id: e.id,
        nombre: e.nombre,
        razon_social: e.razon_social,
        cuit: e.cuit,
        direccion: e.direccion,
        ciudad: e.ciudad,
        provincia: e.provincia,
        pais: e.pais,
        telefono: e.telefono,
        email: e.email
      });
    } catch (err) {
      console.error('PUBLIC EMPRESA ERROR', err);
      return res.status(500).json({ error: 'Error al obtener datos de empresa' });
    }
  });

// ------------------------------------------------------------
// Productos públicos (Landing vs Catálogo, con categoría + orden)
// ------------------------------------------------------------
app.get('/public/productos', async (req, res) => {
  try {
    const empresa_id = Number(req.query.empresa_id) || 1
    const scope = req.query.scope || 'all' // 'catalog' | 'landing' | 'all'
    const soloDestacados = req.query.destacado === 'true' // Compatibilidad filtro viejo

    // Selección ampliada para soportar promos y visibilidad
    let sql = `
      SELECT
        id,
        nombre,
        precio,
        descripcion,
        imagen,
        imagen_promo,
        categoria,
        etiqueta,
        destacado
      FROM productos
      WHERE empresa_id = $1
        AND COALESCE(activo, true)
    `

    // 1. Filtros de Visibilidad
    if (scope === 'landing') {
      // Solo lo que tenga el check de landing activo
      sql += ` AND mostrar_en_landing = true`
    } else if (scope === 'catalog') {
      // Solo lo que tenga el check de catálogo activo
      sql += ` AND mostrar_en_catalogo = true`
    }

    // Compatibilidad con filtro manual viejo
    if (soloDestacados) {
      sql += ` AND destacado = true`
    }

    // 2. Ordenamiento Inteligente
    if (scope === 'landing') {
      // En landing: Primero los que tienen etiqueta (Oferta, Popular), luego por precio
      sql += ` ORDER BY etiqueta NULLS LAST, precio ASC`
    } else {
      // En catálogo: Por categoría, orden manual o nombre
      sql += ` ORDER BY categoria NULLS LAST, COALESCE(orden, id), nombre`
    }

    const rows = await query(sql, [empresa_id])
    res.json(rows)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'No se pudieron obtener productos' })
  }
})

  // ------------------------------------------------------------
  // Buscar contacto
  // ------------------------------------------------------------
app.get('/public/contacto', async (req, res) => {
  try {
    const empresa_id   = Number(req.query.empresa_id || 1)
    const telefonoRaw  = req.query.telefono
    const telefonoNorm = normalizePhone(telefonoRaw)

    if (!telefonoNorm) {
      return res.status(400).json({ error: 'telefono requerido' })
    }

    const rows = await query(`
      SELECT id, cliente, telefono, direccion, ciudad, provincia, pais,
             latitud, longitud, notas, zona_id
      FROM puntos_entrega
      WHERE empresa_id = $1
        AND telefono_normalizado LIKE '%' || $2
      ORDER BY id DESC
      LIMIT 1
    `, [empresa_id, telefonoNorm])

    if (!rows.length) {
      return res.json({ ok: true, found: false })
    }

    return res.json({ ok: true, found: true, contacto: rows[0] })

  } catch (e) {
    console.error('ERROR /public/contacto', e)
    return res.status(500).json({ error: 'No se pudo buscar el contacto' })
  }
})

// ------------------------------------------------------------
  // Crear pedido (POST) - LÓGICA COMPLETA + CORRECCIÓN CHOFER
  // ------------------------------------------------------------
  app.post('/public/pedidos', async (req, res) => {
    const reqId  = `ped-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const log    = (...a) => DEBUG_ORDERS && console.log('[public/pedidos]', reqId, '-', ...a)
    const errlog = (...a) => console.error('[public/pedidos]', reqId, '-', ...a)

    res.set('x-request-id', reqId)
    tStart(`[public/pedidos] ${reqId} TOTAL`)

    try {
      const {
        empresa_id = 1,
        cliente,
        telefono,
        direccion,
        ciudad,
        provincia,
        pais,
        latitud,
        longitud,
        notas,
        metodo_pago,
        submission_id,
        items = [],
        referral_code // <--- Código de referido (VECINO-XXX)
      } = req.body || {}

      log('REQ IN', {
        empresa_id, cliente, telefono, direccion, ciudad, provincia, pais,
        latitud, longitud, notas, metodo_pago, submission_id,
        itemsCount: Array.isArray(items) ? items.length : 'n/a'
      })

      // Validaciones básicas
      if (!cliente || String(cliente).trim().length < 2) {
        tEnd(`[public/pedidos] ${reqId} TOTAL`)
        return res.status(400).json({ error: 'cliente es requerido', reqId })
      }

      if (!telefono || String(telefono).trim().length < 6) {
        tEnd(`[public/pedidos] ${reqId} TOTAL`)
        return res.status(400).json({ error: 'telefono es requerido', reqId })
      }

      if (!direccion) {
        tEnd(`[public/pedidos] ${reqId} TOTAL`)
        return res.status(400).json({ error: 'direccion es requerida', reqId })
      }

      if (!Array.isArray(items) || items.length === 0) {
        tEnd(`[public/pedidos] ${reqId} TOTAL`)
        return res.status(400).json({ error: 'items es requerido y no puede estar vacío', reqId })
      }

      const empId = Number(empresa_id) > 0 ? Number(empresa_id) : 1

      // Normalizar coords iniciales
      let lat = toNum(latitud)
      let lng = toNum(longitud)
      lat = inRange(lat, -90, 90) ? round(lat) : null
      lng = inRange(lng, -180, 180) ? round(lng) : null

      // =========================================================================
      // GEOCODIFICACIÓN INTELIGENTE (CACHÉ VS GOOGLE)
      // =========================================================================
      if ((lat == null || lng == null) && (direccion || ciudad || provincia || pais)) {
        
        let foundInCache = false;

        // 1. INTENTO DE AHORRO: Buscar en historial local
        try {
           const phoneNorm = normalizePhone(telefono || '');
           const searchPhone = phoneNorm.length > 7 ? phoneNorm.slice(-7) : phoneNorm;

           if (searchPhone.length >= 4) {
               const history = await query(`
                 SELECT direccion, ciudad, latitud, longitud 
                 FROM puntos_entrega 
                 WHERE empresa_id=$1 
                   AND latitud IS NOT NULL 
                   AND longitud IS NOT NULL
                   AND telefono_normalizado LIKE '%' || $2
                 ORDER BY id DESC 
                 LIMIT 5
               `, [empId, searchPhone]);

               const currentDir = (direccion || '').trim().toLowerCase();
               
               for (const h of history) {
                   const hDir = (h.direccion || '').trim().toLowerCase();
                   if (currentDir && hDir && currentDir === hDir) {
                       lat = Number(h.latitud);
                       lng = Number(h.longitud);
                      
                       foundInCache = true;
                       log(`[GEOCODE] 💰 CACHÉ AHORRO: Usamos coords guardadas para "${cliente}" (${direccion}) -> Lat=${lat}, Lng=${lng}`);
                       break; 
                   }
               }
           }
        } catch (e) {
           console.warn('[GEOCODE] Error al buscar historial:', e.message);
        }

        // 2. FALLBACK: Si no estaba en caché, llamamos a Google
        if (!foundInCache) {
            try {
              const loc = await geocodeIfNeeded({ direccion, ciudad, provincia, pais })
              if (lat == null) lat = toNum(loc?.lat)
              if (lng == null) lng = toNum(loc?.lng)
              
              if (lat && lng) {
                  log(`[GEOCODE] 🌎 API GOOGLE: Coordenadas nuevas para "${direccion}": ${lat}, ${lng}`);
              } else {
                  log(`[GEOCODE] ⚠️ FALLÓ: Google no encontró "${direccion}"`);
              }
            } catch (e) {
              console.warn('[GEOCODE] Error en geocodeIfNeeded:', e.message);
            }
        }
      }
      // =========================================================================

      // Determinar zona
      let zona_id = null
      if (lat != null && lng != null) {
        zona_id = await corePointInAnyZone({ empresa_id: empId, lat, lng })
      }

      // Guardar / reutilizar punto de entrega
      let punto_entrega_id = null

      try {
        // 1) Intentar reutilizar un punto_entrega existente (Búsqueda Exacta)
        const phoneNorm = normalizePhone(telefono || '')
        const searchPhone = phoneNorm.length > 7
          ? phoneNorm.slice(-7)
          : phoneNorm

        if (searchPhone && direccion) {
          const existingPoints = await query(`
            SELECT id, latitud, longitud, zona_id
            FROM puntos_entrega
            WHERE empresa_id = $1
              AND telefono_normalizado LIKE '%' || $2
              AND LOWER(TRIM(direccion)) = LOWER(TRIM($3))
            ORDER BY id DESC
            LIMIT 1
          `, [empId, searchPhone, direccion])

          if (existingPoints.length > 0) {
            const match = existingPoints[0]
            punto_entrega_id = match.id

            // Si no teníamos zona aún, podemos reutilizar la guardada
            if (zona_id == null && match.zona_id != null) {
              zona_id = match.zona_id
            }

            // Si no teníamos coords válidas, podemos reutilizar las guardadas
            if ((lat == null || lng == null) && match.latitud != null && match.longitud != null) {
              lat = Number(match.latitud)
              lng = Number(match.longitud)
            }

            log('PUNTO_ENTREGA.REUSE', {
              punto_entrega_id,
              direccion,
              match_db: true
            })
          }
        }
      } catch (e) {
        errlog('PUNTO_ENTREGA.REUSE.ERROR', e?.message || e)
      }

      // 2) Si no encontramos uno reutilizable, insertamos uno nuevo
      if (!punto_entrega_id) {
        const telNorm = normalizePhone(telefono || '')

        const peRows = await query(`
          INSERT INTO puntos_entrega (
            empresa_id, cliente, telefono, telefono_normalizado, direccion, ciudad, provincia, pais,
            latitud, longitud, notas, zona_id
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          RETURNING id
        `, [
          empId,
          cliente,
          telefono,
          telNorm,
          direccion,
          ciudad,
          provincia,
          pais,
          lat,
          lng,
          notas,
          zona_id
        ])

        punto_entrega_id = peRows[0].id

        log('PUNTO_ENTREGA.NEW', {
          punto_entrega_id,
          direccion,
          ciudad,
          telefono
        })
      }

      // Resolver chofer
      let chofer_id = null
      if (zona_id != null) {
        try {
          const chRows = await query(`
            SELECT c.id
            FROM zona_chofer zc
            JOIN choferes c ON c.id = zc.chofer_id
            WHERE zc.zona_id = $1 AND c.empresa_id = $2
            ORDER BY zc.chofer_id ASC  -- << CORREGIDO (Antes decía zc.id)
            LIMIT 1
          `, [zona_id, empId])
          if (chRows.length) {
            chofer_id = chRows[0].id
          }
        } catch (e) {
          errlog('CHOFER.RESOLVE.ERROR', e?.message || e)
        }
      }

      // Normalizar items INICIALES
      const normItems = (Array.isArray(items) ? items : [])
        .map(it => ({
          producto: String(it?.producto || '').trim(),
          cantidad: Number(it?.cantidad ?? 0),
          precio_unitario: Number(it?.precio_unitario ?? 0)
        }))
        .filter(it =>
          it.producto &&
          Number.isFinite(it.cantidad) && it.cantidad > 0 &&
          Number.isFinite(it.precio_unitario) && it.precio_unitario >= 0
        )

      if (normItems.length === 0) {
        tEnd(`[public/pedidos] ${reqId} TOTAL`)
        return res.status(400).json({ error: 'items inválidos', reqId })
      }

      // ------------------------------------------------------------
      // 🎁 LÓGICA DE RECOMPENSAS (CANJE AUTOMÁTICO)
      // ------------------------------------------------------------
      let rewardIdsToUpdate = []; // Guardamos los IDs para marcar como reclamados luego

      if (punto_entrega_id) {
        try {
          // 1. Buscamos premios NO reclamados para este cliente
          const premios = await query(`
            SELECT cr.id, cr.cantidad, p.nombre
            FROM cliente_recompensas cr
            JOIN productos p ON p.id = cr.producto_id
            WHERE cr.cliente_id = $1
              AND cr.reclamado = FALSE
          `, [punto_entrega_id]);

          if (premios.length > 0) {
            log('REWARDS', `Cliente ${punto_entrega_id} tiene ${premios.length} premios para canjear.`);

            for (const premio of premios) {
              // 2. Inyectamos el premio en el carrito del pedido
              normItems.push({
                producto: `🎁 PREMIO: ${premio.nombre}`, 
                cantidad: Number(premio.cantidad),
                precio_unitario: 0 
              });

              // Guardamos el ID del premio para "quemarlo" (marcar reclamado) al final
              rewardIdsToUpdate.push(premio.id);
            }
          }
        } catch (e) {
          errlog('REWARDS.ERROR', e?.message || e);
        }
      }
      // ------------------------------------------------------------

      // RECALCULAR TOTALES (Importante: porque acabamos de modificar normItems)
      const totalCantidad = normItems.reduce((acc, it) => acc + it.cantidad, 0)
      const totalMonto    = normItems.reduce((acc, it) => acc + (it.cantidad * it.precio_unitario), 0)

      // Resumen pago
      const mPago = String(metodo_pago || '').toLowerCase()
      const pagoTag =
        mPago
          ? (mPago === 'transferencia' ? ' (Transferencia)' :
             mPago === 'efectivo'      ? ' (Efectivo)'      :
                                         ` (${mPago})`)
          : ''

      const resumenTxt = buildOrderSummary(normItems) + pagoTag

      // Idempotencia
      const pedExist = await query(`
        SELECT id, estado, monto
        FROM pedidos
        WHERE submission_id=$1
      `, [submission_id])

      if (submission_id && pedExist.length) {
        const existing = pedExist[0]
        tEnd(`[public/pedidos] ${reqId} TOTAL`)
        return res.json({
          ok: true,
          created: false,
          pedido: {
            id: existing.id,
            submission_id,
            estado: existing.estado,
            monto: existing.monto
          },
          zona_id,
          coords: (lat != null && lng != null) ? { lat, lng } : null,
          resumen: resumenTxt,
          reqId
        })
      }

      // ------------------------------------------------------------
      // LÓGICA DE REFERIDOS (Captura Padrino)
      // ------------------------------------------------------------
      let padrinoId = null;
      if (referral_code && referral_code.startsWith('VECINO-')) {
          const historial = await query('SELECT id FROM pedidos WHERE punto_entrega_id=$1 LIMIT 1', [punto_entrega_id]);
          const esClienteNuevo = historial.length === 0;

          if (esClienteNuevo) {
              const idOrigen = parseInt(referral_code.split('-')[1]);
              if (Number.isInteger(idOrigen)) {
                  // Buscar quién hizo el pedido origen (el padrino)
                  const rowPadrino = await query(`
                      SELECT punto_entrega_id FROM pedidos WHERE id=$1
                  `, [idOrigen]);
                  
                  if (rowPadrino.length > 0) {
                      const candidatoId = rowPadrino[0].punto_entrega_id;
                      if (candidatoId !== punto_entrega_id) {
                          padrinoId = candidatoId;
                          console.log(`[REFERIDOS] Cliente ${punto_entrega_id} referido por ${padrinoId}`);
                      }
                  }
              }
          }
      }

      // Crear pedido (Ahora incluye referido_por_id)
      const pedRows = await query(`
        INSERT INTO pedidos (
          empresa_id, punto_entrega_id, fecha, estado,
          cantidad, cantidad_entregada, monto,
          metodo_pago, aviso_recibido, sats,
          submission_id, chofer_id, zona_id,
          referido_por_id
        )
        VALUES ($1,$2,NOW(),'pendiente',$3,0,$4,$5,0,0,$6,$7,$8, $9)
        RETURNING id, estado, monto
      `, [
        empId, 
        punto_entrega_id, 
        totalCantidad, 
        totalMonto, 
        metodo_pago, 
        submission_id, 
        chofer_id,
        zona_id,
        padrinoId 
      ])

      const pedido = pedRows[0]

      // Items pedido (Incluye los premios)
      for (const it of normItems) {
        await query(`
          INSERT INTO items_pedido (pedido_id, producto, cantidad, precio_unitario)
          VALUES ($1,$2,$3,$4)
        `, [pedido.id, it.producto, it.cantidad, it.precio_unitario])
      }

      // ------------------------------------------------------------
      // 🎁 ACTUALIZAR ESTADO DE PREMIOS (MARCAR COMO RECLAMADOS)
      // ------------------------------------------------------------
      if (rewardIdsToUpdate.length > 0) {
        try {
          await query(`
            UPDATE cliente_recompensas
            SET reclamado = TRUE,
                fecha_reclamado = NOW(),
                origen_pedido_id = $2
            WHERE id = ANY($1::int[])
          `, [rewardIdsToUpdate, pedido.id]);
          
          log('REWARDS.CLAIMED', `Premios IDs [${rewardIdsToUpdate.join(',')}] marcados como reclamados.`);
        } catch (e) {
          errlog('REWARDS.UPDATE.ERROR', e?.message || e);
        }
      }
      // ------------------------------------------------------------

      // Notificación WPP
      try {
        // 1. Obtener Configuración de Entrega de la Empresa
        const empRows = await query('SELECT config_entrega FROM empresas WHERE id=$1', [empId]);
        const configEntrega = empRows[0]?.config_entrega || {};

        // 2. Obtener datos del chofer asignado (si hay)
        let repData = null;
        if (chofer_id) {
           const cRows = await query('SELECT nombre, telefono FROM choferes WHERE id=$1', [chofer_id]);
           if (cRows.length) repData = cRows[0];
        }

        // 3. Obtener Alias (si es transferencia)
        const isTransf = String(metodo_pago).toLowerCase().includes('transf');
        const aliasDB = isTransf ? await getAliasEmpresa(empId) : null;

        // 4. Armar Mensaje Inteligente
        let mensaje = armarMensajeConfirmado({
            cliente,
            items: normItems,
            direccion: [direccion, ciudad, provincia].filter(Boolean).join(', '),
            fecha: new Date(),
            repartidor: repData,
            configEntrega
        });

        // 5. Agregar datos de pago si corresponde
        if (isTransf && aliasDB) {
            mensaje += `\n\n📄 Alias para transferir: *${aliasDB}*\nPor favor enviá el comprobante por aquí.`;
        }

        await enqueueWppMessage({ phone: telefono, message: mensaje, empresa_id: empId })

      } catch (e) {
        errlog('WPP.NOTIFY.ERROR', e?.message || e)
      }

      tEnd(`[public/pedidos] ${reqId} TOTAL`)

      res.json({
        ok: true,
        created: true,
        pedido: {
          id: pedido.id,
          submission_id,
          estado: pedido.estado,
          monto: pedido.monto
        },
        zona_id,
        coords: (lat != null && lng != null) ? { lat, lng } : null,
        resumen: resumenTxt,
        reqId
      })

    } catch (err) {
      tEnd(`[public/pedidos] ${reqId} TOTAL`)
      res.status(500).json({ error: 'No se pudo crear el pedido', reqId })
    }
  })

  // ------------------------------------------------------------
  // Ultimo pedido
  // ------------------------------------------------------------
app.get('/public/ultimo-pedido', async (req, res) => {
  try {
    const empresa_id = Number(req.query.empresa_id) || 1
    const telefonoIn = String(req.query.telefono || '').trim()
    const contactoId = Number(req.query.contacto_id) || null

    let punto_entrega_id = null

    if (contactoId) {
      const rows = await query(`
        SELECT id
        FROM puntos_entrega
        WHERE empresa_id = $1 AND id = $2
      `, [empresa_id, contactoId])
      if (rows.length) punto_entrega_id = rows[0].id
    } else if (telefonoIn) {
      const norm = normalizePhone(telefonoIn)

      let rows = await query(`
        SELECT id
        FROM puntos_entrega
        WHERE empresa_id = $1
          AND telefono_normalizado = $2
        ORDER BY id DESC
        LIMIT 1
      `, [empresa_id, norm])

      if (!rows.length) {
        rows = await query(`
          SELECT id
          FROM puntos_entrega
          WHERE empresa_id = $1
            AND telefono_normalizado LIKE '%' || $2
          ORDER BY id DESC
          LIMIT 1
        `, [empresa_id, norm])
      }

      if (rows.length) punto_entrega_id = rows[0].id
    }

    if (!punto_entrega_id) {
      return res.status(404).json({ error: 'contacto no encontrado' })
    }

    const pedRows = await query(`
      SELECT id, estado, fecha
      FROM pedidos
      WHERE punto_entrega_id = $1
      ORDER BY fecha DESC, id DESC
      LIMIT 1
    `, [punto_entrega_id])

    if (!pedRows.length) {
      return res.status(404).json({ error: 'no hay pedidos para este contacto' })
    }

    return res.json({
      ok: true,
      pedido: pedRows[0]
    })
  } catch (e) {
    console.error('ERROR /public/ultimo-pedido', e)
    return res.status(500).json({ error: 'No se pudo buscar el último pedido' })
  }
})

// Endpoint para el Marketplace: Trae empresas (con filtro de zona opcional)

app.get('/public/marketplace', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    
    let empresas = [];

    // CASO A: Filtrar por Ubicación (PostGIS)
    if (!isNaN(lat) && !isNaN(lng)) {
      empresas = await query(`
        SELECT DISTINCT e.id, e.nombre, e.rubro, e.etiquetas, e.landing_slug, e.landing_domain
        FROM empresas e
        JOIN zonas_geograficas z ON z.empresa_id = e.id
        WHERE (e.landing_slug IS NOT NULL OR e.landing_domain IS NOT NULL)
          AND z.geom IS NOT NULL
          -- PostGIS: Longitud (X), Latitud (Y)
          AND ST_Contains(z.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
        ORDER BY e.id ASC
      `, [lng, lat]);
    } 
    // CASO B: Sin filtro (Mostrar todas)
    else {
      empresas = await query(`
        SELECT id, nombre, rubro, etiquetas, landing_slug, landing_domain
        FROM empresas
        WHERE landing_slug IS NOT NULL OR landing_domain IS NOT NULL
        ORDER BY id ASC
      `);
    }

    // 2. Para cada empresa encontrada, traer sus 3 productos destacados
    const resultados = [];
    
    for (const emp of empresas) {
      const productos = await query(`
        SELECT id, nombre, precio, imagen
        FROM productos
        WHERE empresa_id = $1 
          AND (activo = true OR activo IS NULL)
          AND mostrar_en_catalogo = true
        ORDER BY destacado DESC, id ASC
        LIMIT 3
      `, [emp.id]);

      if (productos.length > 0) {
        resultados.push({ ...emp, productos });
      }
    }

    res.json(resultados);
  } catch (e) {
    console.error('MARKETPLACE ERROR:', e);
    res.status(500).json({ error: 'Error cargando marketplace' });
  }
});

  // ------------------------------------------------------------
  // WPP Chofer
  // ------------------------------------------------------------

app.get('/public/pedido-chofer-wpp', async (req, res) => {
    try {
      const pedido_id = Number(req.query.pedido_id || req.query.id)
      if (!Number.isFinite(pedido_id)) {
        return res.status(400).json({ error: 'pedido_id inválido' })
      }

      let rows = await query(`
        SELECT c.id AS chofer_id, c.nombre, c.telefono
        FROM pedidos p
        JOIN choferes c ON c.id = p.chofer_id
        WHERE p.id=$1
      `, [pedido_id])

      if (!rows.length) {
        rows = await query(`
          SELECT c.id AS chofer_id, c.nombre, c.telefono
          FROM pedidos p
          JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
          JOIN zona_chofer zc ON zc.zona_id = pe.zona_id
          JOIN choferes c ON c.id = zc.chofer_id
          WHERE p.id=$1
          ORDER BY zc.chofer_id ASC
          LIMIT 1
        `, [pedido_id])
      }

      if (!rows.length) {
        return res.status(404).json({ error: 'chofer no asignado' })
      }

      const onlyDigits = s => String(s || '').replace(/\D+/g, '')
      function toWhatsAppE164AR (tel) {
        let d = onlyDigits(tel)
        if (!d) return null
        if (d.startsWith('549')) return d
        if (d.startsWith('54')) return '549' + d.slice(2)
        if (d.startsWith('0')) d = d.slice(1)
        if (d.startsWith('15')) d = d.slice(2)
        return '549' + d
      }

      const row = rows[0]
      const wa  = toWhatsAppE164AR(row.telefono)

      return res.json({
        ok: true,
        chofer: {
          id: row.chofer_id,
          nombre: row.nombre,
          telefono: row.telefono,
          wa
        }
      })

    } catch (e) {
      return res.status(500).json({ error: 'No se pudo obtener el WhatsApp del chofer' })
    }
  })

  // ------------------------------------------------------------
  // Estado pedido
  // ------------------------------------------------------------
app.get('/public/pedido-estado', async (req, res) => {
    try {
      const id = Number(req.query.id)
      if (!id) return res.status(400).json({ error: 'id requerido' })

      const base = await query(`
        SELECT p.id, p.estado, p.fecha,
               pe.cliente, pe.direccion, pe.latitud, pe.longitud, p.monto
        FROM pedidos p
        JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        WHERE p.id=$1
      `, [id])

      if (!base.length) {
        return res.status(404).json({ error: 'pedido no encontrado' })
      }

      const items = await query(`
        SELECT cantidad, precio_unitario
        FROM items_pedido
        WHERE pedido_id=$1
      `, [id])

      const totalCalc = (items || []).reduce(
        (a, it) =>
          a + (Number(it.cantidad) || 0) * (Number(it.precio_unitario) || 0),
        0
      )

      const row   = base[0]
      const monto = Number(row.monto || 0) || Math.round(totalCalc * 100) / 100

      return res.json({ ...row, monto })

    } catch (e) {
      return res.status(500).json({ error: 'No se pudo obtener el estado del pedido' })
    }
  })

  // ------------------------------------------------------------
  // PUSH
  // ------------------------------------------------------------
app.get('/public/push/vapid-key', (req, res) => {
    res.json({ key: VAPID_PUBLIC_KEY || '' })
  })

app.post('/public/push/subscribe', async (req, res) => {
    try {
      const body = req.body || {}
      const sub = body.subscription ? body.subscription : {
        endpoint: body.endpoint,
        keys: {
          p256dh: body.p256dh || body.keys?.p256dh,
          auth:   body.auth   || body.keys?.auth
        }
      }
      const endpoint = sub?.endpoint
      if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' })

      const p256dh = sub?.keys?.p256dh || null
      const auth   = sub?.keys?.auth   || null
      const empresa_id = Number(body.empresa_id) || null
      const pedido_id  = Number(body.pedido_id) || null

      const rows = await query(`
        INSERT INTO push_subs (endpoint, p256dh, auth, empresa_id, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT(endpoint) DO UPDATE SET
          p256dh     = EXCLUDED.p256dh,
          auth       = EXCLUDED.auth,
          empresa_id = EXCLUDED.empresa_id
        RETURNING id
      `, [endpoint, p256dh, auth, empresa_id])

      const subId = rows[0]?.id

      if (pedido_id && subId) {
        await query(`
          INSERT INTO push_sub_pedidos (sub_id, pedido_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `, [subId, pedido_id])
      }

      res.json({ ok: true })
    } catch (e) {
      console.error('PUSH.SUBSCRIBE ERROR:', e)
      res.status(500).json({ error: 'No se pudo guardar la suscripción' })
    }
  })

app.post('/public/push/unsubscribe', async (req, res) => {
    try {
      const body     = req.body || {}
      const endpoint = body.endpoint || body.subscription?.endpoint
      if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' })

      await query(`DELETE FROM push_subs WHERE endpoint=$1`, [endpoint])
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: 'No se pudo borrar la suscripción' })
    }
  })

}

// -------------------------------------------------------------------
// Helper: notificar por pedido
// -------------------------------------------------------------------
export async function notifyByPedido (pedido_id, payload) {
  const rows = await query(`
    SELECT s.endpoint, s.p256dh, s.auth
    FROM push_sub_pedidos m
    JOIN push_subs s ON s.id = m.sub_id
    WHERE m.pedido_id = $1
  `, [pedido_id])

  for (const r of rows) {
    const sub = {
      endpoint: r.endpoint,
      keys: { p256dh: r.p256dh, auth: r.auth }
    }
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload))
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await query(`DELETE FROM push_subs WHERE endpoint=$1`, [r.endpoint])
      }
    }
  }
}

export const pointInAnyZone = corePointInAnyZone

export default { registerOrderRoutes, notifyByPedido, pointInAnyZone }

export async function getEmpresaById(req, res) {
  try {
    const { id } = req.params;
    const usuario = req.user || {};

    // VALIDACIÓN DE SEGURIDAD
    // 1. Si NO es super admin...
    if (usuario.role !== 'super') {
      // 2. ...verificamos que el ID solicitado sea el suyo
      if (Number(id) !== Number(usuario.empresa_id)) {
        return res.status(403).json({ error: 'No tienes permiso para ver esta licencia.' });
      }
    }

    const rows = await query('SELECT * FROM empresas WHERE id = $1', [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error getEmpresaById:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}