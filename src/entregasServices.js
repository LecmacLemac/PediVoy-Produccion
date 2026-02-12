// src/entregasServices.js (ESM)
// Maneja solicitudes de cambio de horario de entrega por WhatsApp.
// Implementación simple en memoria (Map). Si reinicia el proceso, se limpia el estado.

const cambiosHorario = new Map(); // key: numero (solo dígitos), value: { hora, estado, updatedAt }

function normalizarNumero(numero) {
  // Acepta: "54911....@c.us" o "11...." o con símbolos
  return String(numero || '').replace('@c.us', '').replace(/\D/g, '');
}

/**
 * Registrar/modificar una solicitud de cambio de horario.
 * @param {string} numero - JID o número del cliente
 * @param {string} nuevaHora - Texto con el nuevo horario solicitado
 * @returns {string} mensaje breve para el usuario/LLM
 */
export function modificarHorarioEntrega(numero, nuevaHora) {
  const key = normalizarNumero(numero);
  const hora = String(nuevaHora || '').trim();
  if (!hora) return 'Necesito que indiques el horario deseado. Ej: "cambiar hora 14:30"';

  const prev = cambiosHorario.get(key);
  cambiosHorario.set(key, {
    hora,
    estado: 'pendiente',
    updatedAt: Date.now()
  });

  if (prev && prev.hora && prev.hora !== hora) {
    return `Actualicé tu solicitud de horario a *${hora}*. Decí "confirmar horario" para confirmarlo o "finalizar cambio" para cerrar.`;
  }
  return `Registré tu solicitud de horario *${hora}*. Decí "confirmar horario" para confirmarlo o "finalizar cambio" para cerrar.`;
}

/**
 * Confirmar la modificación de horario previamente solicitada.
 * @param {string} numero
 * @returns {string}
 */
export function confirmarModificacionHorario(numero) {
  const key = normalizarNumero(numero);
  const data = cambiosHorario.get(key);

  if (!data || !data.hora) {
    return 'No encontré un cambio de horario pendiente. Podés decir: "cambiar hora 15:00".';
  }

  data.estado = 'confirmado';
  data.updatedAt = Date.now();
  cambiosHorario.set(key, data);

  return `Queda *confirmado* el nuevo horario: *${data.hora}*. El reparto lo tendrá en cuenta.`;
}

/**
 * Finaliza el flujo de cambio (limpia el estado en memoria).
 * @param {string} numero
 * @returns {string}
 */
export function finalizarModificacionHorario(numero) {
  const key = normalizarNumero(numero);
  const data = cambiosHorario.get(key);

  if (!data) {
    return 'No había un cambio de horario en curso. Si querés, pedime "cambiar hora HH:MM".';
  }

  cambiosHorario.delete(key);
  return 'Listo, finalicé el cambio de horario. Si necesitás otro horario, decime "cambiar hora HH:MM".';
}

// Export default opcional (por si se importa como objeto)
export default {
  modificarHorarioEntrega,
  confirmarModificacionHorario,
  finalizarModificacionHorario
};
