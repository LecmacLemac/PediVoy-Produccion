export function startServer(app, { PORT }) {
  return app.listen(PORT, () => {
    console.log(`🚀 Servidor unificado corriendo en puerto ${PORT}`);
  });
}
