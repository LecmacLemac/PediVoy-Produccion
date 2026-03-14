// src/handlers.js — ESM + PostgreSQL

import OpenAI from 'openai';
import { query } from './db.js';
import { buildIaMessages } from './iaPromptBuilder.js';


// ────────────────────────────────────────────────────────────────────────────────
// Helpers básicos
// ────────────────────────────────────────────────────────────────────────────────

const _ticks = ' ▂▃▄▅▆▇█'.split('');
const _money = (n) => `$${Number(n || 0).toFixed(0)}`;
const _iso = (d) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);

function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}

function phoneFromWaId(v) {
  return String(v || '').replace(/@(?:c\.us|lid)$/i, '').trim();
}

function _spark(arr) {
  if (!arr || !arr.length) return '(sin datos)';
  const nums = arr.map((v) => Number(v || 0));
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '(sin datos)';
  if (max === min) return _ticks[0].repeat(nums.length);
  return nums
    .map((v) => {
      const t = (v - min) / (max - min);
      const i = Math.max(
        0,
        Math.min(_ticks.length - 1, Math.round(t * (_ticks.length - 1)))
      );
      return _ticks[i];
    })
    .join('');
}

function _eachDate(desde, hasta) {
  const out = [];
  const d0 = new Date(desde + 'T00:00:00');
  const d1 = new Date(hasta + 'T00:00:00');
  for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
    out.push(_iso(d));
  }
  return out;
}

function _parseRangoFechas(input) {
  const hoy = new Date();
  const lower = (input || '').toLowerCase();
  if (lower.includes('ayer')) {
    const d = new Date(hoy);
    d.setDate(d.getDate() - 1);
    const s = _iso(d);
    return { desde: s, hasta: s };
  }
  if (!lower || lower.includes('hoy')) {
    const s = _iso(hoy);
    return { desde: s, hasta: s };
  }
  const mR = lower.match(
    /\b(\d{4}-\d{2}-\d{2})\s*[\.\-–—]\s*(\d{4}-\d{2}-\d{2})\b/
  );
  if (mR) return { desde: mR[1], hasta: mR[2] };
  const mD = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (mD) return { desde: mD[1], hasta: mD[1] };
  const s = _iso(hoy);
  return { desde: s, hasta: s };
}

function _parseEmpresaId(contenidoLimpio, defaultEmpresaId) {
  const m = contenidoLimpio.match(
    /\b(?:empresa|emp|e)\s*[:=]?\s*(\d{1,6})\b/i
  );
  return m ? Number(m[1]) : defaultEmpresaId;
}

// src/handlers.js

// ... (otros imports)

// ────────────────────────────────────────────────────────────────────────────────
// Helpers básicos
// ────────────────────────────────────────────────────────────────────────────────

// ... (tus otros helpers: _ticks, _money, etc.)

/**
 * 🛡️ SANITIZADOR PARA IA
 * Limpia el input para reducir riesgo de Prompt Injection.
 */
function sanitizarInputIA(texto) {
  if (!texto) return '';

  let limpio = String(texto);

  // 1. TRUNCADO DURO: Evita que alguien pegue un libro entero para gastar tus tokens
  // 500 caracteres suelen sobrar para pedir un pedido.
  if (limpio.length > 500) {
    limpio = limpio.slice(0, 500);
  }

  // 2. NEUTRALIZAR DELIMITADORES COMUNES
  // Si usas XML o Markdown en tu prompt de sistema, el usuario no debería poder usarlos.
  // Reemplazamos caracteres que podrían romper la estructura del prompt.
  limpio = limpio
    .replace(/```/g, "'''")       // Rompe bloques de código
    .replace(/\/\/\//g, "")       // Rompe separadores comunes
    .replace(/<\|endoftext\|>/g, "") // Token especial de fin de texto (raro pero peligroso)
    .replace(/[<>]/g, "");        // Elimina < y > para evitar inyección de XML tags si los usas

  // 3. ELIMINAR PATRONES DE "SYSTEM OVERRIDE" (Opcional pero recomendado)
  // Intentamos detectar si alguien intenta hablar como "System" o "Developer"
  const patronesPeligrosos = /system:|developer:|instrucciones:/yi;
  limpio = limpio.replace(patronesPeligrosos, "");

  return limpio.trim();
}

// LÓGICA DE CONTROL DE COMPORTAMIENTO (ROUTER DE INTENCIONES)
function decidirTipoConsultaIA(texto, role) {
  const t = (texto || '').toLowerCase();

  // 1. RECLAMOS / SOPORTE (Prioridad Alta)
  // Palabras clave que indican frustración o problemas técnicos
  if (
    t.includes('reclamo') ||
    t.includes('problema') ||
    t.includes('queja') ||
    t.includes('soporte') ||
    t.includes('no funciona') ||
    t.includes('no llego') ||
    t.includes('roto') ||
    t.includes('ayuda')
  ) {
    return 'soporte';
  }

  // 2. VENTAS / PEDIDOS
  // Palabras transaccionales
  if (
    t.includes('precio') ||
    t.includes('cuanto cuesta') ||
    t.includes('pedido') ||
    t.includes('comprar') ||
    t.includes('tenes') || // "¿tenes stock?"
    t.includes('vendes') ||
    t.includes('catalogo')
  ) {
    return 'vendedor';
  }

  // 3. REGLAS POR ROL DE USUARIO
  // Si un repartidor habla y no es un comando, suele ser un problema operativo -> soporte
  if (role === 'repartidor') return 'soporte';

  // 4. DEFAULT
  // Ante la duda, intentamos vender
  return 'vendedor';
}

async function sugerirEmpresasPorTexto(texto) {
  const rows = await query(`
    SELECT id, nombre, COALESCE(rubro,'') AS rubro,
           COALESCE(etiquetas,'') AS etiquetas,
           COALESCE(landing_domain,'') AS landing_domain,
           COALESCE(landing_slug,'')   AS landing_slug
    FROM empresas
    ORDER BY id
  `);

  const q = String(texto || '').toLowerCase();
  const palabras = q.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3);
  const norm = (s) => String(s || '').toLowerCase();

  const scoreOf = (e) => {
    const blob = `${norm(e.nombre)} ${norm(e.rubro)} ${norm(e.etiquetas)}`;
    let s = 0;
    for (const w of palabras) if (blob.includes(w)) s += 2;
    if (s === 0 && e.rubro) s += 0.5; // piso si al menos tiene rubro
    return s;
  };

  const top = rows
    .map(e => {
      const link = e.landing_domain
        ? `https://${e.landing_domain}`
        : (e.landing_slug
            ? `https://aguahidro.com.ar/?slug=${e.landing_slug}`
            : `https://aguahidro.com.ar/?empresa_id=${e.id}`);
      return { ...e, _s: scoreOf(e), link };
    })
    .sort((a,b) => b._s - a._s)
    .slice(0, 3);

  // Devolvemos solo lo necesario para armar bullets
  return top.map(e => ({
    id: e.id,
    nombre: e.nombre,
    rubro: e.rubro || 'Comercio',
    etiquetas: e.etiquetas,
    link: e.link,
  }));
}

// ────────────────────────────────────────────────────────────────────────────────
// IA fallback (multi-prompt empresa/tipo) — para TODO lo que no sea comando
// ────────────────────────────────────────────────────────────────────────────────

