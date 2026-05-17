# Integracion Directa AFIP/ARCA

Fecha: 2026-05-15  
Decision: avanzar con integracion directa AFIP/ARCA para que cada empresa pueda emitir comprobantes desde PediVoy cuando el cliente requiera factura.

## Resumen ejecutivo

PediVoy debe actuar como herramienta tecnica de emision para cada empresa, no como emisor fiscal propio salvo que el modelo comercial/legal cambie.

La factura debe salir con el CUIT, punto de venta, condicion fiscal y certificado de la empresa que presta o vende el servicio/producto. PediVoy guarda la solicitud, ejecuta la comunicacion con AFIP/ARCA, registra CAE y conserva trazabilidad.

Prioridad: alta para profesionalizacion del producto, pero con implementacion controlada. El primer objetivo no es automatizar todos los casos fiscales, sino cubrir venta local comun con factura electronica basica y auditoria completa.

## Alcance del MVP

Incluido:

- Configuracion fiscal por empresa.
- Carga segura de certificado/clave o mecanismo equivalente para WSAA.
- Solicitud de factura asociada a pedido.
- Datos fiscales del receptor.
- Emision de factura electronica mediante WSAA + WSFEv1.
- Registro de CAE, vencimiento CAE, tipo/nro de comprobante, punto de venta, importe y estado.
- Reintento controlado ante errores temporales.
- Historial/auditoria de requests y responses fiscales.
- Generacion o almacenamiento de PDF de factura.
- Descarga desde panel empresa y, si corresponde, enlace para cliente.

No incluido en primera etapa:

- Nota de credito/debito automatica.
- Percepciones complejas.
- Factura de credito electronica MiPyME.
- Multi-jurisdiccion avanzada.
- Libro IVA digital automatizado.
- Integraciones contables externas.

## Criterio operativo

El flujo debe ser por empresa:

1. La empresa carga o valida su configuracion fiscal.
2. El cliente pide factura durante o despues del pedido.
3. PediVoy valida datos fiscales minimos.
4. La empresa confirma emision o el sistema emite automaticamente si la empresa lo habilito.
5. PediVoy solicita autorizacion a AFIP/ARCA.
6. Si AFIP/ARCA aprueba, PediVoy guarda comprobante + CAE.
7. Si AFIP/ARCA rechaza, queda estado rechazado con motivo visible para correccion.

## Datos fiscales por empresa

Tabla sugerida: `empresa_facturacion_config`

Campos principales:

- `id`
- `empresa_id`
- `cuit`
- `razon_social`
- `condicion_iva`: monotributo, responsable_inscripto, exento, etc.
- `punto_venta`
- `modo_afip`: homologacion, produccion
- `certificado_ref`: referencia segura al certificado, no exponer en UI
- `clave_ref`: referencia segura a la clave privada, no exponer en UI
- `wsaa_token_encrypted`
- `wsaa_sign_encrypted`
- `wsaa_expires_at`
- `activo`
- `created_at`
- `updated_at`

Regla: nunca guardar certificados, claves, token o sign en texto plano. Deben cifrarse o delegarse a un secreto externo.

## Datos fiscales del cliente

PediVoy ya tiene `puntos_entrega.email_facturacion`. Para facturacion directa hace falta ampliar o crear tabla dedicada.

Tabla sugerida: `cliente_datos_fiscales`

- `id`
- `empresa_id`
- `punto_entrega_id`
- `tipo_documento`: CUIT, DNI, CUIL
- `numero_documento`
- `razon_social`
- `condicion_iva`
- `domicilio_fiscal`
- `email_facturacion`
- `created_at`
- `updated_at`

Regla: validar CUIT cuando aplique. Si falta condicion IVA o domicilio fiscal, no emitir automaticamente.

## Solicitudes y comprobantes

Tabla sugerida: `facturas`

- `id`
- `empresa_id`
- `pedido_id`
- `punto_entrega_id`
- `cliente_datos_fiscales_id`
- `estado`: borrador, pendiente_confirmacion, emitiendo, emitida, rechazada, anulada
- `modo_afip`: homologacion, produccion
- `tipo_comprobante`: A, B, C segun reglas fiscales
- `codigo_comprobante_afip`
- `punto_venta`
- `numero_comprobante`
- `concepto`: productos, servicios, productos_y_servicios
- `fecha_comprobante`
- `importe_neto`
- `importe_iva`
- `importe_total`
- `cae`
- `cae_vencimiento`
- `pdf_url`
- `error_codigo`
- `error_mensaje`
- `created_at`
- `updated_at`

Tabla sugerida: `factura_items`

- `id`
- `factura_id`
- `producto_id`
- `descripcion`
- `cantidad`
- `precio_unitario`
- `alicuota_iva`
- `importe_neto`
- `importe_iva`
- `importe_total`

