# Referentes PediVoy

Fecha: 2026-05-19

## Objetivo

Permitir que cada empresa de PediVoy tenga referentes, vendedores o aliados comerciales que puedan compartir un codigo y comisionar por ventas entregadas de productos asociados.

## Decisiones funcionales

- El referente pertenece a una empresa.
- El referente tiene un codigo propio, distinto de cualquier codigo de descuento.
- Cuando un cliente usa el codigo de referente, queda asociado a ese referente.
- La asociacion cliente-referente se mantiene hasta que administracion la desvincule o elimine/desactive al referente.
- La comision se valida solamente cuando el pedido cambia a estado `entregado`.
- La comision se calcula sobre porcentaje de venta de productos asociados al referente.
- La empresa define el porcentaje y la vigencia del referente.
- La empresa puede asociar productos puntuales al referente y, si hace falta, definir porcentaje diferente por producto.
- El calculo de comisiones debe ser idempotente: un pedido entregado no puede generar dos veces la misma comision.

## Codigos

### Codigo de referente

Uso: asociar cliente con referente.

Reglas:

- Es persistente.
- No modifica necesariamente el precio del pedido.
- Puede usarse en el primer pedido publico.
- Si el cliente ya tiene un referente activo, no se lo cambia automaticamente.
- Administracion puede desvincular al cliente.

### Codigo de descuento

Uso: beneficio comercial de una unica compra.

Reglas:

- Es independiente del codigo de referente.
- Puede afectar precio del cliente.
- Puede tambien disparar comision para el referente si fue configurado asi.
- No reemplaza la asociacion permanente cliente-referente salvo regla explicita futura.

## Etapa 1 implementada

Alcance inicial:

- Modelo de datos para referentes, productos asociados, clientes asociados y comisiones.
- Captura de `codigo_referente` o `referral_code` en `POST /public/pedidos`.
- Asociacion automatica de cliente a referente si el codigo existe y esta vigente.
- Generacion de comisiones cuando un pedido pasa a `entregado`.
- Endpoints admin basicos para gestionar referentes.
- Pantalla inicial de administracion en `/pedidos/referentes.html`.

Fuera de esta primera etapa:

- Motor completo de codigos de descuento.
- Liquidacion/pago contable de comisiones.
- Reporte avanzado por periodos.

## Endpoints base

- `GET /api/referentes`
- `POST /api/referentes`
- `PUT /api/referentes/:id`
- `DELETE /api/referentes/:id`
- `GET /api/referentes/:id/productos`
- `POST /api/referentes/:id/productos`
- `GET /api/referentes/comisiones`
- `POST /api/referentes/clientes/:clienteId/desvincular`

## Criterio de control

La empresa debe poder auditar:

- quien es el referente,
- que codigo uso,
- que cliente quedo asociado,
- que pedido genero comision,
- que producto comisiono,
- que porcentaje se aplico,
- en que fecha quedo validada la comision.
