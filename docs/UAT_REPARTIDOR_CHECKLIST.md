# UAT rápido · Dashboard Repartidor

Objetivo: validar en una sesión autenticada que el dashboard del repartidor quedó operativo después de la modularización.

## Alcance

- `pedidos/repartidor.html`
- Pedidos y filtros
- Estados del pedido
- Entrega + activos
- Pago QR
- Mapa + GPS
- Gastos, stock, resumen, transferencias y evidencias

---

## Preparación (5 min)

1. Iniciar sesión válida en `http://localhost:3000/pedidos/login.html`.
2. Usar un repartidor con pedidos de prueba.
3. Tener al menos estos casos cargados:
   - 1 pedido pendiente sin activos
   - 1 pedido con activos
   - 1 pedido con pago por transferencia
   - 1 transferencia verificada
4. Si se prueba GPS, usar navegador con permisos habilitados.
5. Registrar commit probado.

---

## Casos UAT

> Estado sugerido por caso: `OK` / `PENDIENTE` / `FALLA`.

### UAT-01 · Login y carga inicial
- **Paso:** abrir `repartidor.html` con sesión iniciada.
- **Esperado:** entra al dashboard sin rebote a login, carga tarjetas y no muestra errores visibles.

### UAT-02 · Refresco manual de pedidos
- **Paso:** usar botón de refresco de pedidos.
- **Esperado:** actualiza listado sin romper filtros ni acciones.

### UAT-03 · Filtros de pedidos
- **Paso:** probar `Estado`, `Zona`, `Hoy` y búsqueda por texto.
- **Esperado:** las cards reflejan exactamente los filtros activos.

### UAT-04 · Inicio de ruta
- **Paso:** pasar un pedido de `pendiente` a `en_ruta`.
- **Esperado:** cambia estado, persiste al refrescar y no rompe GPS/mapa.

### UAT-05 · Pausa / vuelta a pendiente
- **Paso:** desde un pedido activo, usar `Pausar (Pendiente)`.
- **Esperado:** vuelve a pendiente y sigue operable.

### UAT-06 · Cancelación
- **Paso:** cancelar un pedido de prueba.
- **Esperado:** pide confirmación, cambia estado y desaparece de la lista activa si corresponde.

### UAT-07 · Entrega simple sin activos
- **Paso:** entregar pedido sin activos.
- **Esperado:** confirma entrega completa sin errores y actualiza el listado.

### UAT-08 · Entrega con activos
- **Paso:** abrir flujo de activos, seleccionar equipos y confirmar entrega.
- **Esperado:** registra entrega, movimientos y evidencia sin inconsistencias visibles.

### UAT-09 · Flujo escáner de activos
- **Paso:** abrir modal de escaneo, cargar al menos una entrega o retiro y confirmar.
- **Esperado:** procesa movimientos y deja el pedido actualizado.

### UAT-10 · Pago QR
- **Paso:** en pedido con transferencia y QR habilitado, abrir QR y luego marcar `Ya pagó`.
- **Esperado:** genera QR, cierra modal y continúa al flujo normal de entrega.

### UAT-11 · Cambio de método de pago
- **Paso:** alternar entre `efectivo` y `transferencia` en un pedido válido.
- **Esperado:** guarda el cambio y se refleja al refrescar.

### UAT-12 · Mapa y GPS
- **Paso:** entrar a pestaña mapa, verificar render y probar activación GPS.
- **Esperado:** mapa carga, no rompe UI y el estado GPS responde a permisos del navegador.

### UAT-13 · Gastos
- **Paso:** cargar un gasto, editarlo y eliminar uno de prueba.
- **Esperado:** historial y totales se actualizan correctamente.

### UAT-14 · Stock del repartidor
- **Paso:** abrir pestaña stock y refrescar.
- **Esperado:** lista stock sin errores y con datos consistentes.

### UAT-15 · Resumen
- **Paso:** abrir resumen diario y copiar texto.
- **Esperado:** calcula importes y copia un resumen coherente.

### UAT-16 · Transferencias verificadas
- **Paso:** abrir pestaña transferencias.
- **Esperado:** muestra verificadas sin romper la vista.

### UAT-17 · Evidencias
- **Paso:** abrir evidencias, cambiar rango de fechas y refrescar.
- **Esperado:** lista responde a fechas y no genera errores de carga.

### UAT-18 · Navegación entre secciones
- **Paso:** recorrer todas las pestañas del dashboard.
- **Esperado:** no hay pantallas en blanco, listeners duplicados ni errores visibles.

---

## Criterio de salida

Se considera aprobado si:
- `18/18` casos están `OK`, o
- `16+` están `OK` y no hay fallas críticas en:
  - login/carga inicial
  - cambio de estado
  - entrega
  - activos
  - QR

---

## Hallazgos (completar durante prueba)

- Fecha:
- Probador:
- Commit probado:
- Hallazgos críticos:
- Hallazgos menores:
- Decisión: `Aprobado` / `Aprobado con observaciones` / `No aprobado`
