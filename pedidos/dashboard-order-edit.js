export function createPedidoEditCoordinator() {
  let generation = 0;
  let active = null;
  return {
    begin({ id, finalized }) {
      const context = Object.freeze({ generation: ++generation, id: Number(id), finalized: finalized === true });
      active = { context, ready: false };
      return context;
    },
    isActive(context) {
      return context === active?.context;
    },
    commit(context, apply) {
      if (context !== active?.context) return false;
      apply();
      return true;
    },
    markReady(context) {
      if (context !== active?.context) return false;
      active.ready = true;
      return true;
    },
    canSave(context) {
      return context === active?.context && active.ready === true;
    },
    capture() {
      return active?.context || null;
    },
  };
}

export function isPedidoFinalizado(estado) {
  return estado === 'entregado' || estado === 'cancelado';
}

export function buildPedidoSavePlan({
  finalized,
  items,
  estado,
  metodoPago,
  empresaId,
  choferId,
  zonaId,
}) {
  if (finalized) {
    return {
      updateItems: false,
      items: null,
      pedidoBody: {
        metodo_pago: metodoPago,
        chofer_id: choferId,
        zona_id: zonaId,
      },
    };
  }

  return {
    updateItems: true,
    items,
    pedidoBody: {
      estado,
      metodo_pago: metodoPago,
      empresa_id: empresaId,
      chofer_id: choferId,
      zona_id: zonaId,
    },
  };
}

export function applyFinalizedOrderControls({
  finalized,
  estado,
  empresa,
  addItem,
  itemsBody,
  notice,
}) {
  estado.disabled = finalized;
  empresa.disabled = finalized;
  addItem.disabled = finalized;
  itemsBody.querySelectorAll('input, button').forEach((control) => {
    control.disabled = finalized;
  });
  notice.hidden = !finalized;
  notice.textContent = finalized
    ? 'Los ítems quedan protegidos. Se permiten correcciones administrativas de método de pago, chofer y zona.'
    : '';
}