Tabla sugerida: `factura_afip_auditoria`

- `id`
- `empresa_id`
- `factura_id`
- `servicio`: WSAA, WSFEv1
- `operacion`
- `request_xml`
- `response_xml`
- `resultado`
- `error_codigo`
- `error_mensaje`
- `created_at`

Regla: auditoria completa, pero con cuidado de no exponer secretos ni datos sensibles innecesarios.

## Servicios tecnicos

Modulos sugeridos:

- `src/integrations/arca/wsaaClient.js`
- `src/integrations/arca/wsfeClient.js`
- `src/services/facturacionService.js`
- `src/services/facturacionPdfService.js`
- `src/routes/facturacionRoutes.js`

Responsabilidades:

- `wsaaClient`: generar TRA, firmar, obtener token/sign y cachear vencimiento.
- `wsfeClient`: consultar ultimo comprobante, emitir comprobante, interpretar errores.
- `facturacionService`: reglas de negocio, estados, validaciones, persistencia.
- `facturacionPdfService`: crear representacion PDF de la factura.
- `facturacionRoutes`: endpoints de panel empresa y operaciones autorizadas.

## Endpoints sugeridos

Empresa:

- `GET /api/facturacion/config`
- `PUT /api/facturacion/config`
- `POST /api/facturacion/config/certificado`
- `POST /api/facturacion/config/probar-conexion`

Cliente/pedido:

- `POST /api/pedidos/:pedidoId/factura/solicitar`
- `GET /api/pedidos/:pedidoId/factura`

Panel empresa:

- `GET /api/facturas`
- `GET /api/facturas/:id`
- `POST /api/facturas/:id/emitir`
- `GET /api/facturas/:id/pdf`

Control:

- Solo usuarios de la empresa pueden ver/emitir sus facturas.
- Superadmin puede auditar, pero no debe emitir en nombre de una empresa sin autorizacion operativa.

## Reglas fiscales iniciales

Estas reglas deben validarse con contable antes de produccion:

- Empresa monotributista: normalmente emite comprobante C.
- Responsable inscripto a consumidor final o monotributista: normalmente comprobante B.
- Responsable inscripto a responsable inscripto: normalmente comprobante A.
- La condicion IVA del receptor define tipo de comprobante y desglose de IVA.
- El punto de venta debe estar habilitado para factura electronica.
- La numeracion debe salir de AFIP/ARCA, consultando el ultimo comprobante antes de emitir.

## Estados

- `borrador`: datos incompletos o preparacion interna.
- `pendiente_confirmacion`: cliente pidio factura, empresa debe revisar.
- `emitiendo`: proceso en curso.
- `emitida`: AFIP/ARCA aprobo y devolvio CAE.
- `rechazada`: AFIP/ARCA rechazo o validacion fiscal fallo.
- `anulada`: no equivale a anulacion fiscal; para cancelar comprobante emitido se debe gestionar nota de credito.

## Seguridad

Puntos criticos:

- Certificados y claves privadas por empresa.
- Token/sign de WSAA.
- CUIT y datos fiscales de clientes.
- Auditoria de comprobantes emitidos.

Medidas minimas:

- Cifrado de secretos.
- Separacion estricta por `empresa_id`.
- Logs sin claves privadas, token/sign ni certificado completo.
- Auditoria de usuario que emite.
- Validacion de permisos en cada endpoint.
- Ambientes separados: homologacion y produccion.

## Fases de implementacion

### Fase 1 - Base fiscal y solicitud

- Crear tablas de configuracion fiscal, datos fiscales de cliente, facturas e items.
- Agregar solicitud de factura asociada a pedido.
- Panel empresa para ver solicitudes.
- Estados sin emision real.

Resultado esperado: flujo ordenado y trazable, aunque la emision todavia no salga a AFIP/ARCA.

### Fase 2 - Homologacion AFIP/ARCA

- Implementar WSAA.
- Implementar WSFEv1 en ambiente homologacion.
- Emitir comprobantes de prueba.
- Registrar request/response.
- Manejar errores comunes.

Resultado esperado: factura electronica aprobada en homologacion.

Estado tecnico actual:

