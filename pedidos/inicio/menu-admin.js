/* Scheduled menus: explicit, tenant-scoped administrative drafts. */
(() => {
  'use strict';
  const q = (s, root = document) => root.querySelector(s);
  const styles = document.createElement('style');
  styles.textContent = `
 .menu-editor{border:1px solid var(--border);border-radius:12px;padding:16px;min-width:0;background:rgba(6,182,212,.04)}
 .menu-editor [hidden]{display:none!important}.menu-editor fieldset{min-width:0;margin:12px 0;padding:12px;border:1px solid var(--border);border-radius:8px}
 .menu-editor legend{color:var(--brand);font-weight:700}.menu-editor label{display:block;text-transform:none;letter-spacing:normal;font-size:.85rem;margin:8px 0}
 .menu-editor input,.menu-editor select,.menu-editor textarea{max-width:100%;min-width:0;margin:4px 0}
 .menu-editor input[type=checkbox]{width:auto;margin-right:6px}.menu-editor .menu-days{display:flex;gap:8px;flex-wrap:wrap}.menu-editor .menu-days label{display:flex;align-items:center}
 .menu-editor .menu-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.menu-editor button{white-space:normal;min-height:42px}
 .menu-editor small,.menu-editor p{line-height:1.5;overflow-wrap:anywhere}.menu-editor :focus-visible{outline:2px solid var(--brand);outline-offset:3px}
 .modal-body{min-height:0;flex:1 1 auto}.modal-header,.modal-footer{flex-shrink:0}.modal{min-width:0}.modal-footer button{white-space:normal}
 @media(max-width:600px){.menu-editor .menu-grid{grid-template-columns:1fr}.menu-editor{padding:10px}.modal{max-height:calc(100dvh - 20px)}.modal-header,.modal-footer{padding:10px}.brand{flex-wrap:wrap}.menu{max-width:100%}}
 `;
  document.head.append(styles);
  async function request(url, opts = {}) {
    const r = await fetch(url, {
      credentials: 'include',
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...opts.headers
      }
    });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'No se pudo completar la solicitud');
    return data;
  }
  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const base = {
    version: 1,
    enabled: false,
    mode: 'weekly',
    weekdays: [1, 2, 3, 4, 5],
    dates: [],
    allow_advance: true,
    open_days_before: 0,
    open_time: '00:00',
    close_days_before: 0,
    close_time: '23:59',
    daily_capacity: null,
    exceptions: [],
    channels: {}
  };
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  } [c]));

  function field(id, label, type = 'text', attrs = '') {
    return `<label for="${id}">${label}</label><input id="${id}" type="${type}" ${attrs}>`;
  }

  function check(id, label) {
    return `<label><input id="${id}" type="checkbox">${label}</label>`;
  }

  function weekdayFields(id) {
    return `<div class="menu-days" id="${id}">${days.map((d,i)=>`<label><input type="checkbox" value="${i}">${d}</label>`).join('')}</div>`;
  }
  const getDays = id => Array.from(q('#' + id).querySelectorAll(':checked'), e => Number(e.value));

  function setDays(id, value) {
    q('#' + id).querySelectorAll('input').forEach(e => e.checked = value.includes(Number(e.value)));
  }

  function dates(value) {
    const list = String(value).split(/[\s,]+/).filter(Boolean);
    for (const d of list)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d + 'T12:00:00Z')) || new Date(d +
          'T12:00:00Z').toISOString().slice(0, 10) !== d) throw new Error(
        'Usá fechas reales AAAA-MM-DD, una por línea.');
    return [...new Set(list)].sort();
  }

  function number(id, {
    nullable = false,
    max = 1000000000,
    integer = false
  } = {}) {
    const s = q('#' + id).value;
    if (nullable && s === '') return null;
    const n = Number(s);
    if (s === '' || !Number.isFinite(n) || n < 0 || n > max || (integer && !Number.isInteger(n)))
      throw new Error('Revisá los cupos y días: deben ser números no negativos dentro del límite.');
    return n;
  }

  function ruleFields(id) {
    const channel = id !== 'mp';
    return `<label for="${id}-mode" ${channel?'hidden':''}>Repetición</label>${channel?'<p>La repetición semanal o por fechas se hereda de las reglas generales.</p>':''}<select id="${id}-mode" ${channel?'hidden':''}><option value="weekly">Cada semana</option><option value="dates">Fechas puntuales</option></select><div id="${id}-week-wrap">${weekdayFields(id+'-weekdays')}</div><div id="${id}-date-wrap" hidden><label for="${id}-dates">Fechas de entrega (AAAA-MM-DD, una por línea)</label><textarea id="${id}-dates" rows="3" placeholder="2026-10-20"></textarea></div><div class="menu-grid"><div>${field(id+'-open_days_before','Abrir: días antes de la entrega','number','min="0" max="30" step="1"')}${field(id+'-open_time','Hora de apertura (incluida)','time')}</div><div>${field(id+'-close_days_before','Cerrar: días antes de la entrega','number','min="0" max="30" step="1"')}${field(id+'-close_time','Hora de cierre (excluida)','time')}</div></div>`;
  }

  function setRule(id, c) {
    q('#' + id + '-mode').value = c.mode;
    setDays(id + '-weekdays', c.weekdays);
    q('#' + id + '-dates').value = c.dates.join('\n');
    for (const k of ['open_days_before', 'open_time', 'close_days_before', 'close_time']) q('#' + id + '-' +
      k).value = c[k];
    showRule(id);
  }

  function showRule(id) {
    q('#' + id + '-week-wrap').hidden = q('#' + id + '-mode').value !== 'weekly';
    q('#' + id + '-date-wrap').hidden = q('#' + id + '-mode').value !== 'dates';
  }

  function readRule(id) {
    const c = {
      mode: q('#' + id + '-mode').value,
      weekdays: getDays(id + '-weekdays'),
      dates: dates(q('#' + id + '-dates').value)
    };
    for (const k of ['open_days_before', 'close_days_before']) c[k] = number(id + '-' + k, {
      max: 30,
      integer: true
    });
    for (const k of ['open_time', 'close_time']) {
      c[k] = q('#' + id + '-' + k).value;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c[k])) throw new Error(
        'Completá las horas de apertura y cierre.');
    }
    if (c.mode === 'weekly' && !c.weekdays.length || c.mode === 'dates' && !c.dates.length) throw new Error(
      'Elegí al menos un día o una fecha.');
    if (-c.open_days_before * 1440 + minutes(c.open_time) >= -c.close_days_before * 1440 + minutes(c
        .close_time)) throw new Error('La apertura debe ser anterior al cierre.');
    return c;
  }

  function minutes(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }

  function today(zone) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  }

  function createProduct(root, getTenant) {
    root.className = 'menu-editor';
    root.innerHTML =
      `<h3>Menú programado</h3><p id="menu-product-status" role="status" aria-live="polite">Cargando disponibilidad…</p><fieldset id="menu-product-fields" disabled><legend>Programación opcional</legend>${check('mp-enabled','Programar este producto')}<p>Se conservan el estado Activo y la visibilidad manual. Un día cerrado de empresa prevalece. El cupo no modifica stock físico.</p>${ruleFields('mp')}${check('mp-allow_advance','Permitir pedidos anticipados (también debe permitirlo la empresa)')}${field('mp-daily_capacity','Cupo diario compartido · vacío: ilimitado · 0: agotado','number','min="0" step="any" max="1000000000"')}<details><summary>Reglas por canal (opcional)</summary><p>Sin personalizar se usan las reglas generales. Cupos y excepciones son compartidos.</p>${['catalog','landing'].map(c=>`<fieldset><legend>${c==='catalog'?'App Catálogo':'Web Landing'}</legend>${check('mp-'+c+'-override','Personalizar este canal')}<div id="mp-${c}-fields" hidden>${ruleFields('mp-'+c)}</div></fieldset>`).join('')}</details><details open><summary>Excepciones por fecha</summary><p>Pausar impide nuevas compras; no cancela pedidos existentes. Añadí la excepción y luego pulsá Guardar Producto.</p>${field('mp-ex-date','Fecha de excepción','date')}${check('mp-ex-paused','Pausar nuevas compras ese día')}<label for="mp-ex-capacity-mode">Cupo de esa fecha</label><select id="mp-ex-capacity-mode"><option value="inherit">Heredar cupo diario</option><option value="unlimited">Ilimitado</option><option value="custom">Cupo específico</option></select>${field('mp-ex-capacity','Cantidad específica (0 = agotado)','number','min="0" step="any"')}<div class="menu-grid"><button class="btn" id="mp-ex-add" type="button">Añadir / actualizar excepción</button><button class="btn" id="mp-pause-today" type="button">Pausar por hoy (preparar cambio)</button></div><ul id="mp-ex-list"></ul></details><fieldset><legend>Vista previa de lo guardado</legend><p>Los cambios del editor no se incluyen. Guardá el producto y volvé a abrirlo para comprobarlos.</p>${field('mp-preview-date','Fecha de entrega para consultar','date')}<label for="mp-preview-channel">Canal</label><select id="mp-preview-channel"><option value="catalog">App Catálogo</option><option value="landing">Web Landing</option></select><button id="mp-preview" class="btn" type="button">Consultar disponibilidad guardada</button><p id="mp-preview-result" role="status" aria-live="polite">Sin consultar. Los cambios aún no guardados no alteran la vista previa.</p></fieldset></fieldset>`;
    let generation = 0,
      tenant = null,
      ready = false,
      loading = false,
      productId = null,
      exceptions = [],
      timezone = 'America/Argentina/Buenos_Aires',
      dirty = false,
      previewGeneration = 0;
    const status = q('#menu-product-status');
    const fields = q('#menu-product-fields');
    const valid = token => token === generation && tenant === String(getTenant() || '');
    const renderExceptions = () => {
      q('#mp-ex-list').innerHTML = exceptions.map((e, i) =>
        `<li>${escape(e.date)} · ${e.paused?'Pausado':'Sin pausa'} · ${!Object.hasOwn(e,'capacity')?'hereda cupo':e.capacity===null?'ilimitado':'cupo '+escape(e.capacity)} <button class="btn" type="button" data-edit="${i}" aria-label="Editar excepción ${escape(e.date)}">Editar</button> <button class="btn" type="button" data-remove="${i}" aria-label="Eliminar excepción ${escape(e.date)}">Eliminar</button></li>`
      ).join('');
    };
    const markDirty = () => {
      ++previewGeneration;
      dirty = true;
      q('#mp-preview-result').textContent =
        'Cambios sin guardar. La próxima consulta usa exclusivamente la configuración guardada.';
    };
    root.addEventListener('input', markDirty);
    root.addEventListener('change', () => {
      for (const c of ['catalog', 'landing']) q('#mp-' + c + '-mode').value = q('#mp-mode').value;
      for (const id of ['mp', 'mp-catalog', 'mp-landing']) showRule(id);
      for (const c of ['catalog', 'landing']) q('#mp-' + c + '-fields').hidden = !q('#mp-' + c +
        '-override').checked;
      markDirty();
    });
    q('#mp-ex-list').addEventListener('click', e => {
      const edit = e.target.closest('[data-edit]');
      if (edit) {
        const ex = exceptions[Number(edit.dataset.edit)];
        q('#mp-ex-date').value = ex.date;
        q('#mp-ex-paused').checked = ex.paused === true;
        q('#mp-ex-capacity-mode').value = !Object.hasOwn(ex, 'capacity') ? 'inherit' : ex.capacity ===
          null ? 'unlimited' : 'custom';
        q('#mp-ex-capacity').value = ex.capacity ?? '';
        q('#mp-ex-date').focus();
        return;
      }
      const b = e.target.closest('[data-remove]');
      if (b) {
        exceptions.splice(Number(b.dataset.remove), 1);
        renderExceptions();
        markDirty();
      }
    });

    function addException(pausedToday = false) {
      try {
        const date = pausedToday ? today(timezone) : dates(q('#mp-ex-date').value)[0];
        if (!date) throw new Error('Elegí una fecha para la excepción.');
        const ex = {
          date,
          paused: pausedToday || q('#mp-ex-paused').checked
        };
        const mode = q('#mp-ex-capacity-mode').value;
        if (!pausedToday && mode !== 'inherit') ex.capacity = mode === 'unlimited' ? null : number(
          'mp-ex-capacity');
        const previous = exceptions.find(x => x.date === date);
        exceptions = exceptions.filter(x => x.date !== date);
        exceptions.push(pausedToday ? {
          ...previous,
          ...ex
        } : ex);
        exceptions.sort((a, b) => a.date.localeCompare(b.date));
        q('#mp-ex-date').value = date;
        renderExceptions();
        markDirty();
        status.textContent =
          'Excepción preparada. Guardar Producto confirma el cambio; no se cancelan pedidos existentes.';
      } catch (e) {
        status.textContent = e.message;
      }
    }
    q('#mp-ex-add').onclick = () => addException();
    q('#mp-pause-today').onclick = () => addException(true);
    q('#mp-preview').onclick = async () => {
      const token = generation,
        seq = ++previewGeneration;
      const output = q('#mp-preview-result');
      try {
        if (!productId) throw new Error('Guardá primero el producto nuevo.');
        const date = dates(q('#mp-preview-date').value)[0];
        if (!date) throw new Error('Elegí la fecha de entrega a consultar.');
        const channel = q('#mp-preview-channel').value;
        output.textContent = 'Consultando configuración guardada…';
        const data = await request(
          `/api/menu/preview?producto_id=${encodeURIComponent(productId)}&fecha_entrega=${encodeURIComponent(date)}&canal=${channel}&empresa_id=${encodeURIComponent(tenant)}`
        );
        if (!valid(token) || seq !== previewGeneration) return;
        const a = data.menu || data.availability || data.preview || data;
        output.textContent =
          `${a.available?'Visible ahora':a.reason==='MENU_PAUSED'||a.reason==='paused'||a.reason==='exception_paused'?'Pausado':a.scheduled?'Programado':'No disponible'} · ${date} · ${channel}. Estado guardado, no incluye cambios sin guardar. Motivo: ${a.reason||'sin detalle'}. Cupo restante: ${a.remaining==null?'sin límite':a.remaining}. Zona: ${a.timezone||timezone}.${a.opens_at?' Apertura: '+a.opens_at:''}${a.closes_at?' Cierre: '+a.closes_at:''}`;
      } catch (e) {
        if (valid(token) && seq === previewGeneration) output.textContent = e.message;
      }
    };

    function readChannel(c) {
      const {
        mode,
        ...rule
      } = readRule('mp-' + c);
      return rule;
    }
    return {
      async open(product = {}) {
        const token = ++generation;
        ++previewGeneration;
        tenant = String(getTenant() || '');
        ready = false;
        loading = true;
        productId = product.id || null;
        dirty = false;
        fields.disabled = true;
        status.textContent = 'Cargando disponibilidad…';
        const c = {
          ...base,
          ...product.disponibilidad_config
        };
        exceptions = structuredClone(c.exceptions);
        setRule('mp', c);
        q('#mp-enabled').checked = c.enabled;
        q('#mp-allow_advance').checked = c.allow_advance;
        q('#mp-daily_capacity').value = c.daily_capacity ?? '';
        for (const channel of ['catalog', 'landing']) {
          const override = c.channels?.[channel];
          q('#mp-' + channel + '-override').checked = !!override;
          q('#mp-' + channel + '-fields').hidden = !override;
          setRule('mp-' + channel, {
            ...c,
            ...override
          });
        }
        renderExceptions();
        q('#mp-preview-result').textContent = 'Sin consultar. Esta vista usa únicamente datos guardados.';
        q('#mp-preview').disabled = !productId;
        q('#mp-ex-date').value = '';
        q('#mp-ex-paused').checked = false;
        q('#mp-ex-capacity-mode').value = 'inherit';
        q('#mp-ex-capacity').value = '';
        if (!tenant) {
          loading = false;
          return;
        }
        try {
          const data = await request('/api/menu/config?empresa_id=' + encodeURIComponent(tenant));
          if (!valid(token)) return;
          if (String(data.empresa_id) !== tenant) throw new Error(
            'La empresa de la respuesta no coincide. Volvé a abrir el editor.');
          ready = data.enabled === true;
          timezone = data.config?.timezone || timezone;
          q('#mp-preview-date').value = today(timezone);
          fields.disabled = !ready;
          status.textContent = ready ? data.config?.enabled ?
            'Programación disponible. Los cambios se guardan con Guardar Producto.' :
            'El menú de empresa está desactivado. Podés preparar reglas, pero no se aplicarán hasta habilitarlo en Empresa.' :
            'Pendiente de activación del sistema. Se mantienen las reglas manuales.';
        } catch (e) {
          if (valid(token)) status.textContent = e.message;
        } finally {
          if (valid(token)) loading = false;
        }
      },
      close() {
        ++generation;
        ++previewGeneration;
        ready = false;
        loading = false;
      },
      read() {
        if (loading) throw new Error('Esperá que termine de cargar la programación.');
        if (tenant !== String(getTenant() || '')) throw new Error(
          'Cambió la empresa. Volvé a abrir el producto.');
        if (!ready) return undefined;
        if (!dirty) return undefined;
        return {
          ...base,
          ...readRule('mp'),
          enabled: q('#mp-enabled').checked,
          allow_advance: q('#mp-allow_advance').checked,
          daily_capacity: number('mp-daily_capacity', {
            nullable: true
          }),
          exceptions: structuredClone(exceptions),
          channels: Object.fromEntries(['catalog', 'landing'].filter(c => q('#mp-' + c + '-override')
            .checked).map(c => [c, readChannel(c)]))
        };
      }
    };
  }

  function createCompany(root, getTenant) {
    root.className = 'menu-editor';
    root.innerHTML =
      `<h3>Menú y pedidos anticipados</h3><p>Configuración independiente de los datos generales, horarios logísticos y parámetros operativos. Guardala con su propio botón.</p><p id="menu-company-status" role="status" aria-live="polite">Seleccioná una empresa guardada.</p><fieldset id="menu-company-fields" disabled><legend>Reglas de servicio del menú</legend>${check('mc-enabled','Habilitar menú programado en esta empresa')}${field('mc-timezone','Zona horaria del menú (IANA)','text','list="menu-timezones" placeholder="America/Argentina/Buenos_Aires"')}<datalist id="menu-timezones"><option value="America/Argentina/Buenos_Aires"><option value="America/Montevideo"><option value="America/Santiago"><option value="America/Sao_Paulo"><option value="UTC"></datalist>${check('mc-advance_enabled','Permitir pedidos para fechas futuras')}${field('mc-max_advance_days','Horizonte de anticipación (0 a 30 días)','number','min="0" max="30" step="1"')}<p>Días de servicio del menú (domingo = 0). Un día cerrado de empresa prevalece sobre cualquier producto.</p>${weekdayFields('mc-service_weekdays')}<label for="mc-closed_dates">Fechas cerradas (AAAA-MM-DD, una por línea)</label><textarea id="mc-closed_dates" rows="3" placeholder="2026-12-25"></textarea><button id="mc-save" type="button" class="btn btn-primary">Guardar configuración del menú</button></fieldset>`;
    let generation = 0,
      tenant = null,
      ready = false,
      busy = false;
    const status = q('#menu-company-status'),
      fields = q('#menu-company-fields'),
      button = q('#mc-save');
    const valid = token => token === generation && tenant === String(getTenant() || '');
    const set = c => {
      q('#mc-enabled').checked = c.enabled === true;
      q('#mc-timezone').value = c.timezone || 'America/Argentina/Buenos_Aires';
      q('#mc-advance_enabled').checked = c.advance_enabled === true;
      q('#mc-max_advance_days').value = c.max_advance_days ?? 7;
      setDays('mc-service_weekdays', c.service_weekdays || [0, 1, 2, 3, 4, 5, 6]);
      q('#mc-closed_dates').value = (c.closed_dates || []).join('\n');
    };
    async function readSaved(token) {
      const data = await request('/api/menu/config?empresa_id=' + encodeURIComponent(tenant));
      if (!valid(token)) return false;
      if (String(data.empresa_id) !== tenant) throw new Error(
        'La empresa de la respuesta no coincide. Cerrá y volvé a abrir.');
      ready = data.enabled === true;
      set(data.config || {});
      fields.disabled = !ready;
      return true;
    }
    root.addEventListener('input', () => {
      if (ready) status.textContent = 'Cambios sin guardar en la configuración del menú.';
    });
    button.onclick = async () => {
      if (!ready || busy || tenant !== String(getTenant() || '')) return;
      const token = generation;
      try {
        const zone = q('#mc-timezone').value.trim();
        try {
          if (zone !== 'UTC' && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(zone)) throw new Error(
            'Zona inválida');
          new Intl.DateTimeFormat('es', {
            timeZone: zone
          });
        } catch {
          throw new Error('Ingresá una zona horaria IANA válida.');
        }
        const config = {
          version: 1,
          enabled: q('#mc-enabled').checked,
          timezone: zone,
          advance_enabled: q('#mc-advance_enabled').checked,
          max_advance_days: number('mc-max_advance_days', {
            max: 30,
            integer: true
          }),
          service_weekdays: getDays('mc-service_weekdays'),
          closed_dates: dates(q('#mc-closed_dates').value)
        };
        busy = true;
        fields.disabled = true;
        status.textContent = 'Guardando configuración del menú…';
        await request('/api/menu/config?empresa_id=' + encodeURIComponent(tenant), {
          method: 'PUT',
          body: JSON.stringify(config)
        });
        if (!valid(token)) return;
        try {
          if (await readSaved(token)) status.textContent =
            'Menú guardado y verificado. Los demás formularios no se modificaron.';
        } catch {
          if (valid(token)) {
            ready = false;
            status.textContent =
              'El servidor recibió el guardado, pero no se pudo verificar. Cerrá y volvé a abrir antes de intentar nuevamente.';
          }
        }
      } catch (e) {
        if (valid(token)) status.textContent = e.message;
      } finally {
        if (valid(token)) {
          busy = false;
          fields.disabled = !ready;
        }
      }
    };
    return {
      async open(id) {
        const token = ++generation;
        tenant = String(id || '');
        ready = false;
        busy = false;
        fields.disabled = true;
        set({});
        status.textContent = tenant ? 'Cargando configuración del menú…' :
          'Guardá primero la empresa para configurar su menú.';
        if (!tenant) return;
        try {
          if (await readSaved(token)) status.textContent = ready ?
            'La configuración del menú se guarda por separado.' :
            'Pendiente de activación del sistema. No se modifican reglas existentes.';
        } catch (e) {
          if (valid(token)) status.textContent = e.message;
        }
      },
      close() {
        ++generation;
        ready = false;
        busy = false;
        fields.disabled = true;
      }
    };
  }

  function installDialogAccess() {
    const backdrop = q('#modal'),
      dialog = q('.modal', backdrop);
    let returnFocus = null;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'modalTitle');
    q('#btnCloseModalTop').setAttribute('aria-label', 'Cerrar editor');
    backdrop.inert = true;
    const focusables = () => Array.from(dialog.querySelectorAll(
      'input,select,textarea,button,summary,[tabindex]')).filter(e => !e.matches(':disabled') && e
      .tabIndex >= 0 && e.getClientRects().length);
    new MutationObserver(() => {
      const open = backdrop.classList.contains('open');
      backdrop.inert = !open;
      if (open) {
        returnFocus = document.activeElement;
        requestAnimationFrame(() => {
          if (!backdrop.contains(document.activeElement)) focusables()[0]?.focus();
        });
      } else if (returnFocus?.isConnected) {
        returnFocus.focus();
        returnFocus = null;
      }
    }).observe(backdrop, {
      attributes: true,
      attributeFilter: ['class']
    });
    backdrop.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        q('#btnCancelModal').click();
      }
      if (e.key === 'Tab') {
        const all = focusables(),
          first = all[0],
          last = all.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    });
  }
  installDialogAccess();
  window.MenuAdmin = {
    createProduct,
    createCompany
  };
})();
