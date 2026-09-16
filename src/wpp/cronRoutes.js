export function registerWppCronAndRoutes(app, deps) {
  const {
    query,
    ejecutarReposicionPredictiva,
    ejecutarCampaniaClima,
    ejecutarCampaniaBaseImportadaAuto,
    ejecutarReactivacionInteligente,
    ejecutarPostEntregaUpsell,
    ejecutarProgramaVip,
    timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  } = deps;

  const timeoutIds = new Set();
  const intervalIds = new Set();
  const activeWork = new Set();
  let stopped = false;
  let stopPromise = null;

  function runTask(task) {
    if (stopped) return false;
    let work;
    try {
      work = Promise.resolve(task());
    } catch (error) {
      work = Promise.reject(error);
    }
    activeWork.add(work);
    work.then(
      () => activeWork.delete(work),
      () => activeWork.delete(work),
    );
    return work;
  }

  function scheduleInterval(task, milliseconds) {
    const intervalId = timers.setInterval(() => {
      if (!stopped) runTask(task);
    }, milliseconds);
    intervalIds.add(intervalId);
    return intervalId;
  }

  const ARG_UTC_OFFSET = -3;

  function programarTareaDiaria(horaArgentina, minuto, tarea) {
    const ahora = new Date();
    const proximaEjecucion = new Date(ahora);
    const diferenciaHoras = -ARG_UTC_OFFSET;
    const horaUTC = (horaArgentina + diferenciaHoras + 24) % 24;

    proximaEjecucion.setUTCHours(horaUTC, minuto, 0, 0);
    if (proximaEjecucion <= ahora) {
      proximaEjecucion.setUTCDate(proximaEjecucion.getUTCDate() + 1);
    }

    const tiempoHastaEjecucion = proximaEjecucion.getTime() - ahora.getTime();

    console.log('[CRON] Tarea diaria programada para (ARG):', proximaEjecucion.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }));

    let timeoutId;
    timeoutId = timers.setTimeout(() => {
      timeoutIds.delete(timeoutId);
      if (stopped) return;
      runTask(tarea);
      if (!stopped) scheduleInterval(tarea, 24 * 60 * 60 * 1000);
    }, tiempoHastaEjecucion);
    timeoutIds.add(timeoutId);
  }

  programarTareaDiaria(4, 0, async () => {
    console.log('[CRON] Verificando licencias vencidas...');
    try {
      const expired = await query(`
        UPDATE empresas
        SET plan_estado = 'expired'
        WHERE plan_estado = 'active'
          AND plan_vencimiento < NOW()
        RETURNING id
      `);

      if (expired.length > 0) {
        console.log(`[CRON] Se vencieron ${expired.length} licencias hoy (pasaron a estado 'expired').`);
      }

      const dead = await query(`
        DELETE FROM empresas
        WHERE plan_vencimiento < (NOW() - INTERVAL '180 days')
        RETURNING id, nombre
      `);

      if (dead.length > 0) {
        console.log(`[CRON] 💀 LIMPIEZA TOTAL: Se eliminaron ${dead.length} empresas abandonadas hace >6 meses.`);
        dead.forEach((d) => console.log(` - Eliminada: ID ${d.id} (${d.nombre})`));
      } else {
        console.log('[CRON] Limpieza: No hay empresas antiguas para eliminar hoy.');
      }
    } catch (e) {
      console.error('[CRON ERROR] Falló la auditoría de licencias:', e);
    }
  });

  programarTareaDiaria(9, 0, () => {
    if (typeof ejecutarReposicionPredictiva !== 'function') return;
    console.log('[CRON] Ejecutando Reposición Predictiva...');
    return ejecutarReposicionPredictiva().catch((err) => console.error('[CRON ERROR]', err));
  });

  programarTareaDiaria(10, 0, () => {
    if (typeof ejecutarReactivacionInteligente !== 'function') return;
    console.log('[CRON] Ejecutando Reactivación Inteligente...');
    return ejecutarReactivacionInteligente().catch((err) => console.error('[CRON ERROR REACTIVACION]', err));
  });

  programarTareaDiaria(10, 30, () => {
    if (typeof ejecutarProgramaVip !== 'function') return;
    console.log('[CRON] Ejecutando Programa VIP...');
    return ejecutarProgramaVip().catch((err) => console.error('[CRON ERROR VIP]', err));
  });

  programarTareaDiaria(11, 0, () => {
    if (typeof ejecutarCampaniaClima !== 'function') return;
    console.log('[CRON] Ejecutando Campaña por Clima...');
    return ejecutarCampaniaClima().catch((err) => console.error('[CRON ERROR CLIMA]', err));
  });

  programarTareaDiaria(17, 0, () => {
    if (typeof ejecutarCampaniaClima !== 'function') return;
    console.log('[CRON] Ejecutando Campaña por Clima...');
    return ejecutarCampaniaClima().catch((err) => console.error('[CRON ERROR CLIMA]', err));
  });

  scheduleInterval(() => {
    if (typeof ejecutarCampaniaBaseImportadaAuto !== 'function') return;
    return ejecutarCampaniaBaseImportadaAuto().catch((err) => console.error('[CRON ERROR BASE_AUTO]', err));
  }, 15 * 60 * 1000);

  scheduleInterval(() => {
    if (typeof ejecutarPostEntregaUpsell !== 'function') return;
    return ejecutarPostEntregaUpsell().catch((err) => console.error('[CRON ERROR POSTENTREGA]', err));
  }, 30 * 60 * 1000);

  const requireCronSecret = (req, res) => {
    const cronSecret = String(process.env.CRON_SECRET || '').trim();
    if (!cronSecret) return res.status(503).json({ error: 'cron_secret_not_configured' });
    if (String(req.headers['x-cron-secret'] || '') !== cronSecret) return res.status(403).json({ error: 'forbidden' });
    return null;
  };

  app.post('/internal/cron/cleanup-tracking', async (req, res) => {
    const authError = requireCronSecret(req, res);
    if (authError) return authError;

    try {
      console.log('[CRON CLEANUP] Iniciando limpieza de tracking…');
      const deleted = await query(`
        DELETE FROM pedido_track_points ptk
        USING pedidos p
        WHERE ptk.pedido_id = p.id
          AND p.estado = 'entregado'
          AND ptk."timestamp" < NOW() - INTERVAL '1 day'
        RETURNING ptk.id
      `);
      console.log(`[CRON CLEANUP] Puntos de tracking borrados: ${deleted.length}`);
      return res.json({ ok: true, deleted: deleted.length });
    } catch (err) {
      console.error('cleanup-tracking ERROR', err);
      return res.status(500).json({ error: 'error' });
    }
  });

  app.post('/internal/cron/cleanup-wpp', async (req, res) => {
    const authError = requireCronSecret(req, res);
    if (authError) return authError;

    try {
      console.log('[CRON CLEANUP WPP] Iniciando limpieza de wpp_outbox…');
      const deleted = await query(`
        DELETE FROM wpp_outbox
        WHERE status IN ('sent', 'error', 'skipped')
          AND created_at < NOW() - INTERVAL '7 days'
        RETURNING id
      `);
      const count = deleted.length;
      if (count > 0) {
        console.log(`[CRON CLEANUP WPP] Se borraron ${count} mensajes viejos de WhatsApp.`);
      } else {
        console.log('[CRON CLEANUP WPP] No había mensajes para borrar.');
      }
      return res.json({ ok: true, deleted: count });
    } catch (err) {
      console.error('cleanup-wpp ERROR', err);
      return res.status(500).json({ error: 'error al limpiar wpp' });
    }
  });

  function stop() {
    if (stopPromise) return stopPromise;
    let resolveStop;
    let rejectStop;
    stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    stopPromise.catch(() => {});
    stopped = true;
    let stopError = null;
    for (const timeoutId of timeoutIds) {
      try { timers.clearTimeout(timeoutId); } catch (error) { stopError ??= error; }
    }
    for (const intervalId of intervalIds) {
      try { timers.clearInterval(intervalId); } catch (error) { stopError ??= error; }
    }
    timeoutIds.clear();
    intervalIds.clear();
    Promise.allSettled([...activeWork]).then(() => {
      if (stopError) rejectStop(stopError);
      else resolveStop(true);
    });
    return stopPromise;
  }

  return { stop, shutdown: stop };
}
