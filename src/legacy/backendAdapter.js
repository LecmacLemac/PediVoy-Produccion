import { notifyEstadoPedidoPush, getEmpresaById, registerOrderRoutes } from '../../backend.js';

export function createLegacyBackendDeps() {
  return {
    notifyEstadoPedidoPush,
    getEmpresaById,
    registerOrderRoutes,
  };
}
