import { asteriskAmiListener, getAsteriskConfig } from '../integrations/asterisk/index.js';

export function startServer(app, { PORT }) {
  const server = app.listen(PORT, () => {
    console.log(`🚀 Servidor unificado corriendo en puerto ${PORT}`);

    const asteriskConfig = getAsteriskConfig();
    if (asteriskConfig.enabled) {
      asteriskAmiListener.start();
      console.log('[asterisk] integración habilitada: AMI listener iniciado');
    }
  });

  return server;
}
