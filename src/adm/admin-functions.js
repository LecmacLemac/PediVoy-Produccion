/**
 * src/adm/admin-functions.js (o public/js/admin-functions.js)
 * * Lógica administrativa cargada dinámicamente solo para Super Admins.
 * Requiere SweetAlert2 cargado previamente en el HTML principal.
 */

async function modificarLicencia(empresaId) {
  console.log(`[Admin] Iniciando panel de modificación para empresa ID: ${empresaId}`);

  const token = localStorage.getItem('token');
  if (!token) {
    return Swal.fire('Error', 'No hay sesión activa.', 'error');
  }

  // 1. Mostrar Formulario Modal
  const { value: formValues } = await Swal.fire({
    title: `Administrar Licencia #${empresaId}`,
    html: `
      <div style="text-align:left; font-size: 0.95rem;">
        
        <label style="display:block; margin-bottom:5px; font-weight:bold;">Nueva Fecha Vencimiento</label>
        <input type="date" id="swal-date" class="swal2-input" style="margin: 0 0 15px 0; width: 100%;">

        <label style="display:block; margin-bottom:5px; font-weight:bold;">Estado del Plan</label>
        <select id="swal-estado" class="swal2-select" style="margin: 0 0 15px 0; width: 100%; display:block;">
          <option value="active">Active (Habilitado)</option>
          <option value="expired">Expired (Vencido)</option>
          <option value="locked">Locked (Bloqueado/Impago)</option>
        </select>

        <label style="display:block; margin-bottom:5px; font-weight:bold;">Tipo de Plan</label>
        <select id="swal-tipo" class="swal2-select" style="margin: 0 0 15px 0; width: 100%; display:block;">
          <option value="trial">Trial (Prueba)</option>
          <option value="basic">Basic</option>
          <option value="pro">Pro</option>
          <option value="unlimited">Unlimited</option>
        </select>

      </div>
    `,
    showCancelButton: true,
    confirmButtonText: '💾 Guardar Cambios',
    cancelButtonText: 'Cancelar',
    focusConfirm: false,
    preConfirm: () => {
      const date = document.getElementById('swal-date').value;
      const estado = document.getElementById('swal-estado').value;
      const tipo = document.getElementById('swal-tipo').value;

      if (!date) {
        Swal.showValidationMessage('⚠️ Debes seleccionar una fecha de vencimiento');
        return false; // Mantiene el modal abierto
      }

      return { 
        plan_vencimiento: date, 
        plan_estado: estado, 
        plan_tipo: tipo 
      };
    }
  });

  // Si el usuario canceló, paramos aquí
  if (!formValues) return;

  // 2. Enviar datos al Backend
  try {
    // Mostrar loading
    Swal.fire({ title: 'Actualizando...', didOpen: () => Swal.showLoading() });

    const res = await fetch(`/api/empresas/${empresaId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}` // Autenticación vital
      },
      body: JSON.stringify(formValues)
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Error desconocido al actualizar');
    }

    // 3. Feedback de Éxito
    await Swal.fire({
      icon: 'success',
      title: '¡Licencia Actualizada!',
      text: `Empresa ID ${empresaId} modificada correctamente.`,
      timer: 2000,
      showConfirmButton: false
    });

    // Recargar la página para ver los cambios reflejados en la tabla/UI
    window.location.reload();

  } catch (error) {
    console.error(error);
    Swal.fire({
      icon: 'error',
      title: 'Falló la actualización',
      text: error.message
    });
  }
}

// =========================================================
// EXPOSICIÓN GLOBAL
// =========================================================
// Esto permite llamar a la función desde el HTML (onclick="modificarLicencia(5)")
// incluso cuando este archivo se carga de forma diferida (lazy load).
window.modificarLicencia = modificarLicencia;