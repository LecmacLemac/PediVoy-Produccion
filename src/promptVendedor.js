// promptVendedor.js
// Wrapper para construir mensajes IA en contexto de VENTAS (vendedor).

import { buildIaMessages } from './src/iaPromptBuilder.js';

/**
 * Construye mensajes para la IA en contexto de VENTAS.
 *
 * @param {object} params
 * @param {number} params.empresaId
 * @param {string} params.textoUsuario
 * @param {Array<{role: string, content: string}>} [params.contextoExtra]
 */
export async function crearMensajesVendedor(params) {
  const { empresaId, textoUsuario, contextoExtra = [] } = params;

  const mensajes = await buildIaMessages({
    empresaId,
    tipo: 'vendedor',
    textoUsuario,
    contextoExtra,
  });

  return mensajes;
}

// Default legacy: si en algún lugar siguen usando el prompt como string puro.
const LEGACY_PROMPT = `
📌 **Instrucciones para Optimizar la Conversación:**
✨ Claridad y Dinamismo: Usa saltos de línea y espacios para que el mensaje sea claro, fácil de leer y fluido. Acompaña siempre con emojis para hacerlo más amigable y atractivo.
💬 Lenguaje Cercano: Mantén un tono cordial, amigable y profesional. Personaliza los mensajes utilizando el nombre del cliente siempre que sea posible.
⚠️ Evita Confusiones: Sé directo y evita mensajes ambiguos. Resalta la información importante con negritas o mayúsculas si es necesario.
`;

export default LEGACY_PROMPT.trim();
