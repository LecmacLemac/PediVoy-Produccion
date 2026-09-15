/* Preview runs with an opaque origin and offline public API snapshots. */
function buildLandingPreview(html, slug, config, products) {
  if (!/^[a-z0-9_-]+$/.test(slug || '')) throw new Error('Configurá un slug válido para la empresa');
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  doc.querySelectorAll('base, meta[http-equiv], script[src]').forEach(node => node.remove());
  // Bundled templates resolve location themselves; srcdoc has no tenant pathname.
  doc.querySelectorAll('script').forEach(node => {
    node.textContent = node.textContent.replace(/function resolveSlug\(\)\s*\{/, `function resolveSlug(){ return ${JSON.stringify(slug)};`);
  });
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; img-src https: data:; font-src https:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";
  const bootstrap = doc.createElement('script');
  const snapshot = JSON.stringify({ slug, config, products }).replace(/</g, '\\u003c');
  bootstrap.textContent = `(() => {
    const data = ${snapshot};
    window.LANDING_PREVIEW = Object.freeze({ slug: data.slug, config: data.config });
    window.fetch = async (input, options = {}) => {
      const url = new URL(String(input), 'https://preview.invalid');
      if (options.method && options.method.toUpperCase() !== 'GET') throw new Error('Preview is read only');
      let body;
      if (url.pathname === '/public/config' && url.searchParams.get('slug') === data.slug) body = data.config;
      else if (['/public/productos', '/api/public/productos'].includes(url.pathname) && url.searchParams.get('empresa_id') === String(data.config.empresa_id)) body = data.products;
      else throw new Error('API unavailable in preview');
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    };
  })();`;
  doc.head.prepend(policy, bootstrap);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

async function showLandingPreview(html, empresa) {
  const slug = String(empresa?.landing_slug || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(slug)) throw new Error('Configurá un slug válido para la empresa');
  const response = await fetch(`/public/config?slug=${encodeURIComponent(slug)}`, { credentials: 'omit' });
  if (!response.ok) throw new Error('No se pudo cargar la empresa');
  const config = await response.json();
  if (Number(config.empresa_id) !== Number(empresa.id)) throw new Error('El slug no corresponde a la empresa seleccionada');
  const catalog = await fetch(`/public/productos?empresa_id=${encodeURIComponent(config.empresa_id)}&scope=landing`, { credentials: 'omit' });
  if (!catalog.ok) throw new Error('No se pudo cargar el catálogo');
  const htmlPreview = buildLandingPreview(html, slug, config, await catalog.json());
  // Discard an in-flight preview after changing the selected company.
  if (Number(currentEmpresaId) !== Number(empresa.id)) return;
  const frame = document.getElementById('previewFrame');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.srcdoc = htmlPreview;
}
