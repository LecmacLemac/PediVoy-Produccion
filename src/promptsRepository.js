// src/promptsRepository.js
import { query } from './db.js';

/**
 * Obtiene los prompts combinando los de la empresa específica y los globales.
 * Estrategia de Cascada:
 * 1. Carga los Globales (empresa_id IS NULL).
 * 2. Carga los Específicos (empresa_id = X) y SOBRESCRIBE a los globales.
 */
export async function getPromptsCombinados(empresaId) {
  // Consultamos ambos casos: Específico O Global
  // Usamos "ORDER BY empresa_id ASC NULLS FIRST" para que los globales (NULL)
  // vengan primero en la lista y los específicos (ID) vengan después.
  const rowsPrompts = await query(
    `SELECT empresa_id, tipo, contenido
       FROM empresa_prompts
      WHERE empresa_id = $1 OR empresa_id IS NULL
      ORDER BY empresa_id ASC NULLS FIRST`,
    [empresaId]
  );

  const prompts = {};

  // Al iterar, el específico sobrescribirá al global porque viene después en el array
  for (const row of rowsPrompts) {
    if (row.tipo && row.contenido) {
      prompts[row.tipo] = row.contenido;
    }
  }

  // Compatibilidad con columnas viejas (Legacy) de la tabla empresas
  // Esto tiene prioridad máxima sobre los prompts de la tabla nueva si existen
  if (empresaId) {
    const rowsEmpresa = await query(
      `SELECT prompt_ia_vendedor, prompt_ia_general
         FROM empresas
        WHERE id = $1`,
      [empresaId]
    );

    if (rowsEmpresa.length) {
      const emp = rowsEmpresa[0];
      if (emp.prompt_ia_vendedor) prompts.vendedor = emp.prompt_ia_vendedor;
      if (emp.prompt_ia_general)  prompts.general  = emp.prompt_ia_general;
    }
  }

  return prompts;
}

/**
 * Obtiene datos clave de la empresa para inyectar contexto a la IA.
 * Incluye Rubro y Etiquetas para personalizar prompts globales.
 */
export async function getEmpresaMetadata(empresaId) {
  if (!empresaId) return null;
  
  const rows = await query(
    `SELECT nombre, rubro, etiquetas, landing_domain, landing_slug 
     FROM empresas 
     WHERE id = $1`,
    [empresaId]
  );
  
  if (!rows.length) return null;
  const e = rows[0];

  // Construir link absoluto para invitar a la compra
  let link = '';
  if (e.landing_domain) {
      // Si tiene dominio propio
      link = `https://${e.landing_domain}`;
  } else if (e.landing_slug) {
      // Si usa slug en tu plataforma (Ajusta 'tudominio.com' al tuyo real)
      link = `https://aguahidro.com.ar/?slug=${e.landing_slug}`;
  } else {
      // Fallback por ID
      link = `https://aguahidro.com.ar/?empresa_id=${empresaId}`;
  }

  return {
      id: empresaId,                
      landing_slug: e.landing_slug,  
      nombre: e.nombre,
      rubro: e.rubro || 'Comercio General',
      etiquetas: e.etiquetas || '',
      link: link
  };
}

/**
 * Guarda o actualiza un prompt.
 * Si pasas empresaId = null, guarda un Global.
 */
export async function upsertEmpresaPrompt(empresaId, tipo, contenido) {
  if (!tipo) throw new Error('Tipo requerido');
  
  if (empresaId) {
      // Caso Empresa Específica
      await query(
        `INSERT INTO empresa_prompts (empresa_id, tipo, contenido, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (empresa_id, tipo)
         DO UPDATE SET contenido = EXCLUDED.contenido, updated_at = NOW()`,
        [empresaId, tipo, contenido]
      );
  } else {
      // Caso Global (empresa_id IS NULL)
      // Borramos primero para asegurar limpieza en caso de índices parciales complejos
      await query(`DELETE FROM empresa_prompts WHERE empresa_id IS NULL AND tipo = $1`, [tipo]);
      await query(
        `INSERT INTO empresa_prompts (empresa_id, tipo, contenido, updated_at)
         VALUES (NULL, $1, $2, NOW())`,
        [tipo, contenido]
      );
  }
}