async function responderConIA(
  client,
  numero,
  contenido,
  { role, empresa_id, chofer_id, source } // ← incluye source
) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      await client.sendMessage(
        numero,
        '¿En qué te puedo ayudar? Contame qué necesitás (dirección, cantidad, forma de pago) y te armo el pedido.'
      );
      return;
    }

    // [SEGURIDAD] 1. Sanitizar el input antes de procesarlo
    const contenidoSeguro = sanitizarInputIA(contenido);
    
    // Si el mensaje quedó vacío o era solo basura, no gastamos saldo en OpenAI
    if (!contenidoSeguro) return;

    // Usamos el contenido limpio para decidir el tipo de consulta
    const tipo = decidirTipoConsultaIA(contenidoSeguro, role);

    // Contexto interno (string, no array)
    let contextoExtra = [
      '--- CONTEXTO TÉCNICO ---',
      `- Rol del usuario: ${role}`,
      `- ID Empresa: ${empresa_id}`,
      `- ID Chofer: ${chofer_id ?? 'N/A'}`,
      '- Canal: WhatsApp',
    ].join('\n');

    // Routing por empresas y solo prompts globales si es desconocido
    let empresaParaIa = empresa_id;
    if (source === 'desconocido') {
      const sugeridas = await sugerirEmpresasPorTexto(contenidoSeguro);
      if (sugeridas.length) {
        const bullets = sugeridas
          .slice(0, 3)
          .map((e, i) => `${i + 1}. *${e.nombre}* — ${e.rubro}${e.etiquetas ? ` (${e.etiquetas})` : ''}\n${e.link}`)
          .join('\n');

        contextoExtra += '\n\n' +
          'SUGERENCIAS DE EMPRESAS (usar en la respuesta al cliente):\n' +
          bullets + '\n\n' +
          'Instrucciones:\n' +
          '- Respondé con *prompts GLOBALes* (sin adoptar identidad de una empresa específica).\n' +
          '- Ofrecé 2–4 opciones que encajen con el pedido y pedí al cliente elegir.';

        empresaParaIa = null;
      }
    }

    // [SEGURIDAD] 2. Encapsular el mensaje del usuario
    const mensajeEncapsulado = `
<usuario_input>
${contenidoSeguro}
</usuario_input>
    `.trim();

    const mensajes = await buildIaMessages({
      empresaId: empresaParaIa,   // null => solo globales
      tipo,
      textoUsuario: mensajeEncapsulado,
      contextoExtra,
    });

    const openai = new OpenAI({ apiKey });
    
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: mensajes,
      temperature: 0.5,
      max_tokens: 300,
    });

    const texto = resp.choices?.[0]?.message?.content?.trim()
      || '¿En qué te puedo ayudar?';

    await client.sendMessage(numero, texto);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);

    // 1️⃣ Primero detectamos el bug de whatsapp-web.js
    const isSeenBug =
      msg.includes('markedUnread') ||
      msg.toLowerCase().includes('sendseen');

    if (isSeenBug) {
      console.warn(
        `Ignorando bug sendSeen/markedUnread en responderConIA para ${numero}:`,
        msg
      );
      return; // no lo tratamos como error real
    }

    // 2️⃣ Para otros errores sí logueamos como error y mandamos el mensaje de demora
    console.error('IA fallback error:', msg);

    try {
      await client.sendMessage(
        numero,
        'Estoy con demora. ¿Podés repetir con: "pedido | cantidad | forma | dirección"?'
      );
    } catch (err2) {
      const msg2 = String(err2 && err2.message ? err2.message : err2);
      const isSeenBug2 =
        msg2.includes('markedUnread') ||
        msg2.toLowerCase().includes('sendseen');

      if (isSeenBug2) {
        console.warn(
          `Bug sendSeen/markedUnread al enviar mensaje de demora a ${numero}, lo ignoro:`,
          msg2
        );
      } else {
        console.error('Error enviando mensaje de demora:', msg2);
      }
    }
  }
}



// ────────────────────────────────────────────────────────────────────────────────
// Contexto por teléfono (rol, empresa, chofer)
// ────────────────────────────────────────────────────────────────────────────────

