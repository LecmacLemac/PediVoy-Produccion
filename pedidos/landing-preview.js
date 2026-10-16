/* Preview runs with an opaque origin and offline public API snapshots. */
let landingPreviewGeneration = 0;

function buildLandingPreview(html, slug, config, products, menu = null) {
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
  const snapshot = JSON.stringify({ slug, config, products, menu }).replace(/</g, '\\u003c');
  bootstrap.textContent = `(() => {
    const data = ${snapshot};
    window.LANDING_PREVIEW = Object.freeze({ slug: data.slug, config: data.config });
    window.fetch = async (input, options = {}) => {
      const url = new URL(String(input), 'https://preview.invalid');
      if (options.method && options.method.toUpperCase() !== 'GET') throw new Error('Preview is read only');
      let body;
      if (url.pathname === '/public/config' && url.searchParams.get('slug') === data.slug) body = data.config;
      else if (['/public/productos', '/api/public/productos'].includes(url.pathname) && (
        url.searchParams.get('slug') === data.slug
        || url.searchParams.get('empresa_id') === String(data.config.empresa_id)
      )) body = data.products;
      else if (['/public/menu', '/api/public/menu'].includes(url.pathname) && data.menu && (
        url.searchParams.get('slug') === data.slug
        || url.searchParams.get('empresa_id') === String(data.config.empresa_id)
      ) && (!url.searchParams.has('fecha_entrega') || url.searchParams.get('fecha_entrega') === data.menu.selected_date)) body = data.menu;
      else throw new Error('API unavailable in preview');
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    };
  })();`;
  doc.head.prepend(policy, bootstrap);
  if (menu?.enabled && /^\d{4}-\d{2}-\d{2}$/.test(menu.selected_date || '')) {
    const notice = doc.createElement('aside');
    notice.id = 'landingPreviewMenuNotice';
    notice.dataset.date = menu.selected_date;
    notice.textContent = 'Vista previa del menú · ' + menu.selected_date.split('-').reverse().join('/');
    notice.style.cssText = 'padding:12px;font:14px sans-serif;background:#eef6ff;color:#15334f;border-bottom:1px solid #c9d9ec';
    doc.body.prepend(notice);
  }
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

async function showLandingPreview(html, empresa, { deliveryDate } = {}) {
  const generation = ++landingPreviewGeneration;
  const current = () => generation === landingPreviewGeneration && Number(currentEmpresaId) === Number(empresa.id);
  const slug = String(empresa?.landing_slug || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(slug)) throw new Error('Configurá un slug válido para la empresa');
  const response = await fetch(`/public/config?slug=${encodeURIComponent(slug)}`, { credentials: 'omit' });
  if (!response.ok) throw new Error('No se pudo cargar la empresa');
  const config = await response.json();
  if (Number(config.empresa_id) !== Number(empresa.id)) throw new Error('El slug no corresponde a la empresa seleccionada');
  if (!current()) return;
  const params = new URLSearchParams({ slug });
  if (deliveryDate) params.set('fecha_entrega', deliveryDate);
  const metadataResponse = await fetch(`/public/menu?${params}`, { credentials: 'omit', cache: 'no-store' });
  let menu = { enabled: false };
  if (metadataResponse.ok) menu = await metadataResponse.json();
  else if (metadataResponse.status !== 404 || deliveryDate) throw new Error('No se pudo verificar la fecha del menú');
  if (!current()) return;
  const catalogParams = new URLSearchParams({ slug, scope: 'landing' });
  if (menu.enabled) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(menu.selected_date || '') || !Array.isArray(menu.dates)) throw new Error('Fecha de menú inválida');
    if (deliveryDate && menu.selected_date !== deliveryDate) throw new Error('La fecha seleccionada no está disponible');
    catalogParams.set('fecha_entrega', menu.selected_date);
  } else if (deliveryDate) throw new Error('Los pedidos anticipados no están habilitados');
  const catalog = await fetch(`/public/productos?${catalogParams}`, { credentials: 'omit', cache: 'no-store' });
  if (!catalog.ok) throw new Error('No se pudo cargar el catálogo');
  const htmlPreview = buildLandingPreview(html, slug, config, await catalog.json(), menu);
  if (!current()) return;
  const frame = document.getElementById('previewFrame');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.srcdoc = htmlPreview;
  document.getElementById('landingPreviewMenuControls')?.remove();
  if (menu.enabled) {
    const controls = document.createElement('section');
    controls.id = 'landingPreviewMenuControls';
    controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px';
    const title = document.createElement('strong'); title.textContent = 'Vista previa por fecha'; controls.append(title);
    if (menu.advance_enabled) {
      const label = document.createElement('label'); label.textContent = 'Menú: ';
      const select = document.createElement('select'); select.id = 'landingPreviewDate'; select.setAttribute('aria-label', 'Fecha de vista previa'); select.style.cssText = 'min-height:44px;font:inherit;max-width:100%';
      for (const date of [...new Set([menu.today, ...menu.dates])].sort()) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) continue;
        const option = document.createElement('option'); option.value = date; option.textContent = (date === menu.today ? 'Hoy · ' : '') + date.split('-').reverse().join('/'); option.selected = date === menu.selected_date; select.append(option);
      }
      select.addEventListener('change', async () => {
        const acceptedDate = menu.selected_date;
        select.disabled = true;
        controls.querySelector('[role="alert"]')?.remove();
        try { await showLandingPreview(html, empresa, { deliveryDate: select.value }); }
        catch {
          if (!controls.isConnected || Number(currentEmpresaId) !== Number(empresa.id)) return;
          select.value = acceptedDate;
          const error = document.createElement('span'); error.setAttribute('role', 'alert'); error.textContent = 'No se pudo cargar esa fecha. Se conserva la vista anterior.'; controls.append(error);
        } finally { if (controls.isConnected) select.disabled = false; }
      });
      label.append(select); controls.append(label);
    }
    const note = document.createElement('span'); note.textContent = 'Sólo vista previa; no guarda cambios ni pedidos.'; controls.append(note);
    frame.before(controls);
  }
}
