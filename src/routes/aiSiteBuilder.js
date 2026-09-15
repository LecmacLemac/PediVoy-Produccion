// src/routes/aiSiteBuilder.js
// Generador Web con IA (extraído desde server.js)

import express from 'express';
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';

const LANDING_TEMPLATES = [
  {
    id: 'multiempresa-pro',
    name: 'Multiempresa Pro',
    vertical: 'SaaS / multi-rubro',
    tone: 'Institucional, completo y orientado a conversion',
    file: 'landing_multiempresa_pro_v2.html',
  },
  {
    id: 'neocommerce',
    name: 'NeoCommerce',
    vertical: 'Comercio moderno',
    tone: 'Tecnologico, dinamico y comercial',
    file: 'landing_multiempresa_neocommerce_v4.html',
  },
  {
    id: 'reparto-agua',
    name: 'Reparto de agua',
    vertical: 'Agua, bidones y reparto recurrente',
    tone: 'Confiable, cercano y operativo',
    file: 'landing_reparto_agua_pro_v7.html',
  },
  {
    id: 'kiosco',
    name: 'Kiosco y almacen',
    vertical: 'Kiosco, almacen y venta rapida',
    tone: 'Simple, directo y de alta rotacion',
    file: 'landing_kiosco_v1.html',
  },
  {
    id: 'panificacion',
    name: 'Panificacion y pasteleria',
    vertical: 'Panaderia, pasteleria y elaboracion',
    tone: 'Calido, artesanal y visual',
    file: 'landing_panificacion_pasteleria_pro_v6.html',
  },
  {
    id: 'limpieza',
    name: 'Distribuidora limpieza',
    vertical: 'Distribucion B2B y productos de limpieza',
    tone: 'Profesional, ordenado y mayorista',
    file: 'landing_distribuidora_limpieza_v5.html',
  },
  {
    id: 'congelados',
    name: 'Congelados mayoristas',
    vertical: 'Alimentos congelados y distribucion mayorista',
    tone: 'Fresco, confiable y orientado a abastecimiento',
    file: 'landing_congelados_alimentos_mayoristas_pro_v1.html',
  },
  {
    id: 'contenedores',
    name: 'Contenedores obra',
    vertical: 'Obra, industria y alquiler operativo',
    tone: 'Robusto, tecnico y de respuesta rapida',
    file: 'landing_contenedores_obra_industrial_v1.html',
  },
  {
    id: 'mascotas',
    name: 'Distribuidora mascotas',
    vertical: 'Alimentos y productos para mascotas',
    tone: 'Cercano, comercial y de recompra frecuente',
    file: 'landing_distribuidora_alimento_mascotas_pro_v1.html',
  },
  {
    id: 'cafeterias-gastronomia',
    name: 'Insumos gastronomia',
    vertical: 'Cafeterias, bares y gastronomia',
    tone: 'Premium, visual y B2B',
    file: 'landing_insumos_cafeterias_gastronomia_pro_v1.html',
  },
  {
    id: 'matafuegos',
    name: 'Matafuegos seguridad',
    vertical: 'Seguridad contra incendios y mantenimiento',
    tone: 'Serio, tecnico y orientado a cumplimiento',
    file: 'landing_matafuegos_seguridad_incendios_pro_v1.html',
  },
  {
    id: 'sanitarios-eventos',
    name: 'Sanitarios eventos',
    vertical: 'Eventos, obra y servicios sanitarios moviles',
    tone: 'Limpio, operativo y confiable',
    file: 'landing_sanitarios_eventos_clean_v1.html',
  },
  {
    id: 'servicios-modulares',
    name: 'Servicios modulares',
    vertical: 'Soluciones modulares corporativas',
    tone: 'Corporativo, claro y escalable',
    file: 'landing_servicios_modulares_corporativo_v1.html',
  },
  {
    id: 'corporativo',
    name: 'Corporativo',
    vertical: 'Servicios B2B y soluciones empresariales',
    tone: 'Sobrio, ejecutivo y premium',
    file: 'temple-corporativo.html',
  },
];

function getTemplatesDir(projectDir) {
  return path.join(projectDir, 'pages', 'landing');
}

function resolveTemplate(projectDir, templateId) {
  const selected = LANDING_TEMPLATES.find((template) => template.id === templateId) || null;
  if (!selected) return null;

  const templatesDir = getTemplatesDir(projectDir);
  const filePath = path.join(templatesDir, selected.file);
  const relative = path.relative(templatesDir, filePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (!fs.existsSync(filePath)) return null;

  return { ...selected, filePath };
}

function publicTemplate(template) {
  return {
    id: template.id,
    name: template.name,
    vertical: template.vertical,
    tone: template.tone,
  };
}

function compactTemplateHtml(html) {
  return String(html || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 45000);
}

export function createAiSiteBuilderRouter(deps) {
  const { query, withAuth, isSuper, getEmpresaIdFromToken, projectDir } = deps || {};
  if (typeof query !== 'function') throw new Error('createAiSiteBuilderRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createAiSiteBuilderRouter: falta withAuth(fn)');
  if (typeof isSuper !== 'function') throw new Error('createAiSiteBuilderRouter: falta isSuper(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createAiSiteBuilderRouter: falta getEmpresaIdFromToken(fn)');
  if (!projectDir) throw new Error('createAiSiteBuilderRouter: falta projectDir');

  const router = express.Router();

  router.get('/landing-templates', withAuth, (_req, res) => {
    const templates = LANDING_TEMPLATES
      .map((template) => resolveTemplate(projectDir, template.id))
      .filter(Boolean)
      .map(publicTemplate);

    return res.json({ ok: true, templates });
  });

  router.get('/landing-templates/:id', withAuth, async (req, res) => {
    try {
      const template = resolveTemplate(projectDir, req.params.id);
      if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });

      const html = await fs.promises.readFile(template.filePath, 'utf8');
      return res.json({ ok: true, template: publicTemplate(template), html });
    } catch (e) {
      console.error('LANDING TEMPLATE ERROR:', e);
      return res.status(500).json({ error: 'Error leyendo plantilla' });
    }
  });

  // POST /api/ai/build-site
  router.post('/build-site', withAuth, async (req, res) => {
    try {
      const { prompt, empresa_id, template_id } = req.body || {};
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

      const selectedTemplate = template_id ? resolveTemplate(projectDir, String(template_id)) : null;
      let templateBlock = 'Sin plantilla base seleccionada. Crear una landing desde cero respetando el sistema PediVoy.';

      if (template_id && !selectedTemplate) {
        return res.status(400).json({ error: 'Plantilla base inválida' });
      }

      if (selectedTemplate) {
        const templateHtml = await fs.promises.readFile(selectedTemplate.filePath, 'utf8');
        templateBlock = `
        Plantilla base elegida:
        - ID: ${selectedTemplate.id}
        - Nombre: ${selectedTemplate.name}
        - Vertical: ${selectedTemplate.vertical}
        - Tono: ${selectedTemplate.tone}

        Usa esta plantilla como referencia de estructura, densidad visual, jerarquia comercial y componentes.
        No copies datos falsos de la plantilla. Reemplaza nombres, telefonos, rubro, textos, CTAs y secciones con datos de la empresa real.
        Mantene el HTML final autocontenido, responsive y publicable como archivo unico.

        [HTML_REFERENCIA_PLANTILLA]
        ${compactTemplateHtml(templateHtml)}
        [/HTML_REFERENCIA_PLANTILLA]
        `;
      }

      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Empresa: ${empresaData.nombre}. Rubro: ${empresaData.rubro}. Slug: ${slug}.
            ${templateBlock}
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