- WSAA queda implementado como cliente base en `src/integrations/arca/wsaaClient.js`.
- `POST /api/facturacion/config/probar-conexion` reutiliza token/sign cacheado si sigue vigente; si no existe, intenta `loginCms` contra homologacion o produccion segun `modo_afip`.
- La firma CMS se realiza con `openssl cms -sign` usando `certificado_ref` y `clave_ref` configurados por empresa.
- El token/sign se guarda cifrado con AES-256-GCM. Requiere `ARCA_TOKEN_ENCRYPTION_KEY` o `FACTURACION_SECRET_KEY` en el entorno.
- La respuesta de auditoria registra resultado WSAA sin guardar el CMS firmado completo.
- WSFEv1 queda implementado como cliente base en `src/integrations/arca/wsfeClient.js`.
- `POST /api/facturas/:id/emitir` consulta `FECompUltimoAutorizado`, prepara `FECAESolicitar`, guarda CAE y marca la factura como `emitida` si AFIP/ARCA aprueba.
- La emision real queda bloqueada si `modo_afip = produccion`; por ahora solo se habilita homologacion.
- Certificado de homologacion recibido para CUIT 20246177369, alias `aguahidro`, servicio `ws://wsfe`, serial `157338509BC44299`. Quedo guardado localmente fuera del versionado en `storage/arca-credentials/20246177369/certificado_homologacion_157338509bc44299.pem`.
- Clave privada recibida en formato OpenSSH, convertida a PEM y validada contra CSR/certificado. Quedo guardada localmente fuera del versionado en `storage/arca-credentials/20246177369/clave_privada_homologacion_157338509bc44299.pem`.
- CSR recibido y validado. Quedo guardado localmente fuera del versionado en `storage/arca-credentials/20246177369/pedido_csr_homologacion_157338509bc44299.pem`.
- WSAA homologacion probado correctamente el 2026-05-15: AFIP/ARCA devolvio `token/sign` para `wsfe`. No se registra el valor del token ni del sign en este documento.
- Empresa detectada para la prueba inicial: `empresa_id = 1`, `AguaHidro.com`, razon social `Mauricio N. Datta`, CUIT `20-24617736-9`, condicion `Monotributo`.
- Se agrego `npm run arca:check-credentials -- --cert <cert.pem> --key <clave.pem>` para validar que la clave privada corresponde al certificado antes de intentar WSAA.
- En Render/produccion, las credenciales ARCA deben persistirse cifradas en PostgreSQL (`certificado_pem_encrypted` y `clave_pem_encrypted`). WSAA las descifra en memoria, escribe PEM temporales en `/tmp` para `openssl cms -sign` y los elimina al terminar, evitando depender de rutas locales como `/home/lemac/...`.

Pendiente de Fase 2:

- Confirmar punto de venta electronico de homologacion para `wsfe`.
- Configurar `ARCA_TOKEN_ENCRYPTION_KEY` o `FACTURACION_SECRET_KEY` en el entorno antes de guardar token/sign.
- Actualizar `empresa_facturacion_config.certificado_ref` y `empresa_facturacion_config.clave_ref` cuando haya conexion a la base.
- Probar `FECompUltimoAutorizado` con el punto de venta de homologacion confirmado.
- Ajustar reglas de IVA/alicuotas por tipo de empresa y producto.
- Validar tipos de comprobante y documentos con contable.
- Generar PDF fiscal con CAE y QR.

### Fase 3 - Produccion controlada

- Habilitar produccion solo por empresa validada.
- Configurar punto de venta real.
- Emitir primeras facturas con seguimiento manual.
- Revisar reportes y casos rechazados.

Resultado esperado: emision real para empresas seleccionadas.

### Fase 4 - Automatizacion

- Emision automatica bajo reglas configurables por empresa.
- PDF final con QR y datos completos.
- Envio al cliente por email/WhatsApp si corresponde.
- Reporte mensual de facturas emitidas.

## Riesgos

Riesgo alto:

- Manejo inseguro de certificados o claves privadas.
- Emitir con tipo de comprobante incorrecto.
- Mezclar datos entre empresas.
- Generar comprobantes reales sin validacion contable.

Riesgo medio:

- Caidas o cambios en servicios AFIP/ARCA.
- Errores de numeracion si no se consulta ultimo comprobante.
- Rechazos por datos fiscales incompletos.

Riesgo bajo:

- Ajustes visuales del PDF.
- Cambios menores de UI del panel.

## Decisiones pendientes

- Confirmar si cada empresa subira su certificado o si PediVoy gestionara alta asistida.
- Definir si la emision queda manual por empresa o automatica cuando el cliente pida factura.
- Validar reglas de comprobante A/B/C con contable.
- Definir almacenamiento seguro de secretos en la infraestructura actual.
- Definir formato final del PDF.

## Proximo paso

El primer trabajo tecnico debe ser Fase 1: modelo de datos + flujo de solicitud de factura sin emision real.

No conviene empezar directo por WSAA/WSFEv1 sin antes tener:

- pedido asociado,
- datos fiscales del cliente,
- configuracion fiscal de la empresa,
- estados,
- auditoria,
- permisos por empresa.

Con esa base lista, la integracion AFIP/ARCA entra como motor de emision, no como parche aislado.
