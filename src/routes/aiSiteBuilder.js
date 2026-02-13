// src/routes/aiSiteBuilder.js
// Generador Web con IA (extraído desde server.js)

import express from 'express';
import OpenAI from 'openai';

export function createAiSiteBuilderRouter(deps) {
  const { query, withAuth, isSuper, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createAiSiteBuilderRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createAiSiteBuilderRouter: falta withAuth(fn)');
  if (typeof isSuper !== 'function') throw new Error('createAiSiteBuilderRouter: falta isSuper(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createAiSiteBuilderRouter: falta getEmpresaIdFromToken(fn)');

  const router = express.Router();

  // POST /api/ai/build-site
  router.post('/build-site', withAuth, async (req, res) => {
    try {
      const { prompt, empresa_id } = req.body || {};
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const targetId = esSuperAdmin ? (Number(empresa_id) || myEmpresa) : myEmpresa;

      const empRows = await query(
        'SELECT telefono, nombre, rubro, landing_slug FROM empresas WHERE id = $1',
        [targetId]
      );

      if (!empRows.length) return res.status(404).json({ error: 'Empresa no encontrada' });
      const empresaData = empRows[0];

      const telWpp = String(empresaData.telefono || '').replace(/\D/g, '');
      const slug = empresaData.landing_slug || `empresa-${targetId}`;

      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: 'Falta API Key de OpenAI' });
      }

      const promptRows = await query(
        `SELECT contenido FROM empresa_prompts WHERE tipo = 'builder_web' AND empresa_id IS NULL LIMIT 1`
      );

      let systemPrompt = promptRows.length > 0 ? promptRows[0].contenido : 'Eres un desarrollador web...';

      systemPrompt = systemPrompt
        .replace('{ID_EMPRESA}', targetId)
        .replace('{TELEFONO_EMPRESA}', telWpp || '5491100000000')
        .replace('{SLUG_EMPRESA}', slug);

      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Empresa: ${empresaData.nombre}. Rubro: ${empresaData.rubro}. Slug: ${slug}.
            Descripción del usuario: "${prompt}".
            Genera el código HTML completo ahora.`,
          },
        ],
        temperature: 0.7,
      });

      let html = completion.choices[0].message.content;
      html = String(html || '').replace(/```html/g, '').replace(/```/g, '');

      return res.json({ html });
    } catch (e) {
      console.error('AI BUILDER ERROR:', e);
      return res.status(500).json({ error: 'Error generando sitio: ' + e.message });
    }
  });

  return router;
}
