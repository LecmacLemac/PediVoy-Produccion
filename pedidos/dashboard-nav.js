export function applyCloudInboxNavigation(documentLike, role) {
  const item = documentLike?.querySelector?.('#whatsappCloudNavItem');
  const allowed = role === 'admin' || role === 'super';
  if (item) item.hidden = !allowed;
  return allowed;
}

export function applyCompanyManualNavigation(documentLike, role) {
  const item = documentLike?.querySelector?.('#companyManualNavItem');
  const allowed = role === 'admin' || role === 'super';
  if (item) item.hidden = !allowed;
  return allowed;
}
