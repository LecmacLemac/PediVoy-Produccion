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
