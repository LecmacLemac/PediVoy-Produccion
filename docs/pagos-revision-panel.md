# Panel de revisión manual de transferencias

En `/pedidos/pagos.html`, tanto “Revisar y validar” como el visor del comprobante abren un único diálogo. Abrirlo no aprueba ni modifica el pago.

## Contenido

- Comprobante como imagen o PDF, con alternativa para abrir en otra pestaña.
- Cliente, pedido y empresa del registro seleccionado.
- Importe del pedido e importe registrado en el comprobante por separado. La comparación no sustituye la revisión de la imagen ni confirma el ingreso bancario.
- Selector de cuentas activas de la empresa del comprobante, sin escribir IDs ni cambiar los filtros del listado.
- Número de operación, motivo y referencia de auditoría. La operación y la cuenta ya registradas no se reemplazan desde esta aprobación.
- Confirmación explícita, inicialmente desmarcada, de haber revisado el comprobante y el ingreso en la cuenta seleccionada.

La aprobación envía `POST /api/transferencias/:id/verificar?enviarAviso=0`. No pregunta ni solicita enviar avisos al cliente desde este flujo. Las otras acciones de contacto de la pantalla no cambian.

## Controles preservados

La aprobación sigue siendo manual, sin consulta al banco. Se conservan autenticación real, roles administrativos, autoridad de empresa, cuenta activa, método de pago, coincidencia de importes, controles de duplicados y transacción de aprobación. El listado acota también los joins de pedido, punto, zona y cuenta a la empresa del comprobante.

El botón queda deshabilitado durante el envío, ante diferencias de importe o datos obligatorios ausentes. Los pagos aprobados se abren en modo consulta. Los errores de negocio se muestran dentro del panel. Ante un resultado transaccional desconocido o una pérdida de conexión durante el envío, se bloquea la repetición para ese usuario/empresa/comprobante en la sesión de la pestaña y se pide conciliación manual; el bloqueo de interfaz no sustituye los controles del servidor.

## Verificación local

```sh
NODE_ENV=test node --test \
  tests/pagos-revision-panel.test.js \
  tests/transferencias-frontend-contract.test.js \
  tests/transferencias-router-auth.test.js \
  tests/transferencias-manual-approval.test.js \
  tests/transferencias-approval.test.js \
  tests/transferencias-cuentas-bancarias.test.js \
  tests/p0-transferencias-tenant-postgres.test.js
```

La prueba de navegador carga el HTML real con APIs y comprobantes explícitamente sintéticos; no usa pedidos, cuentas ni contactos reales. Comprueba imágenes y carga completa del visor PDF nativo, aislamiento entre empresas, filtros intactos, ausencia de prompts y escrituras al abrir, envío sin aviso, doble clic, diferencia de importes, rechazo por operación duplicada, bloqueo tras resultado desconocido, consulta de aprobados y dimensiones de escritorio/móvil. Las pruebas de PostgreSQL usan un clúster aislado.

Las capturas se guardan en `TMPDIR`: `pagos-revision-desktop.png` y `pagos-revision-mobile.png`.

Este cambio no requiere variables de entorno nuevas ni un despliegue automático.