async function _resolverContextoDesdeTelefono(numero) {
  const telRaw = phoneFromWaId(numero);
  const telDigits = digitsOnly(telRaw);
  const suffix10 = telDigits.slice(-10) || telDigits;

  // ────────────────────────────────────────────────────────────────────────
  // NIVEL 1: USUARIOS DEL SISTEMA (Admins, Super, Login Web)
  // ────────────────────────────────────────────────────────────────────────
  // Prioridad máxima: Si tiene login, respetamos su rol y empresa asignada.
  const uRows = await query(
    `
    SELECT id, role, empresa_id, chofer_id, username
    FROM usuarios
    WHERE username = $1 OR username = $2
    LIMIT 1
  `,
    [telRaw, suffix10]
  );
  
  const u = uRows[0];
  if (u) {
    let role = String(u.role || 'user').toLowerCase();
    if (role === 'admin') role = 'super';
    
    // Si el usuario no tiene empresa fija (ej. super), buscamos una default para que no rompa
    let empresaIdFinal = u.empresa_id;
    if (!empresaIdFinal) {
        const empRow = (await query(`SELECT id FROM empresas ORDER BY id LIMIT 1`))[0];
        empresaIdFinal = empRow?.id || 1;
    }

    return { 
        role, 
        empresa_id: empresaIdFinal, 
        chofer_id: u.chofer_id || null,
        source: 'usuario_registrado',
        nombre: u.username
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // NIVEL 2: REPARTIDORES / CHOFERES
  // ────────────────────────────────────────────────────────────────────────
  // Si no es admin, chequeamos si es un chofer operando por WhatsApp.
  const cRows = await query(
    `
    SELECT id AS chofer_id, empresa_id, nombre
    FROM choferes
    WHERE regexp_replace(COALESCE(telefono,''),'\\D','','g') LIKE '%' || $1
       OR regexp_replace(COALESCE(telefono,''),'\\D','','g') LIKE '%' || $2
    LIMIT 1
  `,
    [telDigits, suffix10]
  );
  
  const c = cRows[0];
  if (c?.chofer_id) {
    // Verificamos si tiene un usuario asociado para afinar el rol, sino es 'repartidor'
    const u2Rows = await query(
      `SELECT role FROM usuarios WHERE chofer_id = $1 LIMIT 1`,
      [c.chofer_id]
    );
    let role = u2Rows[0]?.role
      ? String(u2Rows[0].role).toLowerCase()
      : 'repartidor';
    
    if (role === 'admin') role = 'super';
    if (role !== 'super' && role !== 'repartidor') role = 'repartidor';

    return { 
        role, 
        empresa_id: c.empresa_id, 
        chofer_id: c.chofer_id,
        source: 'chofer',
        nombre: c.nombre
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // NIVEL 3: CLIENTES HISTÓRICOS (PUNTOS DE ENTREGA) - ¡NUEVO!
  // ────────────────────────────────────────────────────────────────────────
  // Buscamos si este teléfono ya hizo un pedido antes.
  // Ordenamos por ID DESC para tomar la ÚLTIMA empresa a la que le compró.
  const pRows = await query(
    `
    SELECT empresa_id, cliente
    FROM puntos_entrega
    WHERE regexp_replace(COALESCE(telefono,''),'\\D','','g') LIKE '%' || $1
    ORDER BY id DESC
    LIMIT 1
    `,
    [suffix10]
  );

  const p = pRows[0];
  if (p) {
    return {
        role: 'cliente',
        empresa_id: p.empresa_id,
        chofer_id: null,
        source: 'conocido_historico', // Útil para que la IA sepa que ya es cliente
        nombre: p.cliente // Para que la IA le diga "Hola [Nombre]"
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // NIVEL 4: DESCONOCIDO (Default)
  // ────────────────────────────────────────────────────────────────────────
  // No sabemos quién es. Asignamos una empresa por defecto (generalmente la primera)
  // y marcamos source='desconocido' para activar el "Buscador de Empresas" en la IA.
  const empRow = (await query(`SELECT id FROM empresas ORDER BY id LIMIT 1`))[0];
  const empresa_id = empRow?.id || 1;
  
  return { 
      role: 'cliente', 
      empresa_id, 
      chofer_id: null, 
      source: 'desconocido' 
  };
}

// ────────────────────────────────────────────────────────────────────────────────
// SQL helpers (PostgreSQL)
// ────────────────────────────────────────────────────────────────────────────────

async function _sqlResumenVentas({
  empresa_id,
  desde,
  hasta,
  chofer_id = null,
}) {
  // Pagos por método
  {
    const params = [empresa_id, desde, hasta];
    let whereChofer = '';
    if (chofer_id) {
      whereChofer = ' AND p.chofer_id = $4 ';
      params.push(chofer_id);
    }

    const pagos = await query(
      `
      SELECT LOWER(COALESCE(p.metodo_pago,'transferencia')) AS metodo,
             COALESCE(SUM(COALESCE(p.monto,0)),0) AS total
      FROM pedidos p
      JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
      WHERE pe.empresa_id = $1
        AND DATE(COALESCE(p.fecha_entrega, p.fecha)) BETWEEN $2::date AND $3::date
        AND LOWER(p.estado) = 'entregado'
        ${whereChofer}
      GROUP BY 1
    `,
      params
    );

    const total_ventas = pagos.reduce(
      (a, r) => a + Number(r.total || 0),
      0
    );
    const efectivo = Number(
      pagos.find((r) => r.metodo === 'efectivo')?.total || 0
    );
    const transferencia = Number(
      pagos.find((r) => r.metodo?.startsWith('transfer'))?.total || 0
    );
    const otros = Math.max(0, total_ventas - efectivo - transferencia);

    // Items
    const paramsItems = [empresa_id, desde, hasta];
    let whereChofer2 = '';
    if (chofer_id) {
      whereChofer2 = ' AND p.chofer_id = $4 ';
      paramsItems.push(chofer_id);
    }
    const rowItems =
      (
        await query(
          `
        SELECT COALESCE(SUM(it.cantidad),0) AS q
        FROM items_pedido it
        JOIN pedidos p ON p.id = it.pedido_id
        JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        WHERE pe.empresa_id = $1
          AND DATE(COALESCE(p.fecha_entrega, p.fecha)) BETWEEN $2::date AND $3::date
          AND LOWER(p.estado) = 'entregado'
          ${whereChofer2}
      `,
          paramsItems
        )
      )[0] || {};
    const items = Number(rowItems.q || 0);

    // Pedidos entregados
    const paramsPed = [empresa_id, desde, hasta];
    let whereChofer3 = '';
    if (chofer_id) {
      whereChofer3 = ' AND p.chofer_id = $4 ';
      paramsPed.push(chofer_id);
    }
    const rowPed =
      (
        await query(
          `
        SELECT COUNT(*) AS c
        FROM pedidos p
        JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        WHERE pe.empresa_id = $1
          AND DATE(COALESCE(p.fecha_entrega, p.fecha)) BETWEEN $2::date AND $3::date
          AND LOWER(p.estado) = 'entregado'
          ${whereChofer3}
      `,
          paramsPed
        )
      )[0] || {};
    const pedidosEntregados = Number(rowPed.c || 0);

    return {
      periodo: { desde, hasta },
      total_ventas,
      efectivo,
      transferencia,
      otros,
      items_entregados: items,
      pedidos_entregados: pedidosEntregados,
      ticket_promedio: pedidosEntregados
        ? total_ventas / pedidosEntregados
        : 0,
    };
  }
}

async function _sqlCOGSVentasRango({
  empresa_id,
  desde,
  hasta,
  chofer_id = null,
}) {
  const params = [empresa_id, desde, hasta];
  let whereChofer = '';
  if (chofer_id) {
    whereChofer = ' AND m.chofer_id = $4 ';
    params.push(chofer_id);
  }
  const row =
    (
      await query(
        `
      SELECT COALESCE(SUM(m.cantidad * COALESCE(c.costo_unitario, 0)), 0) AS cogs
      FROM chofer_stock_mov m
      LEFT JOIN chofer_costos c
        ON c.empresa_id = m.empresa_id
       AND c.chofer_id  = m.chofer_id
       AND c.producto_id= m.producto_id
      LEFT JOIN pedidos p ON p.id = m.ref_pedido_id
      WHERE m.empresa_id = $1
        AND DATE(m.fecha) BETWEEN $2::date AND $3::date
        AND m.tipo = 'venta'
        AND (p.id IS NULL OR LOWER(p.estado) = 'entregado')
        ${whereChofer}
    `,
        params
      )
    )[0] || {};
  return Number(row.cogs || 0);
}

async function _sqlGastosChofer({ empresa_id, chofer_id, desde, hasta }) {
  const row =
    (
      await query(
        `
    SELECT COALESCE(SUM(monto),0) AS total
    FROM gastos_repartidor
    WHERE empresa_id=$1 AND chofer_id=$2
      AND DATE(fecha) BETWEEN $3::date AND $4::date
  `,
        [empresa_id, chofer_id, desde, hasta]
      )
    )[0] || {};
  return Number(row.total || 0);
}

async function _sqlGastosEmpresa({ empresa_id, desde, hasta }) {
  const row =
    (
      await query(
        `
    SELECT COALESCE(SUM(monto),0) AS total
    FROM gastos_repartidor
    WHERE empresa_id=$1
      AND DATE(fecha) BETWEEN $2::date AND $3::date
  `,
        [empresa_id, desde, hasta]
      )
    )[0] || {};
  return Number(row.total || 0);
}

async function _sqlPagoChoferDia({ empresa_id, chofer_id, fecha }) {
  const row =
    (
      await query(
        `
    WITH entregas AS (
      SELECT COALESCE(SUM(it.cantidad),0) AS q
      FROM items_pedido it
      JOIN pedidos p          ON p.id = it.pedido_id
      JOIN puntos_entrega pe  ON pe.id = p.punto_entrega_id
      WHERE pe.empresa_id = $1
        AND p.chofer_id  = $2
        AND DATE(COALESCE(p.fecha_entrega, p.fecha)) = $3::date
        AND LOWER(p.estado) = 'entregado'
    ),
    escala_sel AS (
      SELECT ce.id
      FROM chofer_escalas ce
      WHERE ce.empresa_id = $4
        AND (ce.chofer_id = $5 OR ce.chofer_id IS NULL)
        AND $6::date BETWEEN DATE(ce.vigente_desde)
                         AND DATE(COALESCE(ce.vigente_hasta,'9999-12-31'))
      ORDER BY (ce.chofer_id IS NOT NULL) DESC, ce.vigente_desde DESC
      LIMIT 1
    ),
    monto_sel AS (
      SELECT t.monto
      FROM chofer_escala_tramos t
      JOIN entregas e ON TRUE
      JOIN escala_sel s ON t.escala_id = s.id
      WHERE e.q BETWEEN t.rango_min AND COALESCE(t.rango_max, 999999)
      LIMIT 1
    )
    SELECT
      (SELECT q FROM entregas) AS cantidad,
      COALESCE((SELECT monto FROM monto_sel), 0) AS pago
  `,
        [empresa_id, chofer_id, fecha, empresa_id, chofer_id, fecha]
      )
    )[0] || {};
  return {
    cantidad: Number(row.cantidad || 0),
    pago: Number(row.pago || 0),
  };
}

async function _sqlPagoChoferRango({ empresa_id, chofer_id, desde, hasta }) {
  const d0 = new Date(desde + 'T00:00:00');
  const d1 = new Date(hasta + 'T00:00:00');
  let pago = 0;
  let cantidad = 0;
  for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
    const f = _iso(d);
    const r = await _sqlPagoChoferDia({ empresa_id, chofer_id, fecha: f });
    pago += r.pago;
    cantidad += r.cantidad;
  }
  return { pago, cantidad };
}

async function _sqlPagoChoferEmpresa({ empresa_id, desde, hasta }) {
  const choferes = await query(
    `SELECT id FROM choferes WHERE empresa_id = $1`,
    [empresa_id]
  );

  // OPTIMIZACIÓN: Calculamos todos los choferes en paralelo (Promise.all)
  // Esto reduce drásticamente el tiempo de espera si hay muchos choferes.
  const resultados = await Promise.all(
    choferes.map(ch => 
      _sqlPagoChoferRango({
        empresa_id,
        chofer_id: ch.id,
        desde,
        hasta,
      })
    )
  );

  let total = 0;
  let entregas = 0;

  for (const r of resultados) {
    total += r.pago;
    entregas += r.cantidad;
  }

  return { pago_total: total, entregas_total: entregas };
}

async function _sqlTopProductos({
  empresa_id,
  desde,
  hasta,
  limit = 5,
}) {
  return await query(
    `
    SELECT p.id AS producto_id,
           p.nombre,
           COALESCE(SUM(m.cantidad),0) AS cantidad,
           COALESCE(SUM(COALESCE(m.monto, COALESCE(m.precio_unitario,0)*m.cantidad)),0) AS ingresos
    FROM productos p
    LEFT JOIN chofer_stock_mov m
      ON m.producto_id = p.id
     AND m.empresa_id  = p.empresa_id
     AND m.tipo = 'venta'
     AND DATE(m.fecha) BETWEEN $2::date AND $3::date
    WHERE p.empresa_id = $1
    GROUP BY 1,2
    ORDER BY cantidad DESC, ingresos DESC
    LIMIT $4
  `,
    [empresa_id, desde, hasta, limit]
  );
}

async function _sqlPorZona({ empresa_id, desde, hasta }) {
  return await query(
    `
    SELECT COALESCE(z.nombre, 'Sin zona') AS zona,
           COUNT(*) AS pedidos,
           COALESCE(SUM(p.monto),0) AS ingresos
    FROM pedidos p
    JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
    LEFT JOIN zonas_geograficas z ON z.id = pe.zona_id
    WHERE pe.empresa_id = $1
      AND DATE(COALESCE(p.fecha_entrega, p.fecha)) BETWEEN $2::date AND $3::date
      AND LOWER(p.estado) = 'entregado'
    GROUP BY 1
    ORDER BY ingresos DESC
  `,
    [empresa_id, desde, hasta]
  );
}

async function _sqlClientesNuevosRecurrentes({
  empresa_id,
  desde,
  hasta,
}) {
  const row =
    (
      await query(
        `
    WITH entregas AS (
      SELECT DISTINCT pe.id AS pe_id
      FROM pedidos p
      JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
      WHERE pe.empresa_id = $1
        AND DATE(COALESCE(p.fecha_entrega, p.fecha)) BETWEEN $2::date AND $3::date
        AND LOWER(p.estado)='entregado'
    ),
    prev AS (
      SELECT e.pe_id
      FROM entregas e
      JOIN pedidos p2 ON p2.punto_entrega_id = e.pe_id
      JOIN puntos_entrega pe2 ON pe2.id = p2.punto_entrega_id
      WHERE pe2.empresa_id = $1
        AND DATE(COALESCE(p2.fecha_entrega, p2.fecha)) < $2::date
    )
    SELECT
      (SELECT COUNT(*) FROM entregas)                                  AS clientes_rango,
      (SELECT COUNT(*) FROM entregas WHERE pe_id NOT IN (SELECT pe_id FROM prev)) AS nuevos
  `,
        [empresa_id, desde, hasta]
      )
    )[0] || {};
  const nuevos = Number(row.nuevos || 0);
  const clientes_rango = Number(row.clientes_rango || 0);
  return { nuevos, recurrentes: Math.max(0, clientes_rango - nuevos) };
}

async function _sqlStockEmpresaAl({ empresa_id, at, limit = 8 }) {
  return await query(
    `
    WITH mov AS (
      SELECT
        producto_id,
        SUM(CASE WHEN tipo='venta' THEN -cantidad ELSE cantidad END) AS saldo
      FROM chofer_stock_mov
      WHERE empresa_id = $1
        AND DATE(fecha) <= $2::date
      GROUP BY producto_id
    )
    SELECT p.nombre, COALESCE(m.saldo,0) AS saldo
    FROM productos p
    LEFT JOIN mov m ON m.producto_id = p.id
    WHERE p.empresa_id = $1
    ORDER BY p.nombre
    LIMIT $3
  `,
    [empresa_id, at, limit]
  );
}

async function _sqlStockChoferAl({ empresa_id, chofer_id, at }) {
  return await query(
    `
    WITH mov AS (
      SELECT
        producto_id,
        SUM(
          CASE
            WHEN tipo = 'venta' THEN -cantidad
            ELSE cantidad
          END
        ) AS saldo
      FROM chofer_stock_mov
      WHERE empresa_id = $1
        AND chofer_id  = $2
        AND DATE(fecha) <= $3::date
      GROUP BY producto_id
    )
    SELECT p.id   AS producto_id,
           p.nombre,
           COALESCE(m.saldo, 0) AS saldo
    FROM productos p
    LEFT JOIN mov m ON m.producto_id = p.id
    WHERE p.empresa_id = $1
    ORDER BY p.nombre
  `,
    [empresa_id, chofer_id, at]
  );
}

async function _seriesVentasEmpresa({ empresa_id, desde, hasta }) {
  const ventas = await query(
    `
    SELECT DATE(COALESCE(p.fecha_entrega, p.fecha)) AS f,
           COALESCE(SUM(COALESCE(p.monto,0)),0) AS total,
           COUNT(*) AS pedidos
    FROM pedidos p
    JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
    WHERE pe.empresa_id = $1
      AND DATE(COALESCE(p.fecha_entrega, p.fecha)) BETWEEN $2::date AND $3::date
      AND LOWER(p.estado)='entregado'
    GROUP BY 1
  `,
    [empresa_id, desde, hasta]
  );

  const items = await query(
    `
    SELECT DATE(COALESCE(p.fecha_entrega, p.fecha)) AS f,
           COALESCE(SUM(it.cantidad),0) AS q
    FROM items_pedido it
    JOIN pedidos p ON p.id = it.pedido_id
    JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
    WHERE pe.empresa_id = $1
      AND DATE(COALESCE(p.fecha_entrega, p.fecha)) BETWEEN $2::date AND $3::date
      AND LOWER(p.estado)='entregado'
    GROUP BY 1
  `,
    [empresa_id, desde, hasta]
  );

  const cogs = await query(
    `
    SELECT DATE(m.fecha) AS f,
           COALESCE(SUM(m.cantidad * COALESCE(c.costo_unitario,0)),0) AS cogs
    FROM chofer_stock_mov m
    LEFT JOIN chofer_costos c
      ON c.empresa_id=m.empresa_id AND c.chofer_id=m.chofer_id AND c.producto_id=m.producto_id
    LEFT JOIN pedidos p ON p.id = m.ref_pedido_id
    WHERE m.empresa_id=$1
      AND DATE(m.fecha) BETWEEN $2::date AND $3::date
      AND m.tipo='venta'
      AND (p.id IS NULL OR LOWER(p.estado)='entregado')
    GROUP BY 1
  `,
    [empresa_id, desde, hasta]
  );

  const gastos = await query(
    `
    SELECT DATE(fecha) AS f, COALESCE(SUM(monto),0) AS g
    FROM gastos_repartidor
    WHERE empresa_id=$1
      AND DATE(fecha) BETWEEN $2::date AND $3::date
    GROUP BY 1
  `,
    [empresa_id, desde, hasta]
  );

  const choferes = await query(
    `SELECT id FROM choferes WHERE empresa_id=$1`,
    [empresa_id]
  );

  const dias = _eachDate(desde, hasta);
  const pagoChoferPorDia = [];

  for (const dia of dias) {
    let sum = 0;
    for (const ch of choferes) {
      const r = await _sqlPagoChoferDia({
        empresa_id,
        chofer_id: ch.id,
        fecha: dia,
      });
      sum += r.pago;
    }
    pagoChoferPorDia.push({ f: dia, pago: sum });
  }

  const mapV = Object.fromEntries(ventas.map((r) => [r.f, r]));
  const mapI = Object.fromEntries(items.map((r) => [r.f, r]));
  const mapC = Object.fromEntries(cogs.map((r) => [r.f, r]));
  const mapG = Object.fromEntries(gastos.map((r) => [r.f, r]));
  const mapP = Object.fromEntries(pagoChoferPorDia.map((r) => [r.f, r]));

  const puntos = dias.map((f) => {
    const v = mapV[f]?.total || 0;
    const c = mapC[f]?.cogs || 0;
    const g = mapG[f]?.g || 0;
    const p = mapP[f]?.pago || 0;
    const rn = v - c - g - p;
    return {
      f,
      ventas: v,
      pedidos: mapV[f]?.pedidos || 0,
      items: mapI[f]?.q || 0,
      cogs: c,
      gastos: g,
      pagoChofer: p,
      rentNeta: rn,
    };
  });

  return { dias, puntos };
}

async function _seriesChofer({ empresa_id, chofer_id, desde, hasta }) {
  const ventas = await query(
    `
    SELECT DATE(COALESCE(p.fecha_entrega, p.fecha)) AS f,
           COALESCE(SUM(COALESCE(p.monto,0)),0) AS total,
           COUNT(*) AS pedidos
    FROM pedidos p
    JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
    WHERE pe.empresa_id = $1
      AND p.chofer_id = $2
      AND DATE(COALESCE(p.fecha_entrega, p.fecha)) BETWEEN $3::date AND $4::date
      AND LOWER(p.estado)='entregado'
    GROUP BY 1
  `,
    [empresa_id, chofer_id, desde, hasta]
  );

  const items = await query(
    `
    SELECT DATE(COALESCE(p.fecha_entrega, p.fecha)) AS f,
           COALESCE(SUM(it.cantidad),0) AS q
    FROM items_pedido it
    JOIN pedidos p ON p.id = it.pedido_id
    JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
    WHERE pe.empresa_id = $1
      AND p.chofer_id = $2
      AND DATE(COALESCE(p.fecha_entrega, p.fecha)) BETWEEN $3::date AND $4::date
      AND LOWER(p.estado)='entregado'
    GROUP BY 1
  `,
    [empresa_id, chofer_id, desde, hasta]
  );

  const cogs = await query(
    `
    SELECT DATE(m.fecha) AS f,
           COALESCE(SUM(m.cantidad * COALESCE(c.costo_unitario,0)),0) AS cogs
    FROM chofer_stock_mov m
    LEFT JOIN chofer_costos c
      ON c.empresa_id=m.empresa_id AND c.chofer_id=m.chofer_id AND c.producto_id=m.producto_id
    LEFT JOIN pedidos p ON p.id = m.ref_pedido_id
    WHERE m.empresa_id=$1
      AND m.chofer_id=$2
      AND DATE(m.fecha) BETWEEN $3::date AND $4::date
      AND m.tipo='venta'
      AND (p.id IS NULL OR LOWER(p.estado)='entregado')
    GROUP BY 1
  `,
    [empresa_id, chofer_id, desde, hasta]
  );

  const gastos = await query(
    `
    SELECT DATE(fecha) AS f, COALESCE(SUM(monto),0) AS g
    FROM gastos_repartidor
    WHERE empresa_id=$1
      AND chofer_id=$2
      AND DATE(fecha) BETWEEN $3::date AND $4::date
    GROUP BY 1
  `,
    [empresa_id, chofer_id, desde, hasta]
  );

  const dias = _eachDate(desde, hasta);
  const pagos = [];
  for (const fecha of dias) {
    const r = await _sqlPagoChoferDia({ empresa_id, chofer_id, fecha });
    pagos.push({ f: fecha, pago: r.pago, cant: r.cantidad });
  }

  const mapV = Object.fromEntries(ventas.map((r) => [r.f, r]));
  const mapI = Object.fromEntries(items.map((r) => [r.f, r]));
  const mapC = Object.fromEntries(cogs.map((r) => [r.f, r]));
  const mapG = Object.fromEntries(gastos.map((r) => [r.f, r]));
  const mapP = Object.fromEntries(pagos.map((r) => [r.f, r]));

  const puntos = dias.map((f) => {
    const v = mapV[f]?.total || 0;
    const c = mapC[f]?.cogs || 0;
    const g = mapG[f]?.g || 0;
    const p = mapP[f]?.pago || 0;
    const rn = v - c - g - p;
    return {
      f,
      ventas: v,
      pedidos: mapV[f]?.pedidos || 0,
      items: mapI[f]?.q || 0,
      cogs: c,
      gastos: g,
      pagoChofer: p,
      rentNeta: rn,
    };
  });

  return { dias, puntos };
}

// ────────────────────────────────────────────────────────────────────────────────
// Comprobantes (PostgreSQL)
// ────────────────────────────────────────────────────────────────────────────────

async function obtenerUltimosComprobantesPorTelefonoPg(telefono) {
  const digits = digitsOnly(telefono);
  const suf10 = digits.slice(-10) || digits;

  return await query(
    `
    SELECT
      id,
      fecha,
      monto,
      banco_origen,
      banco_destino,
      nro_operacion,
      nombre,
      fecha_operacion,
      fecha_transf
    FROM comprobantes_transferencia
    WHERE regexp_replace(COALESCE(telefono,''),'\\D','','g') LIKE '%' || $1
    ORDER BY fecha DESC, id DESC
    LIMIT 10
  `,
    [suf10]
  );
}

async function marcarComprobanteComoProcesadoPg(numeroOperacion) {
  const rows = await query(
    `
    UPDATE comprobantes_transferencia
    SET procesado = TRUE,
        fecha_procesado = NOW()
    WHERE nro_operacion = $1
    RETURNING id
  `,
    [numeroOperacion]
  );
  return rows.length;
}


// ────────────────────────────────────────────────────────────────────────────────
// Handlers de negocio
// ────────────────────────────────────────────────────────────────────────────────

async function handleRentabilidadEmpresa(
  client,
  numero,
  ctx,
  contenidoLimpio
) {
  const rango = _parseRangoFechas(contenidoLimpio);
  const empresaEff = _parseEmpresaId(contenidoLimpio, ctx.empresa_id);

  const base = await _sqlResumenVentas({
    empresa_id: empresaEff,
    desde: rango.desde,
    hasta: rango.hasta,
  });
  const cogs = await _sqlCOGSVentasRango({
    empresa_id: empresaEff,
    desde: rango.desde,
    hasta: rango.hasta,
  });
  const gastos = await _sqlGastosEmpresa({
    empresa_id: empresaEff,
    desde: rango.desde,
    hasta: rango.hasta,
  });
  const pagoChofer = await _sqlPagoChoferEmpresa({
    empresa_id: empresaEff,
    desde: rango.desde,
    hasta: rango.hasta,
  });

  const margenBruto = base.total_ventas - cogs;
  const margenBrutoPct = base.total_ventas
    ? (margenBruto / base.total_ventas) * 100
    : 0;
  const rentNeta =
    base.total_ventas - cogs - gastos - pagoChofer.pago_total;
  const rentNetaPct = base.total_ventas
    ? (rentNeta / base.total_ventas) * 100
    : 0;

  const serie = await _seriesVentasEmpresa({
    empresa_id: empresaEff,
    desde: rango.desde,
    hasta: rango.hasta,
  });
  const serieRent = serie.puntos.map((p) => p.rentNeta);
  const serieItems = serie.puntos.map((p) => p.items);

  const minR = Math.min(...serieRent, 0);
  const maxR = Math.max(...serieRent, 0);
  const minI = Math.min(...serieItems, 0);
  const maxI = Math.max(...serieItems, 0);

  const msg = [
    `*Rentabilidad ${rango.desde}.${rango.hasta} (empresa ${empresaEff})*`,
    `Ingresos: *${_money(
      base.total_ventas
    )}* (Efec: ${_money(base.efectivo)} · Transf: ${_money(
      base.transferencia
    )}${base.otros ? ` · Otros: ${_money(base.otros)}` : ''})`,
    `COGS: *${_money(
      cogs
    )}* |  Margen bruto: *${_money(margenBruto)}* (${margenBrutoPct.toFixed(
      1
    )}%)`,
    `Gastos: *${_money(
      gastos
    )}* |  Pago repartidores: *${_money(pagoChofer.pago_total)}*`,
    `Rentabilidad neta: *${_money(rentNeta)}* (${rentNetaPct.toFixed(1)}%)`,
    '',
    `Cantidad (items por día):`,
    _spark(serieItems),
    `min.max: ${minI.toFixed(0)} . ${maxI.toFixed(0)}`,
    '',
    `Rentabilidad (neta por día):`,
    _spark(serieRent),
    `min.max: ${_money(minR)} . ${_money(maxR)}`,
  ].join('\n');

  await client.sendMessage(numero, msg);
}

async function handleEstadisticaEmpresa(
  client,
  numero,
  ctx,
  contenidoLimpio
) {
  const rango = _parseRangoFechas(contenidoLimpio);
  const empresaEff = _parseEmpresaId(contenidoLimpio, ctx.empresa_id);

  const base = await _sqlResumenVentas({
    empresa_id: empresaEff,
    desde: rango.desde,
    hasta: rango.hasta,
  });
  const topProd = await _sqlTopProductos({
    empresa_id: empresaEff,
    desde: rango.desde,
    hasta: rango.hasta,
    limit: 5,
  });
  const zonas = await _sqlPorZona({
    empresa_id: empresaEff,
    desde: rango.desde,
    hasta: rango.hasta,
  });
  const cli = await _sqlClientesNuevosRecurrentes({
    empresa_id: empresaEff,
    desde: rango.desde,
    hasta: rango.hasta,
  });
  const stock = await _sqlStockEmpresaAl({
    empresa_id: empresaEff,
    at: rango.hasta,
    limit: 8,
  });

  const serie = await _seriesVentasEmpresa({
    empresa_id: empresaEff,
    desde: rango.desde,
    hasta: rango.hasta,
  });
  const serieItems = serie.puntos.map((p) => p.items);
  const serieRent = serie.puntos.map((p) => p.rentNeta);
  const minI = Math.min(...serieItems, 0);
  const maxI = Math.max(...serieItems, 0);
  const minR = Math.min(...serieRent, 0);
  const maxR = Math.max(...serieRent, 0);

  const topLines = topProd.length
    ? topProd
        .map(
          (r) =>
            `  · ${r.nombre}: ${r.cantidad} (${_money(r.ingresos)})`
        )
        .join('\n')
    : '  · (sin ventas)';

  const zonaLines = zonas.length
    ? zonas
        .map(
          (z) =>
            `  · ${z.zona}: ${z.pedidos} (${_money(z.ingresos)})`
        )
        .join('\n')
    : '  · (sin datos)';

  const stockLines = stock
    .map((s) => `  · ${s.nombre}: ${s.saldo}`)
    .join('\n');

  const msg = [
    `*Estadística ${rango.desde}.${rango.hasta} (empresa ${empresaEff})*`,
    `Pedidos entregados: *${base.pedidos_entregados}* |  Ticket promedio: *${_money(
      base.ticket_promedio
    )}*`,
    `Artículos entregados: *${
      base.items_entregados
    }* |  Mix: Efec ${_money(base.efectivo)} · Transf ${_money(
      base.transferencia
    )}${base.otros ? ` · Otros ${_money(base.otros)}` : ''}`,
    '',
    `Gráfico cantidad (items/día):`,
    _spark(serieItems),
    `min.max: ${minI.toFixed(0)} . ${maxI.toFixed(0)}`,
    '',
    `Gráfico rentabilidad (neta/día):`,
    _spark(serieRent),
    `min.max: ${_money(minR)} . ${_money(maxR)}`,
    '',
    `Top productos:`,
    topLines,
    '',
    `Por zona:`,
    zonaLines,
    '',
    `Stock actual (al ${rango.hasta}):`,
    stockLines,
    '',
    `Clientes: nuevos *${cli.nuevos}* · recurrentes *${cli.recurrentes}*`,
  ].join('\n');

  await client.sendMessage(numero, msg);
}

async function handleResumen(
  client,
  numero,
  { role, empresa_id, chofer_id },
  contenidoLimpio
) {
  const rango = _parseRangoFechas(contenidoLimpio);
  const tieneChoferArg = /chofer\s+([0-9]{7,}|[0-9]+)/i.test(
    contenidoLimpio
  );
  let choferFiltro = null;

  if (role === 'super' && tieneChoferArg) {
    const m = contenidoLimpio.match(
      /chofer\s+([0-9]{7,}|[0-9]+)/i
    );
    const val = m?.[1] || '';
    const valDigits = digitsOnly(val);
    const byId =
      (
        await query(`SELECT id FROM choferes WHERE id = $1`, [
          Number(val),
        ])
      )[0] || null;
    const byTel =
      (
        await query(
          `
        SELECT id
        FROM choferes
        WHERE regexp_replace(COALESCE(telefono,''),'\\D','','g') LIKE '%' || $1
        LIMIT 1
      `,
          [valDigits]
        )
      )[0] || null;
    const target = byId || byTel;
    if (target) choferFiltro = Number(target.id);
  }

  const base = await _sqlResumenVentas({
    empresa_id,
    desde: rango.desde,
    hasta: rango.hasta,
    chofer_id: role === 'repartidor' ? chofer_id : choferFiltro,
  });

  let msg;
  const choferParaExtra =
    role === 'repartidor' ? chofer_id : choferFiltro || null;

  if (choferParaExtra) {
    const gastos = await _sqlGastosChofer({
      empresa_id,
      chofer_id: choferParaExtra,
      desde: rango.desde,
      hasta: rango.hasta,
    });
    const pago = await _sqlPagoChoferRango({
      empresa_id,
      chofer_id: choferParaExtra,
      desde: rango.desde,
      hasta: rango.hasta,
    });
    const stock = await _sqlStockChoferAl({
      empresa_id,
      chofer_id: choferParaExtra,
      at: rango.hasta,
    });

    const serie = await _seriesChofer({
      empresa_id,
      chofer_id: choferParaExtra,
      desde: rango.desde,
      hasta: rango.hasta,
    });
    const serieItems = serie.puntos.map((p) => p.items);

    const puedeVerRentChofer = role === 'super';
    const serieRent = puedeVerRentChofer
      ? serie.puntos.map((p) => p.rentNeta)
      : [];

    const minI = Math.min(...serieItems, 0);
    const maxI = Math.max(...serieItems, 0);

    const lines = [
      `*Resumen ${rango.desde}.${rango.hasta} (Chofer ${choferParaExtra})*`,
      `Ventas: *${_money(base.total_ventas)}*`,
      `  · Efectivo: ${_money(base.efectivo)} · Transferencia: ${_money(
        base.transferencia
      )}${base.otros ? ` · Otros: ${_money(base.otros)}` : ''}`,
      `Artículos entregados: *${base.items_entregados}*`,
      `Gastos chofer: *${_money(gastos)}*`,
      `Pago chofer (escala): *${_money(pago.pago)}*`,
      '',
      `Gráfico cantidad (items/día):`,
      _spark(serieItems),
      `min.max: ${minI.toFixed(0)} . ${maxI.toFixed(0)}`,
    ];

    if (puedeVerRentChofer && serieRent.length) {
      const minR = Math.min(...serieRent, 0);
      const maxR = Math.max(...serieRent, 0);
      const rentNetaTotal = serieRent.reduce(
        (a, b) => a + b,
        0
      );
      lines.push(
        '',
        `Gráfico rentabilidad (neta/día):`,
        _spark(serieRent),
        `min.max: ${_money(minR)} . ${_money(maxR)}`,
        '',
        `Rentabilidad neta (empresa, chofer): *${_money(
          rentNetaTotal
        )}*`
      );
    }

    if (stock.length) {
      lines.push(
        '',
        `Stock actual (al ${rango.hasta}):`,
        ...stock.map((s) => `  · ${s.nombre}: ${s.saldo}`)
      );
    }

    msg = lines.join('\n');
  } else {
    const encabezado = `*Resumen ${rango.desde}.${rango.hasta}*`;
    msg = [
      encabezado,
      `Ventas: *${_money(base.total_ventas)}*`,
      `  · Efectivo: ${_money(base.efectivo)} · Transferencia: ${_money(
        base.transferencia
      )}${base.otros ? ` · Otros: ${_money(base.otros)}` : ''}`,
      `Artículos entregados: *${base.items_entregados}*`,
    ].join('\n');
  }

  await client.sendMessage(numero, msg);
}

// ────────────────────────────────────────────────────────────────────────────────
// Menú por rol (único comando común: "ayuda")
// ────────────────────────────────────────────────────────────────────────────────

function menuPorRol(role) {
  if (role === 'super') {
    return [
      '🧭 *Menú (Súper)*',
      '- ver pedidos',
      '- procesar op 123456',
      '- resumen [fecha|rango] [chofer <id|tel>]',
      '- rentabilidad [fecha|rango] [empresa <id>]',
      '- estadistica [fecha|rango] [empresa <id>]',
      '',
      'Fechas: hoy | ayer | YYYY-MM-DD | YYYY-MM-DD.YYYY-MM-DD',
    ].join('\n');
  }
  if (role === 'repartidor') {
    return [
      '🧭 *Menú (Repartidor)*',
      '- ver pedidos',
      '- ver comprobantes',
      '- resumen [hoy|ayer|fecha|rango]  (solo tus datos)',
      '',
      'Nota: rentabilidad no disponible para repartidor.',
    ].join('\n');
  }
  // cliente
  return [
    '🧭 *Menú (Cliente)*',
    '- ver pedidos',
    '- ver comprobantes',
    'o escribime lo que necesitás y te ayudo 😉',
    '',
    'Tip: "pedido | cantidad | forma | dirección"',
  ].join('\n');
}

// --------------------------------------------------------------------------------
// Lógica del "Botón de Pánico" (Reposición Automática)
// --------------------------------------------------------------------------------

async function handleReposicionAutomatica(client, numero, ctx) {
  try {
    // 1. Identificar al cliente real en la base de datos
    // Usamos el teléfono normalizado para buscar el punto de entrega
    const telDigits = digitsOnly(phoneFromWaId(numero));
    const suf10 = telDigits.slice(-10) || telDigits;

    // Buscamos el punto de entrega más reciente usado por este teléfono
    const pRows = await query(`
      SELECT id, cliente, direccion, empresa_id, zona_id
      FROM puntos_entrega
      WHERE regexp_replace(COALESCE(telefono,''),'\\D','','g') LIKE '%' || $1
      ORDER BY id DESC
      LIMIT 1
    `, [suf10]);

    if (!pRows.length) {
      await client.sendMessage(numero, '😕 No encontré una cuenta vinculada a este teléfono. Por favor, escribinos qué necesitás para tomar tu primer pedido.');
      return;
    }
    
    const punto = pRows[0];

    // 2. Anti-Duplicados: Chequear si ya tiene algo pendiente
    const pendientes = await query(`
      SELECT id FROM pedidos 
      WHERE punto_entrega_id = $1 
        AND estado IN ('pendiente', 'en_ruta', 'en_camino')
    `, [punto.id]);

    if (pendientes.length > 0) {
      await client.sendMessage(numero, `✋ Ya tenés el pedido #${pendientes[0].id} en curso. ¡Te lo llevamos pronto!`);
      return;
    }

    // 3. Buscar el ÚLTIMO pedido entregado para clonar
    const lastOrderRows = await query(`
      SELECT id, metodo_pago 
      FROM pedidos 
      WHERE punto_entrega_id = $1 AND estado = 'entregado'
      ORDER BY id DESC 
      LIMIT 1
    `, [punto.id]);

    if (!lastOrderRows.length) {
      await client.sendMessage(numero, '📝 Vemos que es tu primera vez o hace mucho no pedís. Por favor escribime qué productos necesitás.');
      return;
    }

    const lastPedido = lastOrderRows[0];

    // 4. Traer los ítems de ese pedido
    const items = await query(`
      SELECT producto, cantidad, precio_unitario 
      FROM items_pedido 
      WHERE pedido_id = $1
    `, [lastPedido.id]);

    if (!items.length) {
      await client.sendMessage(numero, 'Hubo un error leyendo tu historial. Por favor pedí escribiendo el producto.');
      return;
    }

    // 5. Calcular nuevo total (usando precios históricos o actuales, aquí usamos históricos por simplicidad,
    // pero lo ideal sería buscar el precio actual en la tabla productos)
    let totalMonto = 0;
    let totalCant = 0;
    let resumenItems = [];

    // Opcional: Actualizar precios al valor actual de la tabla productos
    for (let it of items) {
        // Intentar buscar precio actual
        const prodAct = await query(
            'SELECT precio FROM productos WHERE empresa_id=$1 AND LOWER(nombre) = LOWER($2) LIMIT 1', 
            [punto.empresa_id, it.producto]
        );
        const precioReal = prodAct.length ? Number(prodAct[0].precio) : Number(it.precio_unitario);
        
        it.precio_nuevo = precioReal;
        totalMonto += (it.cantidad * precioReal);
        totalCant += Number(it.cantidad);
        resumenItems.push(`${it.cantidad} x ${it.producto}`);
    }

    // 6. CREAR EL PEDIDO (INSERT)
    const newOrder = await query(`
      INSERT INTO pedidos (
        empresa_id, punto_entrega_id, fecha, estado,
        cantidad, cantidad_entregada, monto,
        metodo_pago, aviso_recibido, sats,
        chofer_id, zona_id, created_at, updated_at
      )
      VALUES ($1, $2, NOW(), 'pendiente', $3, 0, $4, $5, 0, 0, NULL, $6, NOW(), NOW())
      RETURNING id
    `, [
      punto.empresa_id,
      punto.id,
      totalCant,
      totalMonto,
      lastPedido.metodo_pago, // Mantenemos mismo método de pago
      punto.zona_id
    ]);

    const newId = newOrder[0].id;

    // 7. Insertar Ítems
    for (let it of items) {
      await query(`
        INSERT INTO items_pedido (pedido_id, producto, cantidad, precio_unitario)
        VALUES ($1, $2, $3, $4)
      `, [newId, it.producto, it.cantidad, it.precio_nuevo]);
    }

    // 8. Confirmar al Cliente
    const textoItems = resumenItems.join('\n');
    const msg = [
      `🚀 *¡Reposición Automática Generada!*`,
      `Pedido #${newId} confirmado.`,
      `📍 Dirección: ${punto.direccion}`,
      `📦 Pedido:`,
      textoItems,
      `💰 Total estimado: $${totalMonto}`,
      ``,
      `Si querés cambiar algo, escribime ahora.`
    ].join('\n');

    await client.sendMessage(numero, msg);

  } catch (e) {
    console.error('Error Reposición Automática:', e);
    await client.sendMessage(numero, 'Tuve un problema procesando la reposición. Por favor escribime con un humano.');
  }
}

// --------------------------------------------------------------------------------
// Router principal
// --------------------------------------------------------------------------------

function start(client) {
  client.on('message', async (message) => {
    try {
      // Ignorar mensajes propios o de estado
      if (
        message.fromMe ||
        message.id?.fromMe === true ||
        message._data?.id?.fromMe === true
      )
        return;
      
      // Ignorar grupos
      if (message.from?.endsWith('@g.us')) return;

      const numero = message.from;
      const contenido = (message.body || '').trim();
      
      // Si es media, lo maneja whatsapp.js (pipeline), aquí ignoramos si no hay texto
      if (message.hasMedia === true) return;
      if (!contenido) return;

      const ctx = await _resolverContextoDesdeTelefono(numero);
      const { role, empresa_id, chofer_id } = ctx;
      const contenidoLimpio = contenido.toLowerCase();

      // 👮 Bloqueo de seguridad: repartidor NO puede pedir "rentabilidad"
      if (
        role === 'repartidor' &&
        contenidoLimpio.startsWith('rentabilidad')
      ) {
        await client.sendMessage(
          numero,
          'No tenés permiso para ver rentabilidad. Usá "resumen" para ver tus entregas y montos.'
        );
        return;
      }

      // ── Comandos explícitos ───────────────────────────────────────────────

      if (contenidoLimpio === 'ayuda') {
        await client.sendMessage(numero, menuPorRol(role));
        return;
      }

      // 🚨 ESTRATEGIA: BOTÓN DE PÁNICO (REPOSICIÓN) 🚨
      // Detecta la frase clave del QR y clona el último pedido
      if (
        contenidoLimpio.includes('necesitas reposición') || 
        contenidoLimpio.includes('necesitas reposicion')
      ) {
        await handleReposicionAutomatica(client, numero, ctx);
        return; // IMPORTANTE: Cortamos aquí para que la IA no responda encima
      }

      if (contenidoLimpio === 'ver pedidos') {
        let pedidos;
        if (role === 'repartidor') {
          pedidos = await query(
            `
            SELECT p.id, p.fecha, p.estado, p.cantidad, p.monto, p.metodo_pago,
                   pe.cliente, pe.direccion
            FROM pedidos p
            JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
            WHERE pe.empresa_id = $1
              AND p.chofer_id = $2
            ORDER BY DATE(COALESCE(p.fecha_entrega, p.fecha)) DESC, p.id DESC
            LIMIT 20
          `,
            [empresa_id, chofer_id]
          );
        } else if (role === 'super') {
          pedidos = await query(
            `
            SELECT p.id, p.fecha, p.estado, p.cantidad, p.monto, p.metodo_pago,
                   pe.cliente, pe.direccion
            FROM pedidos p
            JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
            WHERE pe.empresa_id = $1
            ORDER BY DATE(COALESCE(p.fecha_entrega, p.fecha)) DESC, p.id DESC
            LIMIT 20
          `,
            [empresa_id]
          );
        } else {
          // Cliente
          const telDigits = digitsOnly(phoneFromWaId(numero));
          const suf10 = telDigits.slice(-10) || telDigits;
          pedidos = await query(
            `
            SELECT p.id, p.fecha, p.estado, p.cantidad, p.monto, p.metodo_pago,
                   pe.cliente, pe.direccion
            FROM pedidos p
            JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
            WHERE pe.empresa_id = $1
              AND regexp_replace(COALESCE(pe.telefono,''),'\\D','','g') LIKE '%' || $2
            ORDER BY DATE(COALESCE(p.fecha_entrega, p.fecha)) DESC, p.id DESC
            LIMIT 20
          `,
            [empresa_id, suf10]
          );
        }

        if (!pedidos?.length) {
          await client.sendMessage(
            numero,
            role === 'cliente'
              ? 'Consulté tus pedidos y no encontré ninguno reciente.'
              : 'No encontré pedidos para mostrar.'
          );
          return;
        }

        const resumen = pedidos
          .slice(0, 5)
          .map(
            (p) =>
              `🧾 *${p.cliente}*\n📍 ${
                p.direccion
              }\n📦 ${p.cantidad ?? '-'}\n💰 ${_money(
                p.monto ?? 0
              )} (${p.metodo_pago || 'N/D'})\n🗓️ ${_iso(new Date(p.fecha))}\n🔖 ${
                p.estado
              }`
          )
          .join('\n\n');
        await client.sendMessage(
          numero,
          `📋 Últimos pedidos:\n\n${resumen}`
        );
        return;
      }

      if (contenidoLimpio === 'ver comprobantes') {
        try {
          const tel = phoneFromWaId(numero);
          const comprobantes = await obtenerUltimosComprobantesPorTelefonoPg(tel);
          
          if (!comprobantes?.length) {
            await client.sendMessage(numero, 'No hay comprobantes registrados para tu número.');
            return;
          }
          
          const texto = comprobantes
            .map((c) => {
              const fecha = c.fecha_operacion || c.fecha_transf || c.fecha || '';
              const op = c.nro_operacion || c.id || '';
              const monto = c.monto != null ? Number(c.monto) : 0;
              return `🧾 *${c.nombre || 'Comprobante'}*\n💰 ${_money(monto)}\n🏦 ${c.banco_origen || 'N/D'} → ${c.banco_destino || 'N/D'}\n🗓️ ${fecha}\n🔢 Op: ${op}`;
            })
            .join('\n\n');
            
          await client.sendMessage(numero, `📋 Tus últimos comprobantes:\n\n${texto}`);
        } catch (err) {
          console.error('Error al obtener comprobantes:', err);
          await client.sendMessage(numero, 'Ocurrió un error al consultar comprobantes.');
        }
        return;
      }

      if (contenidoLimpio.startsWith('procesar op')) {
        if (role !== 'super') {
          await client.sendMessage(numero, 'No tenés permisos para procesar comprobantes.');
          return;
        }
        const match = contenido.match(/procesar op\s+(\S+)/i);
        if (!match) {
          await client.sendMessage(numero, 'Formato inválido. Usá: *procesar op 123456*');
          return;
        }
        const numeroOperacion = match[1];
        try {
          const cambios = await marcarComprobanteComoProcesadoPg(numeroOperacion);
          await client.sendMessage(
            numero,
            cambios > 0
              ? `✅ Marqué como procesado el comprobante con operación ${numeroOperacion}.`
              : `⚠️ No encontré ningún comprobante con operación ${numeroOperacion}.`
          );
        } catch (err) {
          console.error('Error procesando comprobante:', err);
          await client.sendMessage(numero, '❌ No pude procesar ese comprobante por un error interno.');
        }
        return;
      }

      // Empresa (solo super)
      if (contenidoLimpio.startsWith('rentabilidad')) {
        if (role !== 'super') {
          await client.sendMessage(numero, 'No tengo permiso para mostrar rentabilidad.');
          return;
        }
        await handleRentabilidadEmpresa(client, numero, { empresa_id, chofer_id }, contenidoLimpio);
        return;
      }

      if (contenidoLimpio.startsWith('estadistica')) {
        if (role !== 'super') {
          await client.sendMessage(numero, 'No tengo permiso para ver estadísticas.');
          return;
        }
        await handleEstadisticaEmpresa(client, numero, { empresa_id, chofer_id }, contenidoLimpio);
        return;
      }

      // Resumen (super / repartidor) — CON CORRECCIÓN DE SEGURIDAD
      if (contenidoLimpio.startsWith('resumen')) {
        // Bloquear si es repartidor intentando ver a otro chofer
        if (role === 'repartidor' && /\bchofer\s+\S+/.test(contenidoLimpio)) {
          await client.sendMessage(
            numero,
            '⛔ No tenés permisos para ver otros choferes. Escribí solo "resumen" para ver tus datos.'
          );
          return; // <--- IMPRESCINDIBLE PARA DETENER LA EJECUCIÓN
        }
        
        await handleResumen(client, numero, { role, empresa_id, chofer_id }, contenidoLimpio);
        return;
      }

      // ── Fallback a IA (promptVendedor) ────────────────────────────────────
      await responderConIA(client, numero, contenido, ctx);

    } catch (err) {
      console.error('handlers.start error:', err);
      // Evitamos responder si el error es grave para no hacer loop
    }
  });
}

export default { start };