# Operacion Produccion PediVoy

Ultima revision: 2026-05-17 20:29 GMT-3

## Semaforo actual

- Codigo local: verde. Tests unitarios y smoke tecnico pasan.
- Produccion publica: verde. Health, paginas publicas, config publica, validacion de payload invalido y headers de seguridad responden correctamente.
- Seguridad npm productiva: verde. `npm audit --omit=dev` reporta 0 vulnerabilidades.
- Salud operativa de datos: amarillo. Empresa 1 no tiene datos en incidencias, tesoreria, compras ni CRM, por lo que falta validar operacion real de negocio.
- Facturacion ARCA Render: amarillo hasta confirmar recarga de certificado y clave persistentes en PostgreSQL y prueba WSAA desde produccion.

## Comandos de control

Local:

```bash
npm test
npm run test:smoke:postdeploy
npm run test:smoke:public
npm run test:smoke:security
npm run ops:data-health -- 1
npm audit --omit=dev
```

Produccion publica:

```bash
SMOKE_BASE_URL=https://www.aguahidro.com.ar npm run test:smoke:postdeploy
SMOKE_BASE_URL=https://www.aguahidro.com.ar npm run test:smoke:public
SMOKE_BASE_URL=https://www.aguahidro.com.ar npm run test:smoke:security
curl -sS https://www.aguahidro.com.ar/api/health
```

## Resultado 2026-05-17

- `npm run test:smoke:postdeploy`: OK local y produccion.
- `npm run test:smoke:public`: OK local y produccion.
- `npm run test:smoke:security`: OK local y produccion.
- `npm audit --omit=dev --audit-level=moderate`: OK, 0 vulnerabilidades.
- `/api/health` produccion: OK.
- `npm run ops:data-health -- 1`: alerta por falta de datos operativos en tablas de gestion.

## Proximo bloque recomendado

1. Validar ARCA en Render: variable de cifrado configurada, certificado y clave cargados juntos, prueba WSAA exitosa.
2. Ejecutar prueba operativa punta a punta: pedido publico, asignacion, GPS/reparto, entrega y factura.
3. Alimentar datos minimos o reales para incidencias, tesoreria, compras y CRM, y volver a correr `ops:data-health`.
4. Mejorar asignacion inteligente con zona, carga activa, demora y GPS.
5. Sumar observabilidad de errores criticos de DB, ARCA, WhatsApp y pedidos.
