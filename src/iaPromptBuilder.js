// src/iaPromptBuilder.js
import { getPromptsCombinados, getEmpresaMetadata } from './promptsRepository.js';

// --- DEFAULTS DE ÚLTIMA INSTANCIA (Hardcoded) ---
// Estos se usan si NO configuras nada en la base de datos.
const HARD_DEFAULTS = {
  vendedor: `Eres un vendedor amable y proactivo. Tu objetivo es cerrar la venta. Si el cliente duda, ofrece alternativas.`,
  soporte: `Eres un asistente de soporte técnico empático. Pide disculpas por los inconvenientes y solicita detalles para resolver el problema.`,
  general: `Eres un asistente virtual corporativo. Responde de forma neutra y profesional.`
};

// --- REGLAS GLOBALES INQUEBRANTABLES ---
const SYSTEM_GLOBAL = `
DIRECTRICES MAESTRAS DEL SISTEMA (MANDATORIAS):
1. **Concisión**: Tus respuestas deben ser MUY breves (máximo 40 palabras si es posible). Esto es un chat de WhatsApp, no un correo.
2. **Honestidad**: NUNCA inventes precios, stock o características que no estén en el contexto. Si no lo sabes, di: "Déjame consultar eso con un humano".
3. **Formato**: Usa emojis moderadamente. Usa *negritas* para datos clave (precios, fechas).
4. **Objetivo**: Tu prioridad es llevar al usuario a la acción (comprar, agendar, o calmar un reclamo).
`;

/**
 * Construye el array de mensajes para enviar a OpenAI.
 */
export async function buildIaMessages({ 
  empresaId, 
  tipo = 'vendedor', 
  textoUsuario, 
  contextoExtra = '' 
}) {
  // 1. Obtener Prompts de la DB (Prioridad: Empresa > Global > Hardcoded)
  const promptsDb = await getPromptsCombinados(empresaId);
  
  // 2. Obtener Datos Reales de la Empresa
  const meta = await getEmpresaMetadata(empresaId);

  // 3. Seleccionar el Prompt Base según el tipo (intención)
  const promptPrincipal = 
    promptsDb[tipo] || 
    promptsDb['general'] || 
    HARD_DEFAULTS[tipo] || 
    HARD_DEFAULTS.general;

  // 4. Construir Identidad Dinámica (Contexto del Negocio)
    let identidadEmpresa = '';
    if (meta) {
        // AGREGAMOS SLUG E ID AQUÍ PARA QUE LA IA LOS LEA
        identidadEmpresa = `
  === IDENTIDAD DEL NEGOCIO ===
  - Nombre: ${meta.nombre}
  - Rubro: ${meta.rubro}
  - Lo que vendemos: ${meta.etiquetas}
  - Link Oficial: ${meta.link}
  - ID Tienda: ${meta.id || 'No definido'} 
  - Slug/Alias: ${meta.landing_slug || 'No definido'}

  INSTRUCCIONES DE NEGOCIO:
  - Si preguntan por productos, asume que los tenemos y dirígelos a la web.
  - Si no pueden entrar al link, dales el ID (${meta.id}) o el Alias (${meta.landing_slug}) para buscar manualmente.
  - SIEMPRE que menciones un precio o catálogo, añade el link: ${meta.link}
  `;
    }

  // 5. Ensamblaje del Prompt del Sistema (Orden Lógico)
  const systemContent = [
    SYSTEM_GLOBAL,                    // 1. Reglas de comportamiento (tono, longitud)
    identidadEmpresa,                 // 2. Quién eres (empresa, rubro)
    `--- ROL ACTUAL: ${tipo.toUpperCase()} ---`, // 3. Qué sombrero llevas puesto hoy
    promptPrincipal,                  // 4. Instrucción específica (vender/soporte)
    contextoExtra ? `\n--- DATOS EN TIEMPO REAL ---\n${contextoExtra}` : '' // 5. Datos frescos (stock, deuda, etc)
  ].join('\n\n');

  // Retornamos formato OpenAI
  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: textoUsuario }
  ];
}