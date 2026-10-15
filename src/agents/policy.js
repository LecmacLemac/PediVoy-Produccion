const all = ['user','repartidor','referente','facturacion','contable','admin','super'];
export const SCOPES = Object.freeze([
 ['identity:read','Mi identidad','Consultar identidad y permisos vigentes.',false,all],
 ['catalog:read','Catálogo','Consultar catálogo de la empresa.',false,['user','admin','super','referente']],
 ['orders:read','Pedidos','Consultar pedidos autorizados.',false,['user','admin','super']],
 ['deliveries:read','Reparto','Consultar repartos propios.',false,['repartidor']],
 ['referrals:read','Referidos','Consultar cartera propia.',false,['referente']],
 ['billing:read','Facturación','Consultar facturación autorizada.',false,['user','facturacion','contable','admin','super']],
 ['deliveries:claim','Tomar reparto','Tomar un pedido disponible.',true,['repartidor']],
 ['orders:reopen','Reabrir pedido','Reabrir pedidos cancelados autorizados.',true,['admin','super']],
].map(([scope,label,description,write,roles])=>Object.freeze({scope,label,description,write,roles:Object.freeze(roles)})));
export function allowedScopesForRole(role) { return SCOPES.filter(s=>s.roles.includes(role)).map(s=>s.scope); }
export function effectiveScopes(connection, actor) {
 const issued = allowedScopesForRole(connection.role_at_issue);
 const current = allowedScopesForRole(actor.role);
 return (connection.scopes || []).filter(s=>issued.includes(s)&&current.includes(s));
}
