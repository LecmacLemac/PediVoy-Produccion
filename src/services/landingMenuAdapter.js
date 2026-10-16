// Inject only trusted numeric tenant identity; stored tenant HTML stays untouched.
export function injectLandingMenuAdapter(html, empresaId) {
  const id=Number(empresaId);
  if(!Number.isSafeInteger(id)||id<=0)throw new Error('Empresa inválida para la carta');
  if(html.includes('data-pedivoy-menu-adapter'))return html;
  const script=`<script src="/pedidos/landing-menu-programado.js" data-menu-empresa="${id}" data-pedivoy-menu-adapter></script>`;
  if(/<head\b[^>]*>/i.test(html))return html.replace(/<head\b[^>]*>/i,head=>head+script);
  return script+html;
}
