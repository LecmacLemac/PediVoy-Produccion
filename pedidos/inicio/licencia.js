// --- CONFIGURACIÓN ---
    const API_URL = '/api';

    // Modo seguro: auth por cookie httpOnly
    const authFetch = (url, opts = {}) => {
      const { headers = {}, ...rest } = opts;
      return fetch(url, { ...rest, headers, credentials: 'include' });
    };
    let empresasList = [];
    let currentEmpresaId = null;
    let isSuper = false; 
    let empresaDataGlobal = null; // 🔍 NUEVO: Para guardar datos para el update optimista
    let priceBusy = false;
    let licenseBusy = false;
    let empresaSearchTerm = '';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));

    // Helper simple para notificaciones
    const toast = (msg) => alert(msg);

// --- 1. INICIALIZACIÓN Y AUTH ---
    async function init() {
      // cookie session
      const token = null;

      // Chequear si viene de Mercado Pago
      const params = new URLSearchParams(window.location.search);
      const status = params.get('status');

      try {
        const resMe = await authFetch(`${API_URL}/me`);

        if (!resMe.ok) throw new Error('Falló autenticación');
        
        const dataMe = await resMe.json();
        const user = dataMe.user || {};
        const role = user.role || '';
        const myEmpresaId = user.empresa_id; 

        isSuper = (role === 'super');
        document.getElementById('roleBadge').textContent = isSuper ? 'SUPER ADMIN' : 'Admin';

        if (isSuper) {
          // >> MODO SUPER ADMIN
          document.getElementById('selectionCard').classList.remove('hidden'); 
          await cargarListaEmpresas();

        } else {
          // >> MODO USUARIO (CLIENTE)
          document.getElementById('selectionCard').classList.add('hidden'); 
          
          if (myEmpresaId) {
              currentEmpresaId = myEmpresaId;
              await cargarMiEmpresa(myEmpresaId);
              await cargarHistorialPagos(currentEmpresaId);
          } else {
              document.getElementById('statusMsg').textContent = 'Error: Tu usuario no tiene una empresa asignada.';
              document.getElementById('statusMsg').classList.remove('hidden');
          }
        }

        // LÓGICA DE RETORNO DE PAGO
        if (status === 'approved') {
            // Limpiamos la URL
            window.history.replaceState({}, document.title, window.location.pathname);
            document.getElementById('successModal').classList.add('show');
            
            // 🔥 UPDATE OPTIMISTA: Si la DB tarda, lo mostramos actualizado YA
            if (empresaDataGlobal) {
                aplicarActualizacionVisualPago(empresaDataGlobal);
            }
        } else if (status === 'failure') {
            alert('El pago no se pudo procesar.');
        }

      } catch (e) {
        console.error(e);
        logout();
      }
    }
    // --- NUEVO: FUNCIÓN PARA ACTUALIZAR FECHA SIN RECARGAR ---
    function aplicarActualizacionVisualPago(empresa) {
        // Lógica: "Si venció, suma 30 a HOY. Si no, suma 30 a Vencimiento"
        let baseDate = new Date(); 
        if (empresa.plan_vencimiento) {
            const currentVenc = new Date(empresa.plan_vencimiento);
            if (currentVenc > baseDate) baseDate = currentVenc; 
        }
        baseDate.setDate(baseDate.getDate() + 30);
        
        const nuevaFechaStr = baseDate.toLocaleDateString();

        // 1. Actualizar texto de vencimiento
        document.getElementById('planVencimiento').textContent = nuevaFechaStr;
        // 2. Actualizar badge de estado
        const pe = document.getElementById('planEstado');
        pe.innerHTML = '<span class="badge badge-active">ACTIVO</span>';
        // 3. Actualizar Modal
        document.getElementById('modalNewDate').textContent = nuevaFechaStr;
        // 4. Actualizar días restantes
        const hoy = new Date();
        const diff = Math.ceil((baseDate - hoy) / (1000 * 60 * 60 * 24));
        const diasEl = document.getElementById('diasRestantes');
        diasEl.textContent = `${diff} días restantes`; 
        diasEl.style.color = 'var(--success)';
        
        // 5. Actualizar texto de "próximo pago"
        const proximoPagoDate = new Date(baseDate);
        proximoPagoDate.setDate(proximoPagoDate.getDate() + 30);
        document.getElementById('payNextDate').textContent = proximoPagoDate.toLocaleDateString();
    }

    async function cargarHistorialPagos(id) {
        try {
            const res = await authFetch(`${API_URL}/empresas/${id}/pagos`);
            
            if (!res.ok) return;
            const pagos = await res.json();
            
            const section = document.getElementById('historialSection');
            const tbody = document.getElementById('tablaPagosBody');
            const noMsg = document.getElementById('noPagosMsg');

            section.classList.remove('hidden');
            tbody.innerHTML = '';

            if (pagos.length === 0) {
                noMsg.style.display = 'block';
                return;
            } else {
                noMsg.style.display = 'none';
            }

            const fmt = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });

            pagos.forEach(p => {
                const fecha = new Date(p.fecha).toLocaleDateString() + ' ' + new Date(p.fecha).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                const tr = document.createElement('tr');
                tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
                tr.innerHTML = `
                    <td style="padding:12px 10px; color:var(--ink)">${esc(fecha)}</td>
                    <td style="padding:12px 10px; color:var(--muted); font-size:0.85rem">#${esc(p.referencia || '-')}</td>
                    <td style="padding:12px 10px; text-transform:capitalize">${esc(p.metodo || '-')}</td>
                    <td style="padding:12px 10px; text-align:right; color:var(--success); font-weight:bold">${esc(fmt.format(p.monto || 0))}</td>
                `;
                tbody.appendChild(tr);
            });

        } catch (e) {
            console.error('Error cargando historial', e);
        }
    }

    async function logout() {
      try { await authFetch('/api/logout', { method: 'POST' }); } catch {}
      window.location.href = '/pedidos/login.html';
    }

    function cerrarModal() {
        document.getElementById('successModal').classList.remove('show');
    }

    // --- 2. CARGA DE DATOS ---

    async function cargarListaEmpresas() {
      const select = document.getElementById('empresaSelect');
      try {
        const res = await authFetch(`${API_URL}/empresas`);
        
        if (!res.ok) throw new Error('Error de conexión');
        
        empresasList = await res.json();
        empresasList.sort((a,b) => b.id - a.id);

        renderEmpresaOptions();
      } catch (e) {
        select.innerHTML = '<option>Error al cargar datos</option>';
      }
    }

    function renderEmpresaOptions() {
      const select = document.getElementById('empresaSelect');
      const q = empresaSearchTerm.trim().toLowerCase();
      const selected = select.value;
      const list = empresasList.filter(emp => {
        if (!q) return true;
        return `${emp.id} ${emp.nombre || ''}`.toLowerCase().includes(q);
      });

      select.innerHTML = '<option value="">-- Selecciona una empresa --</option>';
      list.forEach(emp => {
        const opt = document.createElement('option');
        opt.value = emp.id;
        opt.textContent = `ID ${emp.id} | ${emp.nombre}`;
        select.appendChild(opt);
      });

      if (selected && list.some(emp => String(emp.id) === String(selected))) {
        select.value = selected;
      }
    }

    async function cargarMiEmpresa(id) {
      try {
        const res = await authFetch(`${API_URL}/empresas/${id}`);

        if (!res.ok) throw new Error('Error server');
        
        const empresa = await res.json();
        
        // Guardamos para usar en el update optimista
        empresaDataGlobal = empresa;
        
        renderPanel(empresa);

      } catch (e) {
        document.getElementById('statusMsg').textContent = 'No pudimos cargar los detalles de tu licencia.';
        document.getElementById('statusMsg').classList.remove('hidden');
        document.getElementById('licensePanel').classList.add('hidden');
      }
    }

    // --- 3. RENDERIZADO (UI) ---
    
    function onEmpresaChange() {
      const select = document.getElementById('empresaSelect');
      currentEmpresaId = select.value;
      const panel = document.getElementById('licensePanel');

      if (!currentEmpresaId) {
        panel.classList.add('hidden');
        return;
      }
      
      const empresa = empresasList.find(e => e.id == currentEmpresaId);
      if (empresa) {
          empresaDataGlobal = empresa;
          renderPanel(empresa);
      }
    }

    function renderPanel(empresa) {
      const panel = document.getElementById('licensePanel');
      panel.classList.remove('hidden');

      // 1. Datos Básicos
      document.getElementById('empNombre').textContent = empresa.nombre;
      document.getElementById('empId').textContent = `ID: ${empresa.id}`;
      document.getElementById('planTipo').textContent = empresa.plan_tipo || 'Básico';

      // 2. Precio
      const precio = Number(empresa.plan_precio || 0);
      const precioFmt = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(precio);
      document.getElementById('planPrecioDisplay').textContent = precioFmt;

      // Pre-llenar input si es super
      if(isSuper) document.getElementById('inputPrecio').value = precio;

      // 3. Badge de Estado
      const estadoEl = document.getElementById('planEstado');
      const estado = String(empresa.plan_estado || 'inactive').toLowerCase();
      
      let badgeHtml = '';
      if (estado === 'active') badgeHtml = '<span class="badge badge-active">ACTIVO</span>';
      else if (estado === 'expired') badgeHtml = '<span class="badge badge-expired">VENCIDO</span>';
      else badgeHtml = `<span class="badge badge-trial">${esc(estado.toUpperCase())}</span>`;

      estadoEl.innerHTML = badgeHtml;

      // 4. Fechas
      const vencEl = document.getElementById('planVencimiento');
      const diasEl = document.getElementById('diasRestantes');
      let fechaVencObj = null;

      if (empresa.plan_vencimiento) {
        fechaVencObj = new Date(empresa.plan_vencimiento);
        const dateStr = fechaVencObj.toLocaleDateString();
        vencEl.textContent = dateStr; 
        
        // Cargar fecha en el modal de éxito también
        document.getElementById('modalNewDate').textContent = dateStr;

        const hoy = new Date();
        const diffTime = fechaVencObj - hoy;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays > 0) {
          diasEl.textContent = `${diffDays} días restantes`;
          diasEl.style.color = 'var(--success)';
        } else if (diffDays === 0) {
          diasEl.textContent = `Vence hoy`;
          diasEl.style.color = 'var(--warning)';
        } else {
          diasEl.textContent = `Venció hace ${Math.abs(diffDays)} días`;
          diasEl.style.color = 'var(--danger)';
        }
      } else {
        vencEl.textContent = 'Indefinido';
        diasEl.textContent = '';
      }

      renderLicenseBanner(empresa, fechaVencObj);

      // 5. Visibilidad ZONAS (Admin vs User)
      const actionsBar = document.getElementById('actionsBar');
      const userPaymentSection = document.getElementById('userPaymentSection');

      if (isSuper) {
        // ADMIN: Ve controles manuales, NO ve botón de pago
        actionsBar.classList.remove('hidden'); 
        userPaymentSection.classList.add('hidden');
      } else {
        // USER: Ve botón de pago, NO ve controles manuales
        actionsBar.classList.add('hidden');    
        userPaymentSection.classList.remove('hidden');
        
        // Actualizar textos de la zona de pago
        document.getElementById('payAmount').textContent = precioFmt;
        
        // Calcular próxima fecha (Vencimiento Actual + 30 días) para el texto informativo
        let nextDate = new Date();
        if (fechaVencObj && fechaVencObj > nextDate) {
            nextDate = new Date(fechaVencObj);
        }
        nextDate.setDate(nextDate.getDate() + 30);
        document.getElementById('payNextDate').textContent = nextDate.toLocaleDateString();
      }
    }

    function renderLicenseBanner(empresa, fechaVencObj) {
      const banner = document.getElementById('licenseBanner');
      const headline = document.getElementById('licenseHeadline');
      const hint = document.getElementById('licenseHint');
      const rec = document.getElementById('licenseRecommendation');
      const meter = document.getElementById('licenseMeterFill');
      const estado = String(empresa.plan_estado || 'inactive').toLowerCase();

      banner.classList.remove('success', 'warning', 'danger');

      if (!fechaVencObj) {
        banner.classList.add(estado === 'active' ? 'success' : 'warning');
        headline.textContent = estado === 'active' ? 'Licencia activa sin vencimiento definido' : 'Licencia sin vencimiento definido';
        hint.textContent = 'Revisar configuración';
        rec.textContent = isSuper
          ? 'Conviene definir una fecha de vencimiento para mantener control administrativo.'
          : 'Consultá con soporte para confirmar la vigencia de tu plan.';
        meter.style.width = estado === 'active' ? '100%' : '20%';
        return;
      }

      const now = new Date();
      const diffDays = Math.ceil((fechaVencObj - now) / (1000 * 60 * 60 * 24));
      const pct = Math.max(0, Math.min(100, Math.round((diffDays / 30) * 100)));
      meter.style.width = `${pct}%`;

      if (estado === 'expired' || diffDays < 0) {
        banner.classList.add('danger');
        headline.textContent = 'Licencia vencida';
        hint.textContent = diffDays < 0 ? `Venció hace ${Math.abs(diffDays)} día(s)` : 'Servicio suspendido';
        rec.textContent = isSuper
          ? 'Acción sugerida: cobrar, extender 30 días o activar manualmente si corresponde.'
          : 'Renová la suscripción para recuperar o mantener el servicio operativo.';
      } else if (diffDays <= 7) {
        banner.classList.add('warning');
        headline.textContent = diffDays === 0 ? 'Licencia vence hoy' : 'Licencia próxima a vencer';
        hint.textContent = diffDays === 0 ? 'Vence hoy' : `${diffDays} día(s) restantes`;
        rec.textContent = isSuper
          ? 'Acción sugerida: contactar al cliente y dejar el precio pactado actualizado.'
          : 'Recomendación: renovar ahora para evitar interrupciones.';
      } else {
        banner.classList.add('success');
        headline.textContent = 'Licencia activa';
        hint.textContent = `${diffDays} día(s) restantes`;
        rec.textContent = isSuper
          ? 'La cuenta está operativa. Revisá precio pactado y próximo vencimiento.'
          : 'Tu servicio está activo. Podés renovar anticipadamente cuando quieras.';
      }
    }

    // --- 4. ACCIONES (GUARDAR PRECIO Y ESTADO) ---
    async function guardarPrecio() {
        if (!isSuper || !currentEmpresaId || priceBusy) return;

        const nuevoPrecio = document.getElementById('inputPrecio').value;
        if (nuevoPrecio === '') return alert('Ingresa un valor válido');

        const btn = document.getElementById('btnGuardarPrecio');
        const prev = btn ? btn.textContent : '';
        priceBusy = true;
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Guardando...';
        }

        try {
            const res = await authFetch(`${API_URL}/empresas/${currentEmpresaId}`, {
                method: 'PUT',
                headers: { 
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ plan_precio: nuevoPrecio })
            });

            if (res.ok) {
                const updated = await res.json();
                const idx = empresasList.findIndex(e => e.id == currentEmpresaId);
                if (idx !== -1) empresasList[idx] = updated;
                
                renderPanel(updated);
                toast('✅ Precio actualizado');
            } else {
                toast('❌ Error al guardar');
            }
        } catch (e) {
            console.error(e);
            toast('❌ Error de conexión');
        } finally {
            priceBusy = false;
            if (btn) {
              btn.disabled = false;
              btn.textContent = prev;
            }
        }
    }

    async function modificarLicencia(accion) {
      if (!isSuper || licenseBusy) return; 
      if (!currentEmpresaId) return;

      let empresaObj = empresasList.find(e => e.id == currentEmpresaId);
      if (!empresaObj && !isSuper) return;

      let payload = {};
      let msgConfirm = '';

      if (accion === 'extend') {
        msgConfirm = '¿Extender la vigencia por 30 días?';
        let baseDate = new Date();
        if (empresaObj && empresaObj.plan_vencimiento) {
          const currentVenc = new Date(empresaObj.plan_vencimiento);
          if (currentVenc > baseDate) baseDate = currentVenc; 
        }
        baseDate.setDate(baseDate.getDate() + 30);
        
        payload = { 
          plan_vencimiento: baseDate.toISOString(), 
          plan_estado: 'active' 
        };
      } 
      else if (accion === 'activate') {
        msgConfirm = '¿Reactivar servicio?';
        payload = { plan_estado: 'active' };
      }
      else if (accion === 'expire') {
        msgConfirm = '¿Suspender servicio ahora?';
        payload = { plan_estado: 'expired' };
      }

      if (!confirm(msgConfirm)) return;

      const actionBtns = Array.from(document.querySelectorAll('#actionsBar .actions-bar button'));
      licenseBusy = true;
      actionBtns.forEach(b => b.disabled = true);

      try {
        const res = await authFetch(`${API_URL}/empresas/${currentEmpresaId}`, {
          method: 'PUT',
          headers: { 
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          const updatedEmpresa = await res.json();
          const idx = empresasList.findIndex(e => e.id == currentEmpresaId);
          if (idx !== -1) empresasList[idx] = updatedEmpresa;

          renderPanel(updatedEmpresa);
          toast('✅ Licencia actualizada');
        } else {
          toast('❌ Error al actualizar');
        }
      } catch (e) {
        console.error(e);
        toast('❌ Error de conexión');
      } finally {
        licenseBusy = false;
        actionBtns.forEach(b => b.disabled = false);
      }
    }

    // --- 5. PAGAR LICENCIA (USER) ---
    async function pagarLicencia() {
        const btn = document.getElementById('btnPagar');
        const feedback = document.getElementById('payFeedback');
        const originalText = btn.innerHTML;

        btn.disabled = true;
        btn.innerHTML = '⏳ Generando Link...';
        feedback.style.display = 'none';

        try {
            const res = await authFetch(`${API_URL}/admin/licencia/generar-pago`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json'
                }
            });
            const data = await res.json();

            if (res.ok && data.link) {
                // REDIRECCIONAMOS A MERCADO PAGO
                window.location.href = data.link;
            } else {
                btn.innerHTML = '❌ Error';
                feedback.textContent = data.error || 'No se pudo generar el pago.';
                feedback.style.color = 'var(--danger)';
                feedback.style.display = 'block';
                setTimeout(() => { btn.disabled = false; btn.innerHTML = originalText; }, 3000);
            }
        } catch (e) {
            console.error(e);
            btn.innerHTML = '❌ Error Red';
            toast('Error de conexión');
            setTimeout(() => { btn.disabled = false; btn.innerHTML = originalText; }, 3000);
        }
    }

    // Arrancar script
    const logoutLink = document.getElementById('logout');
    if (logoutLink) {
      logoutLink.addEventListener('click', async (ev) => {
        ev.preventDefault();
        await logout();
      });
    }

    const empresaSelect = document.getElementById('empresaSelect');
    if (empresaSelect) empresaSelect.addEventListener('change', onEmpresaChange);

    const empresaSearch = document.getElementById('empresaSearch');
    if (empresaSearch) {
      empresaSearch.addEventListener('input', () => {
        empresaSearchTerm = empresaSearch.value || '';
        renderEmpresaOptions();
      });
    }

    const btnPagar = document.getElementById('btnPagar');
    if (btnPagar) btnPagar.addEventListener('click', pagarLicencia);

    const btnGuardarPrecio = document.getElementById('btnGuardarPrecio');
    if (btnGuardarPrecio) btnGuardarPrecio.addEventListener('click', guardarPrecio);

    const btnExtendLic = document.getElementById('btnExtendLic');
    if (btnExtendLic) btnExtendLic.addEventListener('click', () => modificarLicencia('extend'));

    const btnActivateLic = document.getElementById('btnActivateLic');
    if (btnActivateLic) btnActivateLic.addEventListener('click', () => modificarLicencia('activate'));

    const btnExpireLic = document.getElementById('btnExpireLic');
    if (btnExpireLic) btnExpireLic.addEventListener('click', () => modificarLicencia('expire'));

    const btnCerrarModal = document.getElementById('btnCerrarModal');
    if (btnCerrarModal) btnCerrarModal.addEventListener('click', cerrarModal);

    init();
