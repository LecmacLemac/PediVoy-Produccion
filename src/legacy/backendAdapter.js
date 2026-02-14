import { notifyEstadoPedidoPush, getEmpresaById } from '../../backend.js';

export function createLegacyBackendDeps() {
  return {
    notifyEstadoPedidoPush,
    getEmpresaById,
  };
}
