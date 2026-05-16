# Checklist Operativo — PediVoy

## Control rápido diario
1. Verificar app en `http://localhost:3000`
2. Verificar health:
   - `http://localhost:3000/health`
   - `http://localhost:3000/api/health`
3. Verificar servicio:
   - `systemctl status pedivoy.service`
4. Ver logs si hay anomalías:
   - `journalctl -u pedivoy.service -n 50 --no-pager`
   - `tail -n 50 /home/lemac/.openclaw/workspace-pedivoy/PediVoy/logs/systemd.log`

## Si WhatsApp / QR falla
1. Abrir `http://localhost:3000/pedidos/qr.html`
2. Si queda en “Cargando QR...”, usar **Resetear sesión**
3. Recargar QR
4. Escanear nuevamente
5. Confirmar estado conectado

## Si la app no responde
1. Revisar `pedivoy.service`
2. Revisar logs
3. Reiniciar servicio:
   - `sudo systemctl restart pedivoy.service`
4. Volver a probar `localhost:3000`

## Señales de alerta
- `localhost:3000` no responde
- `/health` falla
- `pedivoy.service` aparece `failed`
- QR no genera después de reset
- errores repetidos en logs

## Escalación técnica
Escalar si pasa cualquiera de estos:
- el servicio reinicia en loop
- WhatsApp no conecta después de reset
- hay errores de base de datos
- hay caída del flujo de pedidos
