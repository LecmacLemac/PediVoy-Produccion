-- =========================================================
-- ARCHIVO DE INICIALIZACIÓN DE BASE DE DATOS (PostgreSQL)
-- Versión "Definitiva" (Orden de Dependencias Corregido)
-- =========================================================

-- 1. EXTENSIONES
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS postgis;

-- =========================================================
-- 2. EMPRESAS (Multi-tenancy + Control de Licencias)
-- =========================================================
CREATE TABLE IF NOT EXISTS empresas (
  id                 SERIAL PRIMARY KEY,
  nombre             TEXT NOT NULL, 
  razon_social       TEXT,          
  cuit               TEXT,          
  condicion_iva      TEXT,          
  direccion          TEXT,          
  ciudad             TEXT,
  provincia          TEXT,
  pais               TEXT DEFAULT 'Argentina',
  telefono           TEXT,
  email              TEXT,
  rubro              TEXT,          
  etiquetas          TEXT,          
  alias              TEXT,
  
  -- Configuraciones avanzadas
  setup_steps        TEXT DEFAULT '{}',
  landing_domain     TEXT UNIQUE,  
  landing_slug       TEXT UNIQUE,  
  prompt_ia_vendedor TEXT,
  prompt_ia_general  TEXT,
  config_estrategias JSONB DEFAULT '{}',
  config_entrega     JSONB DEFAULT '{}',
  
  -- SISTEMA DE LICENCIAS
  plan_estado        TEXT DEFAULT 'active', 
  plan_tipo          TEXT DEFAULT 'trial', 
  plan_vencimiento   TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
  plan_precio        NUMERIC(12, 2) DEFAULT 0,
  
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS modulos              JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config_operativa     JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config_logistica     JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config_activos       JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config_integraciones JSONB DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_landing_domain_unique
  ON empresas (LOWER(landing_domain))
  WHERE landing_domain IS NOT NULL;

-- =========================================================
-- 3. CONFIGURACIÓN, PROMPTS Y CUENTAS
-- =========================================================
CREATE TABLE IF NOT EXISTS configuracion (
  key   TEXT PRIMARY KEY,
  value JSONB
);

CREATE TABLE IF NOT EXISTS empresa_prompts (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL, 
  contenido   TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, tipo)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_global_unique 
  ON empresa_prompts (tipo) 
  WHERE empresa_id IS NULL;

CREATE TABLE IF NOT EXISTS empresa_cuentas_bancarias (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  banco       TEXT,
  alias       TEXT,
  cbu         TEXT,
  titular     TEXT,
  tipo        TEXT DEFAULT 'cc', 
  activa      BOOLEAN DEFAULT TRUE,
  prioridad   INTEGER DEFAULT 1
);

-- Costos fijos de la empresa
CREATE TABLE IF NOT EXISTS empresa_costos_fijos (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  monto       NUMERIC(10,2) DEFAULT 0,
  frecuencia  TEXT DEFAULT 'mensual', 
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- =========================================================
-- 4. USUARIOS (Dashboard y Admin)
-- =========================================================
CREATE TABLE IF NOT EXISTS usuarios (
  id               SERIAL PRIMARY KEY,
  username         TEXT NOT NULL,
  password         TEXT NOT NULL,
  role             TEXT DEFAULT 'admin',
  empresa_id       INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id        INTEGER,
  referente_id     INTEGER,
  activo           BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at    TIMESTAMPTZ,
  telefono         TEXT,
  es_invitado      BOOLEAN DEFAULT FALSE,
  fecha_expiracion TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_usuarios_username UNIQUE (username)
);

-- =========================================================
-- 5. CHOFERES Y LOGÍSTICA
-- =========================================================
CREATE TABLE IF NOT EXISTS choferes (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  telefono    TEXT,
  email       TEXT,
  activo      BOOLEAN DEFAULT TRUE,
  tipo        TEXT DEFAULT 'propio', 
  sla_horas   INTEGER DEFAULT 24,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Zonas de reparto
CREATE TABLE IF NOT EXISTS zonas_geograficas (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  color       TEXT DEFAULT '#3388ff',
  poligono    TEXT, 
  geom        GEOMETRY(Polygon, 4326), 
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Asignación Chofer <-> Zona
CREATE TABLE IF NOT EXISTS zona_chofer (
  zona_id    INTEGER REFERENCES zonas_geograficas(id) ON DELETE CASCADE,
  chofer_id  INTEGER REFERENCES choferes(id) ON DELETE CASCADE,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  PRIMARY KEY (zona_id, chofer_id)
);

-- Escalas de pago
CREATE TABLE IF NOT EXISTS chofer_escalas (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id      INTEGER REFERENCES choferes(id) ON DELETE SET NULL, 
  nombre         TEXT NOT NULL, 
  vigente_desde  DATE NOT NULL,
  vigente_hasta  DATE,
  notas          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chofer_escala_tramos (
  id         SERIAL PRIMARY KEY,
  escala_id  INTEGER NOT NULL REFERENCES chofer_escalas(id) ON DELETE CASCADE,
  rango_min  INTEGER NOT NULL,
  rango_max  INTEGER, 
  monto      NUMERIC(10,2) NOT NULL
);

-- =========================================================
-- 6. CLIENTES Y PUNTOS DE ENTREGA
-- =========================================================

CREATE TABLE IF NOT EXISTS puntos_entrega (
  id                   SERIAL PRIMARY KEY,
  empresa_id           INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente              TEXT NOT NULL,
  nombre               TEXT,
  direccion            TEXT,
  direccion_completa   TEXT,
  ciudad               TEXT,
  provincia            TEXT,
  pais                 TEXT,
  telefono             TEXT,
  telefono_normalizado TEXT,
  email                TEXT,
  email_facturacion    TEXT,
  requiere_factura     BOOLEAN DEFAULT FALSE,
  zona_id              INTEGER REFERENCES zonas_geograficas(id) ON DELETE SET NULL,
  latitud              NUMERIC,
  longitud             NUMERIC,
  geom                 GEOMETRY(Point, 4326),
  notas                TEXT,
  razon_social         TEXT,
  cuit                 TEXT,
  condicion_iva        TEXT,
  frecuencia           INTEGER DEFAULT 7,
  ultima_visita        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE puntos_entrega
  ADD COLUMN IF NOT EXISTS crm_estado TEXT DEFAULT 'activo',
  ADD COLUMN IF NOT EXISTS crm_segmento TEXT,
  ADD COLUMN IF NOT EXISTS crm_riesgo TEXT DEFAULT 'bajo',
  ADD COLUMN IF NOT EXISTS crm_motivo TEXT,
  ADD COLUMN IF NOT EXISTS crm_ticket_objetivo NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS crm_proxima_accion TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS crm_ultima_accion TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cuenta_corriente_habilitada BOOLEAN DEFAULT FALSE;

-- =========================================================
-- 7. PRODUCTOS Y STOCK (La Base Fundamental)
-- =========================================================

CREATE TABLE IF NOT EXISTS productos (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre              TEXT NOT NULL,
  descripcion         TEXT,
  precio              NUMERIC(10,2) DEFAULT 0,
  stock_min           INTEGER DEFAULT 0,
  stock_max           INTEGER DEFAULT 0,
  activo              BOOLEAN DEFAULT TRUE,
  imagen              TEXT,
  imagen_2            TEXT,
  imagen_3            TEXT,
  categoria           TEXT,
  orden               INTEGER DEFAULT 0,
  etiqueta            TEXT, 
  imagen_promo        TEXT,
  destacado           BOOLEAN DEFAULT FALSE,
  mostrar_en_catalogo BOOLEAN DEFAULT TRUE,
  mostrar_en_landing  BOOLEAN DEFAULT FALSE,
  config_activo       JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Alteraciones y columnas extra de productos
ALTER TABLE productos 
    ADD COLUMN IF NOT EXISTS comportamiento TEXT DEFAULT 'simple',
    ADD COLUMN IF NOT EXISTS unidad_medida TEXT DEFAULT 'unidad',
    ADD COLUMN IF NOT EXISTS requiere_activo_vacio BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS retornable BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS stock_infinito BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS margen_meta NUMERIC(5,2) DEFAULT 30,
    ADD COLUMN IF NOT EXISTS sku TEXT,
    ADD COLUMN IF NOT EXISTS external_id TEXT,
    ADD COLUMN IF NOT EXISTS created_by INTEGER,
    ADD COLUMN IF NOT EXISTS updated_by INTEGER,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by INTEGER,
    ADD COLUMN IF NOT EXISTS promo_config JSONB,
    ADD COLUMN IF NOT EXISTS imagen_2 TEXT,
    ADD COLUMN IF NOT EXISTS imagen_3 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS productos_empresa_sku_uniq
  ON productos (empresa_id, lower(sku))
  WHERE sku IS NOT NULL AND btrim(sku) <> '' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS productos_empresa_external_id_uniq
  ON productos (empresa_id, external_id)
  WHERE external_id IS NOT NULL AND btrim(external_id) <> '' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS productos_empresa_deleted_idx
  ON productos (empresa_id, deleted_at);

-- =========================================================
-- 8. VARIABLES DE COSTO Y STOCK (DEPENDEN DE PRODUCTOS)
-- =========================================================

-- 1) Definición de variables (Servicio técnico, Marketing, etc.)
CREATE TABLE IF NOT EXISTS empresa_costos_variables_def (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre       TEXT NOT NULL,
  codigo       TEXT,
  tipo_calculo TEXT NOT NULL DEFAULT 'unitario', 
  orden        INTEGER DEFAULT 0,
  activo       BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS empresa_costos_variables_def_empresa_codigo_idx
  ON empresa_costos_variables_def (empresa_id, lower(codigo))
  WHERE codigo IS NOT NULL AND btrim(codigo) <> '';

CREATE INDEX IF NOT EXISTS empresa_costos_variables_def_empresa_idx
  ON empresa_costos_variables_def (empresa_id, activo, orden);

-- 2) Aplicación de variables
CREATE TABLE IF NOT EXISTS empresa_costos_variables_aplicacion (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  variable_id  INTEGER NOT NULL REFERENCES empresa_costos_variables_def(id) ON DELETE CASCADE,
  nivel        TEXT NOT NULL DEFAULT 'producto', 
  
  producto_id  INTEGER REFERENCES productos(id) ON DELETE CASCADE,
  
  categoria    TEXT,
  etiqueta     TEXT,
  valor        NUMERIC(10,2) NOT NULL DEFAULT 0,
  activo       BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS empresa_costos_variables_aplicacion_empresa_idx
  ON empresa_costos_variables_aplicacion (empresa_id, variable_id, nivel);

CREATE INDEX IF NOT EXISTS empresa_costos_variables_aplicacion_producto_idx
  ON empresa_costos_variables_aplicacion (empresa_id, producto_id, activo);

-- Costos base y Preferencias
CREATE TABLE IF NOT EXISTS empresa_productos_costos (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  costo_base  NUMERIC(10,2) DEFAULT 0,
  proveedor   TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, producto_id)
);

ALTER TABLE empresa_productos_costos 
  ADD COLUMN IF NOT EXISTS costo_packaging NUMERIC(10,2) DEFAULT 0;

CREATE TABLE IF NOT EXISTS producto_prefs (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id INTEGER REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  producto_id      INTEGER REFERENCES productos(id) ON DELETE CASCADE,
  cantidad_usual   INTEGER DEFAULT 1,
  observaciones    TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Stock físico (Inventario móvil)
CREATE TABLE IF NOT EXISTS chofer_stock (
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id   INTEGER NOT NULL REFERENCES choferes(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  cantidad    NUMERIC(10,2) DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (empresa_id, chofer_id, producto_id)
);

CREATE TABLE IF NOT EXISTS chofer_stock_mov (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id   INTEGER NOT NULL REFERENCES choferes(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  deposito_id INTEGER,
  fecha       TIMESTAMPTZ DEFAULT NOW(),
  tipo        TEXT NOT NULL, 
  cantidad    NUMERIC(10,2) NOT NULL,
  motivo      TEXT,
  referencia  TEXT, 
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS depositos (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  direccion   TEXT,
  activo      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (empresa_id, nombre)
);

CREATE TABLE IF NOT EXISTS deposito_chofer (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  deposito_id INTEGER NOT NULL REFERENCES depositos(id) ON DELETE CASCADE,
  chofer_id   INTEGER NOT NULL REFERENCES choferes(id) ON DELETE CASCADE,
  activo      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (empresa_id, deposito_id, chofer_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_chofer_stock_mov_deposito'
  ) THEN
    ALTER TABLE chofer_stock_mov
      ADD CONSTRAINT fk_chofer_stock_mov_deposito
      FOREIGN KEY (deposito_id) REFERENCES depositos(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS chofer_costos (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id      INTEGER NOT NULL REFERENCES choferes(id) ON DELETE CASCADE,
  producto_id    INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  costo_unitario NUMERIC(10,2) NOT NULL,
  UNIQUE(empresa_id, chofer_id, producto_id)
);

-- =========================================================
-- 9. PEDIDOS (CORE)
-- =========================================================
CREATE TABLE IF NOT EXISTS pedidos (
  id                 SERIAL PRIMARY KEY,
  empresa_id         INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id   INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  chofer_id          INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  zona_id            INTEGER REFERENCES zonas_geograficas(id) ON DELETE SET NULL,
  estado             TEXT DEFAULT 'pendiente', 
  metodo_pago        TEXT DEFAULT 'efectivo',
  monto              NUMERIC(10,2) DEFAULT 0,
  fecha              TIMESTAMPTZ DEFAULT NOW(),
  fecha_entrega      TIMESTAMPTZ,               
  tracking_token     TEXT, 
  cantidad_entregada NUMERIC DEFAULT 0,
  origen             TEXT DEFAULT 'manual',
  cantidad           NUMERIC DEFAULT 0,
  submission_id      TEXT,
  aviso_recibido     INTEGER DEFAULT 0,
  sats               INTEGER DEFAULT 0,
  referido_por_id    INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  validado           BOOLEAN DEFAULT FALSE,
  notas              TEXT,
  latitud            NUMERIC,
  longitud           NUMERIC,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS en_ruta_notificado_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_empresa_submission_id_uniq
  ON pedidos (empresa_id, submission_id)
  WHERE submission_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS items_pedido (
  id              SERIAL PRIMARY KEY,
  pedido_id       INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  producto        TEXT NOT NULL,
  producto_id     INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  cantidad        NUMERIC DEFAULT 1,
  precio_unitario NUMERIC(10,2) DEFAULT 0
);

-- =========================================================
-- 9.b REFERENTES Y COMISIONES
-- =========================================================
CREATE TABLE IF NOT EXISTS referentes (
  id                    SERIAL PRIMARY KEY,
  empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre                 TEXT NOT NULL,
  telefono               TEXT,
  email                  TEXT,
  direccion              TEXT,
  codigo                 TEXT NOT NULL,
  porcentaje_comision    NUMERIC(5,2) NOT NULL DEFAULT 0,
  vigente_desde          DATE,
  vigente_hasta          DATE,
  activo                 BOOLEAN NOT NULL DEFAULT TRUE,
  notas                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at             TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS referentes_empresa_codigo_uniq
  ON referentes (empresa_id, LOWER(codigo))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS referentes_empresa_activo_idx
  ON referentes (empresa_id, activo, created_at DESC);

CREATE TABLE IF NOT EXISTS referente_productos (
  id                    SERIAL PRIMARY KEY,
  empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  referente_id           INTEGER NOT NULL REFERENCES referentes(id) ON DELETE CASCADE,
  producto_id            INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  porcentaje_comision    NUMERIC(5,2),
  vigente_desde          DATE,
  vigente_hasta          DATE,
  activo                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(referente_id, producto_id)
);

CREATE INDEX IF NOT EXISTS referente_productos_empresa_idx
  ON referente_productos (empresa_id, referente_id, activo);

CREATE TABLE IF NOT EXISTS cliente_referentes (
  id                    SERIAL PRIMARY KEY,
  empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id       INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  referente_id           INTEGER NOT NULL REFERENCES referentes(id) ON DELETE CASCADE,
  codigo_referente       TEXT,
  estado                 TEXT NOT NULL DEFAULT 'activo',
  asociado_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  desvinculado_at        TIMESTAMPTZ,
  desvinculado_por       INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  desvinculado_motivo    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS cliente_referentes_un_activo_uniq
  ON cliente_referentes (empresa_id, punto_entrega_id)
  WHERE estado = 'activo';

CREATE INDEX IF NOT EXISTS cliente_referentes_referente_idx
  ON cliente_referentes (empresa_id, referente_id, estado);

CREATE TABLE IF NOT EXISTS referente_clientes_propuestos (
  id                    SERIAL PRIMARY KEY,
  empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  referente_id           INTEGER NOT NULL REFERENCES referentes(id) ON DELETE CASCADE,
  cliente                TEXT NOT NULL,
  telefono               TEXT,
  direccion              TEXT,
  ciudad                 TEXT,
  provincia              TEXT,
  pais                   TEXT,
  email                  TEXT,
  notas                  TEXT,
  estado                 TEXT NOT NULL DEFAULT 'pendiente',
  punto_entrega_id       INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  reviewed_at            TIMESTAMPTZ,
  reviewed_by            INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  rechazo_motivo         TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS referente_clientes_propuestos_empresa_estado_idx
  ON referente_clientes_propuestos (empresa_id, estado, created_at DESC);

CREATE INDEX IF NOT EXISTS referente_clientes_propuestos_referente_idx
  ON referente_clientes_propuestos (empresa_id, referente_id, estado);

CREATE TABLE IF NOT EXISTS referente_comisiones (
  id                    SERIAL PRIMARY KEY,
  empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  referente_id           INTEGER NOT NULL REFERENCES referentes(id) ON DELETE CASCADE,
  punto_entrega_id       INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  pedido_id              INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  item_pedido_id         INTEGER NOT NULL REFERENCES items_pedido(id) ON DELETE CASCADE,
  producto_id            INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  base_monto             NUMERIC(12,2) NOT NULL DEFAULT 0,
  porcentaje             NUMERIC(5,2) NOT NULL DEFAULT 0,
  monto_comision         NUMERIC(12,2) NOT NULL DEFAULT 0,
  estado                 TEXT NOT NULL DEFAULT 'validada',
  validada_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  liquidada_at           TIMESTAMPTZ,
  liquidacion_referencia TEXT,
  liquidacion_nota       TEXT,
  liquidada_por          INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(pedido_id, item_pedido_id, referente_id)
);

CREATE INDEX IF NOT EXISTS referente_comisiones_empresa_estado_idx
  ON referente_comisiones (empresa_id, estado, validada_at DESC);

CREATE TABLE IF NOT EXISTS referente_notificaciones (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  referente_id   INTEGER NOT NULL REFERENCES referentes(id) ON DELETE CASCADE,
  tipo           TEXT NOT NULL,
  titulo         TEXT NOT NULL,
  mensaje        TEXT NOT NULL,
  pedido_id      INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  comision_id    INTEGER REFERENCES referente_comisiones(id) ON DELETE SET NULL,
  leida_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS referente_notificaciones_ref_idx
  ON referente_notificaciones (empresa_id, referente_id, leida_at, created_at DESC);

CREATE TABLE IF NOT EXISTS pedido_track_points (
  id         SERIAL PRIMARY KEY,
  pedido_id  INTEGER REFERENCES pedidos(id) ON DELETE CASCADE,
  latitud    NUMERIC,
  longitud   NUMERIC,
  timestamp  TIMESTAMPTZ DEFAULT NOW(),
  source     TEXT DEFAULT 'gps',
  precision  NUMERIC,
  speed      NUMERIC,
  heading    NUMERIC
);

-- =========================================================
-- 10. RECOMPENSAS
-- =========================================================
CREATE TABLE IF NOT EXISTS cliente_recompensas (
  id               SERIAL PRIMARY KEY,
  cliente_id       INTEGER REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  producto_id      INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  cantidad         INTEGER DEFAULT 1,
  reclamado        BOOLEAN DEFAULT FALSE,
  fecha_ganado     TIMESTAMPTZ DEFAULT NOW(),
  fecha_reclamado  TIMESTAMPTZ,
  origen_pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promociones_redenciones (
  id                 SERIAL PRIMARY KEY,
  empresa_id         INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id   INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  trigger_producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  beneficio_tipo     TEXT NOT NULL,
  beneficio_producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  pedido_id          INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS promo_redencion_once_idx
  ON promociones_redenciones (empresa_id, punto_entrega_id, trigger_producto_id, beneficio_tipo)
  WHERE beneficio_tipo = 'gift_once_per_product';

CREATE UNIQUE INDEX IF NOT EXISTS promo_redencion_once_global_idx
  ON promociones_redenciones (empresa_id, punto_entrega_id, beneficio_tipo)
  WHERE beneficio_tipo = 'gift_once_global';

CREATE TABLE IF NOT EXISTS promociones_config (
  empresa_id    INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
  points_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  promos_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS juegos_campanias (
  id                    SERIAL PRIMARY KEY,
  empresa_id            INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  slug                  TEXT NOT NULL,
  public_code           TEXT,
  nombre                TEXT NOT NULL,
  titulo_publico        TEXT NOT NULL,
  descripcion_publica   TEXT,
  tipo_juego            TEXT NOT NULL DEFAULT 'raspadita',
  estado                TEXT NOT NULL DEFAULT 'borrador',
  participacion_limite  TEXT NOT NULL DEFAULT 'once',
  max_participaciones   INTEGER,
  max_ganadores         INTEGER,
  codigo_prefijo        TEXT DEFAULT 'PV',
  whatsapp_mensaje      TEXT,
  bases_condiciones     TEXT,
  valid_from            TIMESTAMPTZ,
  valid_to              TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, slug)
);

CREATE TABLE IF NOT EXISTS juegos_premios (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  campania_id     INTEGER NOT NULL REFERENCES juegos_campanias(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,
  producto_id     INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  nombre_publico  TEXT NOT NULL,
  descripcion     TEXT,
  valor           NUMERIC(12,2),
  probabilidad    INTEGER NOT NULL DEFAULT 1,
  stock_total     INTEGER,
  stock_diario    INTEGER,
  activo          BOOLEAN NOT NULL DEFAULT TRUE,
  orden           INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS juegos_participaciones (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  campania_id         INTEGER NOT NULL REFERENCES juegos_campanias(id) ON DELETE CASCADE,
  premio_id           INTEGER REFERENCES juegos_premios(id) ON DELETE SET NULL,
  producto_id         INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  punto_entrega_id    INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  pedido_id           INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  telefono            TEXT NOT NULL,
  telefono_norm       TEXT NOT NULL,
  codigo              TEXT,
  resultado_tipo      TEXT NOT NULL,
  resultado_nombre    TEXT NOT NULL,
  ip_hash             TEXT,
  user_agent          TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  enviado_whatsapp_at TIMESTAMPTZ,
  redimido_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS juegos_campanias_empresa_estado_idx
  ON juegos_campanias (empresa_id, estado, valid_from, valid_to);

ALTER TABLE juegos_campanias
  ADD COLUMN IF NOT EXISTS public_code TEXT;

UPDATE juegos_campanias
   SET public_code = UPPER(SUBSTRING(MD5(empresa_id::text || ':' || slug || ':' || id::text), 1, 10))
 WHERE public_code IS NULL OR BTRIM(public_code) = '';

ALTER TABLE juegos_campanias
  ALTER COLUMN public_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS juegos_campanias_public_code_uniq
  ON juegos_campanias (LOWER(public_code));

CREATE INDEX IF NOT EXISTS juegos_premios_campania_idx
  ON juegos_premios (campania_id, activo, orden);

CREATE INDEX IF NOT EXISTS juegos_participaciones_campania_tel_idx
  ON juegos_participaciones (campania_id, telefono_norm, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS juegos_participaciones_codigo_uniq
  ON juegos_participaciones (codigo)
  WHERE codigo IS NOT NULL;

ALTER TABLE juegos_participaciones
  ADD COLUMN IF NOT EXISTS punto_entrega_id INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS puntos_movimientos (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  pedido_id        INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  tipo             TEXT NOT NULL,
  puntos           INTEGER NOT NULL,
  detalle          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS puntos_movimientos_empresa_cliente_idx
  ON puntos_movimientos (empresa_id, punto_entrega_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS puntos_movimientos_entrega_uniq
  ON puntos_movimientos (empresa_id, pedido_id, tipo)
  WHERE pedido_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS entregas_evidencias (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  pedido_id   INTEGER NOT NULL UNIQUE REFERENCES pedidos(id) ON DELETE CASCADE,
  chofer_id   INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  checklist   JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidencia   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================
-- 11. FINANZAS Y GASTOS
-- =========================================================
CREATE TABLE IF NOT EXISTS gastos_repartidor (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id        INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  fecha            DATE NOT NULL,
  tipo             TEXT NOT NULL, 
  descripcion      TEXT,
  monto            NUMERIC(10,2) DEFAULT 0,
  comprobante_path TEXT,
  cantidad         NUMERIC,
  producto_id      INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Saldos de envases/retornables por cliente y producto.
CREATE TABLE IF NOT EXISTS cliente_retornables_saldos (
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id  INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  producto_id       INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  saldo             NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (empresa_id, punto_entrega_id, producto_id)
);

CREATE TABLE IF NOT EXISTS cliente_retornables_movimientos (
  id                SERIAL PRIMARY KEY,
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id  INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  pedido_id         INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  chofer_id         INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  producto_id       INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  entregados        NUMERIC(12,2) NOT NULL DEFAULT 0,
  devueltos         NUMERIC(12,2) NOT NULL DEFAULT 0,
  delta             NUMERIC(12,2) NOT NULL DEFAULT 0,
  saldo_resultante  NUMERIC(12,2),
  observacion       TEXT,
  fecha             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cliente_retornables_mov_cliente
  ON cliente_retornables_movimientos (empresa_id, punto_entrega_id, producto_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_cliente_retornables_mov_pedido
  ON cliente_retornables_movimientos (pedido_id);

-- CRM comercial: pipeline de oportunidades
CREATE TABLE IF NOT EXISTS crm_oportunidades (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id          INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  nombre              TEXT NOT NULL,
  rubro               TEXT,
  canal               TEXT,
  etapa               TEXT NOT NULL DEFAULT 'prospecto',
  probabilidad        INTEGER DEFAULT 20,
  monto_estimado      NUMERIC(12,2) DEFAULT 0,
  fecha_cierre_estimada DATE,
  origen              TEXT,
  proxima_accion      TIMESTAMPTZ,
  responsable_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  notas               TEXT,
  perdida_motivo      TEXT,
  estado              TEXT NOT NULL DEFAULT 'abierta',
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_etapa_idx
  ON crm_oportunidades (empresa_id, etapa, estado);
CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_prox_accion_idx
  ON crm_oportunidades (empresa_id, proxima_accion);

CREATE TABLE IF NOT EXISTS crm_oportunidad_actividades (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  oportunidad_id   INTEGER NOT NULL REFERENCES crm_oportunidades(id) ON DELETE CASCADE,
  tipo             TEXT NOT NULL DEFAULT 'nota',
  descripcion      TEXT,
  usuario_id       INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  fecha_programada TIMESTAMPTZ,
  completada       BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS crm_oportunidad_actividades_empresa_idx
  ON crm_oportunidad_actividades (empresa_id, oportunidad_id, created_at DESC);

-- Cuenta corriente por cliente (debe/haber + saldo)
CREATE TABLE IF NOT EXISTS cliente_cta_corriente_mov (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id       INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  pedido_id        INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  tipo             TEXT NOT NULL,
  concepto         TEXT,
  debe             NUMERIC(12,2) DEFAULT 0,
  haber            NUMERIC(12,2) DEFAULT 0,
  fecha            TIMESTAMPTZ DEFAULT NOW(),
  vencimiento      TIMESTAMPTZ,
  estado           TEXT DEFAULT 'pendiente',
  referencia       TEXT,
  usuario_id       INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cliente_cta_corriente_empresa_cliente_idx
  ON cliente_cta_corriente_mov (empresa_id, cliente_id, fecha DESC);
CREATE INDEX IF NOT EXISTS cliente_cta_corriente_empresa_estado_idx
  ON cliente_cta_corriente_mov (empresa_id, estado, vencimiento);

CREATE TABLE IF NOT EXISTS transferencias (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id        INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  pedido_id        INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  fecha            TIMESTAMPTZ DEFAULT NOW(),
  monto            NUMERIC(10,2) NOT NULL,
  metodo_pago      TEXT DEFAULT 'transferencia',
  referencia       TEXT,
  comprobante_path TEXT,
  estado           TEXT DEFAULT 'verificado', 
  tipo             TEXT DEFAULT 'cobro',      
  notas            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS comprobantes_transferencia (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER REFERENCES empresas(id) ON DELETE CASCADE, 
  chofer_id        INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  pedido_id        INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  zona_id          INTEGER REFERENCES zonas_geograficas(id) ON DELETE SET NULL,
  fecha            TIMESTAMPTZ DEFAULT NOW(),
  monto            NUMERIC(10,2),
  metodo_pago      TEXT,
  comentario       TEXT,
  archivo_path     TEXT, 
  comprobante_path TEXT, 
  banco_origen     TEXT,
  nro_operacion    TEXT,
  telefono         TEXT,                      
  validado         INTEGER DEFAULT 0,
  procesado        BOOLEAN DEFAULT FALSE,     
  fecha_procesado  TIMESTAMPTZ,
  banco_destino    TEXT,
  alias_destino    TEXT,
  cbu_destino      TEXT,
  titular_destino  TEXT,
  cuenta_bancaria_id INTEGER REFERENCES empresa_cuentas_bancarias(id) ON DELETE SET NULL,
  cuenta_bancaria_confianza INTEGER DEFAULT 0,
  cuenta_bancaria_match_fuente TEXT,
  cuenta_bancaria_match_detalle TEXT,
  file_hash        TEXT,
  estado_revision  TEXT DEFAULT 'pendiente',
  riesgo_score     INTEGER DEFAULT 0,
  riesgo_flags     TEXT,
  verified_by      INTEGER,
  verified_reason  TEXT,
  verified_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS pedido_pagos (
  id                  SERIAL PRIMARY KEY,

  -- Relaciones
  empresa_id          INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  pedido_id           INT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  cliente_id          INT REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  chofer_id           INT REFERENCES choferes(id) ON DELETE SET NULL,

  -- Negocio
  metodo_pago         TEXT,                               -- 'transferencia', 'qr_mp', etc.
  canal               TEXT,                               -- 'repartidor', 'whatsapp', 'admin_panel'
  descripcion         TEXT,
  notas               TEXT,

  -- Proveedor de pagos
  proveedor           TEXT NOT NULL,                      -- 'mercado_pago', 'banco_x', etc.
  provider_payment_id TEXT,                               -- id de la operación en el proveedor
  provider_order_id   TEXT,                               -- preference/order id si aplica
  provider_status     TEXT,                               -- estado textual del proveedor
  provider_fee        NUMERIC(12,2),                      -- comisión cobrada
  provider_net_amount NUMERIC(12,2),                      -- monto neto acreditado
  provider_payload    JSONB,                              -- respuesta cruda (limpia)

  -- Estado interno
  estado              TEXT NOT NULL DEFAULT 'pendiente',  -- 'pendiente', 'pagado', 'vencido', 'cancelado', 'error'
  monto               NUMERIC(12,2) NOT NULL,
  moneda              TEXT NOT NULL DEFAULT 'ARS',
  checkout_url        TEXT,
  qr_payload          TEXT,
  vence_at            TIMESTAMPTZ,
  settlement_at       TIMESTAMPTZ,                        -- acreditación real

  -- Conciliación
  conciliado          BOOLEAN NOT NULL DEFAULT FALSE,
  conciliado_por      INT,
  conciliado_en       TIMESTAMPTZ,

  -- Flex
  metadata            JSONB DEFAULT '{}'::jsonb,

  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_pedido_pagos_pedido_proveedor UNIQUE (pedido_id, proveedor)
);

CREATE TABLE IF NOT EXISTS historial_pagos (
  id SERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  fecha TIMESTAMP DEFAULT NOW(),
  monto NUMERIC(12,2) NOT NULL,
  metodo TEXT DEFAULT 'mercadopago',
  referencia TEXT,
  estado TEXT DEFAULT 'approved',
  CONSTRAINT uq_historial_pagos_referencia UNIQUE (referencia)
);

CREATE TABLE IF NOT EXISTS historial_costos_precios (
    id SERIAL PRIMARY KEY,
    empresa_id INT NOT NULL,
    producto_id INT NOT NULL,
    costo_base NUMERIC(12,2) NOT NULL,
    costo_packaging NUMERIC(12,2) DEFAULT 0,
    costo_logistica_estimado NUMERIC(12,2) DEFAULT 0,
    costo_fijo_asignado NUMERIC(12,2) DEFAULT 0,
    precio_venta NUMERIC(12,2) NOT NULL,
    moneda VARCHAR(3) DEFAULT 'ARS',
    cotizacion_dolar NUMERIC(10,2) DEFAULT 1,
    stock_al_momento INT,
    proveedor_id INT,
    motivo_cambio TEXT,
    usuario_editor TEXT,
    origen_dato VARCHAR(20) DEFAULT 'manual',
    meta_datos JSONB DEFAULT '{}',
    fecha_registro TIMESTAMP DEFAULT NOW()
);

-- =========================================================
-- 12. UTILIDADES (WhatsApp, Push, Logs)
-- =========================================================
CREATE TABLE IF NOT EXISTS wpp_outbox (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER, 
  telefono    TEXT NOT NULL,
  mensaje     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at     TIMESTAMPTZ,
  status      TEXT DEFAULT 'pending',
  error       TEXT
);

CREATE TABLE IF NOT EXISTS push_subs (
  id         SERIAL PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  endpoint   TEXT UNIQUE NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_sub_pedidos (
  sub_id    INTEGER NOT NULL REFERENCES push_subs(id) ON DELETE CASCADE,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  PRIMARY KEY (sub_id, pedido_id)
);

CREATE TABLE IF NOT EXISTS page_views (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  fecha        DATE NOT NULL,
  hora         TIME NOT NULL,
  user_agent   TEXT,
  referer      TEXT,
  session_id   TEXT,
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS page_view_events (
  id           SERIAL PRIMARY KEY,
  page_view_id INTEGER NOT NULL REFERENCES page_views(id) ON DELETE CASCADE,
  tipo         TEXT NOT NULL,
  payload      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================
-- 13. MÓDULO DE ACTIVOS (COMODATOS / MÁQUINAS)
-- =========================================================
CREATE TABLE IF NOT EXISTS empresa_activos (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  codigo       TEXT NOT NULL,
  tipo         TEXT NOT NULL,
  marca        TEXT,
  modelo       TEXT,
  valor_compra NUMERIC(12,2) DEFAULT 0,
  fecha_compra DATE,
  estado       TEXT DEFAULT 'disponible',
  cliente_id   INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  notas        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, codigo)
);

-- Extensiones de campos
ALTER TABLE empresa_activos
  -- info técnica y mantenimiento
  ADD COLUMN IF NOT EXISTS detalles_tecnicos JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ultima_sanitizacion DATE,
  ADD COLUMN IF NOT EXISTS frecuencia_mantenimiento INTEGER DEFAULT 6,
  -- vínculo con producto + alquiler
  ADD COLUMN IF NOT EXISTS producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS alquiler_mensual NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS fecha_inicio_alquiler TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fecha_fin_alquiler TIMESTAMPTZ,
  -- QR, garantías y última ubicación
  ADD COLUMN IF NOT EXISTS numero_serie        TEXT,
  ADD COLUMN IF NOT EXISTS codigo_qr           TEXT,
  ADD COLUMN IF NOT EXISTS nro_lote            TEXT,
  ADD COLUMN IF NOT EXISTS fecha_fin_garantia  DATE,
  ADD COLUMN IF NOT EXISTS proveedor_id        BIGINT,
  ADD COLUMN IF NOT EXISTS centro_costo_id     BIGINT,
  ADD COLUMN IF NOT EXISTS cuenta_contable_id  BIGINT,
  ADD COLUMN IF NOT EXISTS metodo_depreciacion TEXT,
  ADD COLUMN IF NOT EXISTS vida_util_meses     INT,
  ADD COLUMN IF NOT EXISTS last_seen_at_utc    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_fuente    TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_lat       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_seen_lng       DOUBLE PRECISION;




CREATE TABLE IF NOT EXISTS historial_activos (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  activo_id    INTEGER NOT NULL REFERENCES empresa_activos(id) ON DELETE CASCADE,
  cliente_id   INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  accion       TEXT NOT NULL,
  fecha        TIMESTAMPTZ DEFAULT NOW(),
  usuario      TEXT,
  observacion  TEXT
);

ALTER TABLE historial_activos
  ADD COLUMN IF NOT EXISTS latitud NUMERIC,
  ADD COLUMN IF NOT EXISTS longitud NUMERIC,
  ADD COLUMN IF NOT EXISTS firma_digital TEXT;

CREATE TABLE IF NOT EXISTS empresa_activos_alquileres (
  id             SERIAL PRIMARY KEY,
  empresa_id     INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id     INT REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  periodo        DATE NOT NULL, -- ej 2025-01-01 (mes)
  monto_total    NUMERIC(12,2) NOT NULL,
  total_activos  INT NOT NULL DEFAULT 0,
  estado         TEXT NOT NULL DEFAULT 'pendiente', -- pendiente, facturado, cobrado
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  mp_link            TEXT,
  mp_preference_id   TEXT,
  ultimo_pago_fecha  TIMESTAMPTZ,
  ultimo_pago_monto  NUMERIC(12,2),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  detalle_activos    JSONB DEFAULT '[]'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alquileres_uniq 
  ON empresa_activos_alquileres (empresa_id, cliente_id, periodo);


-- =========================================================
-- 14. Movimientos de activos asociados a pedidos
-- =========================================================

CREATE TABLE IF NOT EXISTS pedido_activos (
  id                    SERIAL PRIMARY KEY,

  -- Contexto de multi-empresa
  empresa_id            INTEGER NOT NULL,

  -- Pedido e ítem donde se produce el movimiento
  pedido_id             INTEGER NOT NULL,
  item_pedido_id        INTEGER,         -- opcional: link al ítem puntual
  producto_id           INTEGER,         -- opcional: redundancia para reportes

  -- Activo principal involucrado
  activo_id             INTEGER NOT NULL,

  -- Para cambios: activo que sale / se retira
  activo_relacionado_id INTEGER,         -- solo si tipo_operacion = 'cambio'

  -- Tipo de operación sobre el activo
  tipo_operacion        TEXT NOT NULL DEFAULT 'entrega',

  -- Estado del movimiento
  estado                TEXT NOT NULL DEFAULT 'confirmado',

  -- Origen de la acción (para auditoría)
  origen                TEXT NOT NULL DEFAULT 'app_repartidor',

  -- ¿Este movimiento implica que hay que retirar otro activo?
  requiere_retiro       BOOLEAN NOT NULL DEFAULT FALSE,

  -- Datos de contexto
  observacion           TEXT,
  motivo                TEXT,

  -- Momento y lugar de la acción
  accion_at_utc         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accion_lat            DOUBLE PRECISION,
  accion_lng            DOUBLE PRECISION,

  -- Evidencias / adjuntos
  foto_entrega_url         TEXT,
  foto_numero_serie_url    TEXT,
  firma_cliente_url        TEXT,

  -- Auditoría
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by            TEXT,

  CONSTRAINT fk_pedido_activos_empresa
    FOREIGN KEY (empresa_id)
    REFERENCES empresas (id)
    ON DELETE CASCADE,

  CONSTRAINT fk_pedido_activos_pedido
    FOREIGN KEY (pedido_id)
    REFERENCES pedidos (id)
    ON DELETE CASCADE,

  CONSTRAINT fk_pedido_activos_item_pedido
    FOREIGN KEY (item_pedido_id)
    REFERENCES items_pedido (id)
    ON DELETE SET NULL,

  CONSTRAINT fk_pedido_activos_producto
    FOREIGN KEY (producto_id)
    REFERENCES productos (id)
    ON DELETE SET NULL,

  CONSTRAINT fk_pedido_activos_activo
    FOREIGN KEY (activo_id)
    REFERENCES empresa_activos (id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_pedido_activos_activo_rel
    FOREIGN KEY (activo_relacionado_id)
    REFERENCES empresa_activos (id)
    ON DELETE SET NULL,

  CONSTRAINT chk_pedido_activos_tipo_operacion
    CHECK (tipo_operacion IN ('entrega', 'retiro', 'cambio', 'mantenimiento')),

  CONSTRAINT chk_pedido_activos_estado
    CHECK (estado IN ('pendiente', 'confirmado', 'cancelado')),

  CONSTRAINT chk_pedido_activos_origen
    CHECK (origen IN ('app_repartidor', 'panel_admin', 'import')),

  CONSTRAINT uq_pedido_activos_pedido_activo
    UNIQUE (pedido_id, activo_id)
);

-- =========================================================
-- 14.b FASE 2 - COMPRAS Y PROVEEDORES
-- =========================================================
CREATE TABLE IF NOT EXISTS proveedores (
  id                SERIAL PRIMARY KEY,
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre            TEXT NOT NULL,
  cuit              TEXT,
  telefono          TEXT,
  email             TEXT,
  contacto          TEXT,
  condiciones_pago  TEXT,
  activo            BOOLEAN DEFAULT TRUE,
  notas             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS proveedores_empresa_idx
  ON proveedores (empresa_id, activo, nombre);

CREATE TABLE IF NOT EXISTS compras_ordenes (
  id                    SERIAL PRIMARY KEY,
  empresa_id            INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  proveedor_id          INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
  estado                TEXT NOT NULL DEFAULT 'borrador',
  fecha_emision         TIMESTAMPTZ DEFAULT NOW(),
  fecha_entrega_estimada DATE,
  subtotal              NUMERIC(12,2) DEFAULT 0,
  impuestos             NUMERIC(12,2) DEFAULT 0,
  total                 NUMERIC(12,2) DEFAULT 0,
  moneda                TEXT DEFAULT 'ARS',
  referencia_externa    TEXT,
  observaciones         TEXT,
  created_by            INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_by            INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS compras_ordenes_empresa_estado_idx
  ON compras_ordenes (empresa_id, estado, fecha_emision DESC);

CREATE TABLE IF NOT EXISTS compras_orden_items (
  id                SERIAL PRIMARY KEY,
  orden_id          INTEGER NOT NULL REFERENCES compras_ordenes(id) ON DELETE CASCADE,
  producto_id       INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  descripcion       TEXT,
  cantidad          NUMERIC(12,2) NOT NULL DEFAULT 0,
  costo_unitario    NUMERIC(12,2) NOT NULL DEFAULT 0,
  impuesto_pct      NUMERIC(6,2) DEFAULT 0,
  subtotal          NUMERIC(12,2) DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS compras_orden_items_orden_idx
  ON compras_orden_items (orden_id);

CREATE TABLE IF NOT EXISTS compras_recepciones (
  id                SERIAL PRIMARY KEY,
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  orden_id          INTEGER REFERENCES compras_ordenes(id) ON DELETE SET NULL,
  proveedor_id      INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
  fecha_recepcion   TIMESTAMPTZ DEFAULT NOW(),
  numero_remito     TEXT,
  observaciones     TEXT,
  created_by        INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compras_recepcion_items (
  id                SERIAL PRIMARY KEY,
  recepcion_id      INTEGER NOT NULL REFERENCES compras_recepciones(id) ON DELETE CASCADE,
  producto_id       INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  cantidad          NUMERIC(12,2) NOT NULL DEFAULT 0,
  costo_unitario    NUMERIC(12,2) NOT NULL DEFAULT 0,
  subtotal          NUMERIC(12,2) DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS compras_recepciones_empresa_idx
  ON compras_recepciones (empresa_id, fecha_recepcion DESC);

-- 14.c Tesorería proveedores (MVP)
CREATE TABLE IF NOT EXISTS tesoreria_movimientos (
  id                    SERIAL PRIMARY KEY,
  empresa_id            INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  tipo                  TEXT NOT NULL DEFAULT 'egreso', -- egreso|ingreso
  categoria             TEXT NOT NULL DEFAULT 'pago_proveedor',
  proveedor_id          INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
  compra_orden_id       INTEGER REFERENCES compras_ordenes(id) ON DELETE SET NULL,
  fecha                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  monto                 NUMERIC(12,2) NOT NULL DEFAULT 0,
  medio_pago            TEXT,
  referencia            TEXT,
  notas                 TEXT,
  conciliado            BOOLEAN NOT NULL DEFAULT FALSE,
  conciliado_at         TIMESTAMPTZ,
  created_by            INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tesoreria_movimientos_empresa_fecha_idx
  ON tesoreria_movimientos (empresa_id, fecha DESC);

CREATE INDEX IF NOT EXISTS tesoreria_movimientos_conciliado_idx
  ON tesoreria_movimientos (empresa_id, conciliado, fecha DESC);

-- 14.d Presupuesto mensual (compras/tesorería)
CREATE TABLE IF NOT EXISTS presupuesto_mensual (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  anio                INTEGER NOT NULL,
  mes                 INTEGER NOT NULL,
  categoria           TEXT NOT NULL,
  proveedor_id        INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
  monto_presupuestado NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_by          INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT presupuesto_mensual_mes_chk CHECK (mes BETWEEN 1 AND 12)
);

CREATE UNIQUE INDEX IF NOT EXISTS presupuesto_mensual_unique_idx
  ON presupuesto_mensual (empresa_id, anio, mes, categoria, COALESCE(proveedor_id, 0));

CREATE INDEX IF NOT EXISTS presupuesto_mensual_empresa_periodo_idx
  ON presupuesto_mensual (empresa_id, anio, mes, categoria);

-- 14.e Incidencias operativas (entrega/cobranza/servicio)
CREATE TABLE IF NOT EXISTS incidencias_operativas (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  pedido_id           INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  cliente_id          INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  chofer_id           INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  tipo                TEXT NOT NULL DEFAULT 'entrega', -- entrega|cobranza|producto|cliente|sistema
  severidad           TEXT NOT NULL DEFAULT 'media',   -- baja|media|alta|critica
  estado              TEXT NOT NULL DEFAULT 'abierta', -- abierta|en_progreso|resuelta|cancelada
  titulo              TEXT NOT NULL,
  detalle             TEXT,
  accion_recomendada  TEXT,
  responsable_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  vence_at            TIMESTAMPTZ,
  resuelta_at         TIMESTAMPTZ,
  resuelta_por        INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_by          INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE incidencias_operativas
  ADD COLUMN IF NOT EXISTS responsable_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE incidencias_operativas
  ADD COLUMN IF NOT EXISTS vence_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS incidencias_operativas_empresa_estado_idx
  ON incidencias_operativas (empresa_id, estado, severidad, created_at DESC);

CREATE INDEX IF NOT EXISTS incidencias_operativas_empresa_tipo_idx
  ON incidencias_operativas (empresa_id, tipo, created_at DESC);

CREATE TABLE IF NOT EXISTS incidencias_operativas_historial (
  id                  SERIAL PRIMARY KEY,
  incidencia_id       INTEGER NOT NULL REFERENCES incidencias_operativas(id) ON DELETE CASCADE,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  evento              TEXT NOT NULL, -- creada|actualizada|estado|resuelta
  payload             JSONB,
  actor_usuario_id    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS incidencias_historial_incidencia_idx
  ON incidencias_operativas_historial (incidencia_id, created_at DESC);

-- =========================================================
-- 15. ÍNDICES DE RENDIMIENTO (OPTIMIZACIÓN)
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_pedidos_emp_fecha ON pedidos (empresa_id, fecha DESC);

-- Tracking público: asegurar unicidad del token para lookup rápido y sin colisiones
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_tracking_token_unique
  ON pedidos (tracking_token)
  WHERE tracking_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pedidos_emp_chofer_fecha ON pedidos (empresa_id, chofer_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_puntos_entrega_empresa ON puntos_entrega (empresa_id);
CREATE INDEX IF NOT EXISTS idx_puntos_entrega_tel_norm ON puntos_entrega (telefono_normalizado);
CREATE INDEX IF NOT EXISTS idx_puntos_entrega_cliente_trgm ON puntos_entrega USING gin (cliente gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_usuarios_username ON usuarios (username);
CREATE INDEX IF NOT EXISTS idx_recompensas_cliente ON cliente_recompensas(cliente_id) WHERE reclamado = FALSE;
CREATE INDEX IF NOT EXISTS idx_items_pedido_pedido_id ON items_pedido (pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_chofer_estado ON pedidos (chofer_id, estado) WHERE estado IN ('pendiente', 'en_ruta', 'en_camino');
CREATE INDEX IF NOT EXISTS idx_zonas_geom ON zonas_geograficas USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_ct_procesado ON comprobantes_transferencia (procesado, fecha);
CREATE INDEX IF NOT EXISTS idx_ct_empresa_file_hash ON comprobantes_transferencia (empresa_id, file_hash);
CREATE INDEX IF NOT EXISTS idx_ct_estado_revision ON comprobantes_transferencia (estado_revision);
CREATE INDEX IF NOT EXISTS idx_pedido_track_points_pedido_ts ON pedido_track_points (pedido_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_hist_prod_fecha ON historial_costos_precios (producto_id, fecha_registro DESC);
CREATE INDEX IF NOT EXISTS idx_hist_empresa_fecha ON historial_costos_precios (empresa_id, fecha_registro DESC);
CREATE INDEX IF NOT EXISTS idx_activos_detalles ON empresa_activos USING gin (detalles_tecnicos);
CREATE INDEX IF NOT EXISTS idx_puntos_geom ON puntos_entrega USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_empresas_vencimiento ON empresas (plan_vencimiento);
CREATE INDEX IF NOT EXISTS idx_pedido_activos_empresa_pedido ON pedido_activos (empresa_id, pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_activos_empresa_activo ON pedido_activos (empresa_id, activo_id);
CREATE INDEX IF NOT EXISTS idx_pedido_activos_empresa_producto ON pedido_activos (empresa_id, producto_id);
CREATE INDEX IF NOT EXISTS idx_pedido_activos_empresa_accion_at ON pedido_activos (empresa_id, accion_at_utc);
CREATE INDEX IF NOT EXISTS idx_pedido_activos_empresa_estado ON pedido_activos (empresa_id, estado);
CREATE INDEX IF NOT EXISTS idx_empresa_activos_empresa_estado ON empresa_activos (empresa_id, estado);
CREATE INDEX IF NOT EXISTS idx_empresa_activos_empresa_cliente ON empresa_activos (empresa_id, cliente_id);
CREATE INDEX IF NOT EXISTS idx_empresa_activos_empresa_producto ON empresa_activos (empresa_id, producto_id);
CREATE INDEX IF NOT EXISTS idx_empresa_activos_last_seen ON empresa_activos (empresa_id, last_seen_at_utc);
CREATE INDEX IF NOT EXISTS idx_empresa_activos_alquileres_detalle ON empresa_activos_alquileres USING gin (detalle_activos);
CREATE INDEX IF NOT EXISTS idx_pedido_pagos_pedido ON pedido_pagos (pedido_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedido_pagos_provider_payment ON pedido_pagos (proveedor, provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_pedido_pagos_pendientes_empresa ON pedido_pagos (empresa_id, vence_at) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_pedido_pagos_pagados_empresa ON pedido_pagos (empresa_id, settlement_at) WHERE estado = 'pagado';
CREATE INDEX IF NOT EXISTS idx_pedido_pagos_conciliacion ON pedido_pagos (empresa_id, conciliado, settlement_at) WHERE conciliado = FALSE;

-- Garantiza 1 solo pago pendiente por pedido y empresa (evita duplicados por race conditions)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedido_pagos_one_pending_per_order
  ON pedido_pagos (empresa_id, pedido_id)
  WHERE estado = 'pendiente';


-- Choferes: foto opcional para panel admin
ALTER TABLE choferes
  ADD COLUMN IF NOT EXISTS foto_url TEXT;

-- Empresas: logo opcional para panel admin / branding
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS wpp_qr_code TEXT,
  ADD COLUMN IF NOT EXISTS wpp_status TEXT DEFAULT 'disconnected',
  ADD COLUMN IF NOT EXISTS wpp_reset_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ACK de incidentes de tracking (operación / NOC)
CREATE TABLE IF NOT EXISTS tracking_incident_acks (
  id                SERIAL PRIMARY KEY,
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  pedido_id         INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  acked_by_user_id  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  acked_by_username TEXT,
  comment           TEXT,
  acked_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracking_incident_acks_empresa_pedido_ack
  ON tracking_incident_acks (empresa_id, pedido_id, acked_at DESC);

-- =========================================================
-- 13. DATOS SEMILLA (deshabilitado)
-- =========================================================
-- 1. PRIMERO: Crear la Empresa por defecto (Para evitar el error FK)
INSERT INTO empresas (id, nombre, direccion, plan_estado, plan_tipo) 
VALUES (1, 'AguaHidro.com', 'AguaHidro.com', 'active', 'unlimited')
ON CONFLICT (id) DO UPDATE 
SET plan_estado = 'active'; -- Asegura que si ya existe, esté activa

-- 2. SEGUNDO: Crear el Usuario Admin vinculado a esa empresa
DELETE FROM usuarios WHERE username = 'admin';

-- User: admin | Pass: admin123 (bcrypt hash)
INSERT INTO usuarios (username, password, role, empresa_id, chofer_id)
VALUES ('admin', '$2a$12$H/YwbDUg6CdKqS3KyK8CdeXE31rkSqGGSG3jL7GbOawPZReTMF9Em', 'super', 1, NULL);

-- 3. TERCERO: Ajustar secuencias para evitar errores de IDs futuros
SELECT setval('empresas_id_seq', (SELECT MAX(id) FROM empresas));
SELECT setval('usuarios_id_seq', (SELECT MAX(id) FROM usuarios));

-- =========================================================
-- 14. TELEMETRÍA MARKETING POR CANAL
-- =========================================================
CREATE TABLE IF NOT EXISTS marketing_envios_telemetria (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  estrategia TEXT NOT NULL,
  canal TEXT NOT NULL,
  telefono TEXT,
  mensaje_hash TEXT,
  estado TEXT NOT NULL,
  proveedor TEXT,
  costo_estimado NUMERIC(12,2),
  detalle_error TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_tel_empresa_fecha
  ON marketing_envios_telemetria (empresa_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketing_tel_estrategia_canal_fecha
  ON marketing_envios_telemetria (estrategia, canal, created_at DESC);

-- =========================================================
-- 15. BASE DE CONTACTOS MARKETING (IMPORTACIÓN DE LISTAS)
-- =========================================================
CREATE TABLE IF NOT EXISTS marketing_contactos (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  telefono TEXT NOT NULL,
  telefono_normalizado TEXT NOT NULL,
  lista_nombre TEXT,
  rubro TEXT,
  zona TEXT,
  origen TEXT,
  canal_objetivo TEXT NOT NULL DEFAULT 'whatsapp',
  descripcion TEXT,
  objetivo_campana TEXT,
  context_tag TEXT,
  consent_status TEXT NOT NULL DEFAULT 'unknown',
  consent_source TEXT,
  consent_at TIMESTAMPTZ,
  optout_at TIMESTAMPTZ,
  estado TEXT NOT NULL DEFAULT 'nuevo',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_contactos_unique
  ON marketing_contactos (empresa_id, telefono_normalizado);

CREATE INDEX IF NOT EXISTS idx_marketing_contactos_filtros
  ON marketing_contactos (empresa_id, rubro, zona, estado, created_at DESC);

-- =========================================================
-- 16. CAMPAÑAS DE LLAMADAS / VOICE AI
-- =========================================================
CREATE TABLE IF NOT EXISTS call_campaigns (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  prompt_version TEXT,
  max_attempts INT NOT NULL DEFAULT 2,
  allowed_start_time TIME,
  allowed_end_time TIME,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_campaigns_empresa_status
  ON call_campaigns (empresa_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS call_campaign_contacts (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES call_campaigns(id) ON DELETE CASCADE,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  customer_id INT,
  name TEXT,
  phone TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_call_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  final_disposition TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, phone_normalized)
);

CREATE INDEX IF NOT EXISTS idx_call_campaign_contacts_dispatch
  ON call_campaign_contacts (empresa_id, campaign_id, status, next_retry_at);

CREATE TABLE IF NOT EXISTS call_sessions (
  id BIGSERIAL PRIMARY KEY,
  campaign_contact_id BIGINT NOT NULL REFERENCES call_campaign_contacts(id) ON DELETE CASCADE,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  campaign_id BIGINT NOT NULL REFERENCES call_campaigns(id) ON DELETE CASCADE,
  asterisk_channel_id TEXT,
  asterisk_linkedid TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INT,
  status TEXT NOT NULL DEFAULT 'initiated',
  hangup_cause TEXT,
  transcript_text TEXT,
  ai_summary TEXT,
  ai_disposition TEXT,
  ai_confidence NUMERIC(5,2),
  transferred_to_human BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  recording_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_empresa_status
  ON call_sessions (empresa_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS call_events (
  id BIGSERIAL PRIMARY KEY,
  call_session_id BIGINT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_events_session_created
  ON call_events (call_session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS call_tasks (
  id BIGSERIAL PRIMARY KEY,
  call_session_id BIGINT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  assigned_user_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_tasks_due
  ON call_tasks (status, due_at);

-- =========================================================
-- 17. FACTURACION ELECTRONICA AFIP/ARCA
-- =========================================================
CREATE TABLE IF NOT EXISTS empresa_facturacion_config (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cuit TEXT NOT NULL,
  razon_social TEXT,
  condicion_iva TEXT,
  punto_venta INT NOT NULL,
  modo_afip TEXT NOT NULL DEFAULT 'homologacion',
  certificado_ref TEXT,
  clave_ref TEXT,
  certificado_pem_encrypted TEXT,
  clave_pem_encrypted TEXT,
  certificado_nombre TEXT,
  clave_nombre TEXT,
  credenciales_updated_at TIMESTAMPTZ,
  wsaa_token_encrypted TEXT,
  wsaa_sign_encrypted TEXT,
  wsaa_expires_at TIMESTAMPTZ,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_empresa_facturacion_config_empresa UNIQUE (empresa_id),
  CONSTRAINT chk_empresa_facturacion_config_modo
    CHECK (modo_afip IN ('homologacion', 'produccion'))
);

CREATE INDEX IF NOT EXISTS idx_empresa_facturacion_config_empresa
  ON empresa_facturacion_config (empresa_id, activo);

CREATE TABLE IF NOT EXISTS cliente_datos_fiscales (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id INT REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  tipo_documento TEXT NOT NULL DEFAULT 'CUIT',
  numero_documento TEXT NOT NULL,
  razon_social TEXT NOT NULL,
  condicion_iva TEXT,
  domicilio_fiscal TEXT,
  email_facturacion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_cliente_datos_fiscales_cliente UNIQUE (empresa_id, punto_entrega_id)
);

CREATE INDEX IF NOT EXISTS idx_cliente_datos_fiscales_empresa_doc
  ON cliente_datos_fiscales (empresa_id, numero_documento);

CREATE TABLE IF NOT EXISTS facturas (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  pedido_id INT REFERENCES pedidos(id) ON DELETE SET NULL,
  punto_entrega_id INT REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  cliente_datos_fiscales_id BIGINT REFERENCES cliente_datos_fiscales(id) ON DELETE SET NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente_confirmacion',
  modo_afip TEXT NOT NULL DEFAULT 'homologacion',
  tipo_comprobante TEXT,
  codigo_comprobante_afip INT,
  punto_venta INT,
  numero_comprobante BIGINT,
  concepto TEXT NOT NULL DEFAULT 'productos',
  fecha_comprobante DATE,
  importe_neto NUMERIC(12,2) NOT NULL DEFAULT 0,
  importe_iva NUMERIC(12,2) NOT NULL DEFAULT 0,
  importe_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  cae TEXT,
  cae_vencimiento DATE,
  pdf_url TEXT,
  error_codigo TEXT,
  error_mensaje TEXT,
  created_by INT REFERENCES usuarios(id) ON DELETE SET NULL,
  emitted_by INT REFERENCES usuarios(id) ON DELETE SET NULL,
  emitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_facturas_estado
    CHECK (estado IN ('borrador', 'pendiente_confirmacion', 'emitiendo', 'emitida', 'rechazada', 'anulada')),
  CONSTRAINT chk_facturas_modo
    CHECK (modo_afip IN ('homologacion', 'produccion'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_facturas_pedido_unica
  ON facturas (empresa_id, pedido_id)
  WHERE pedido_id IS NOT NULL AND estado <> 'anulada';

CREATE INDEX IF NOT EXISTS idx_facturas_empresa_estado
  ON facturas (empresa_id, estado, created_at DESC);

CREATE TABLE IF NOT EXISTS factura_items (
  id BIGSERIAL PRIMARY KEY,
  factura_id BIGINT NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
  producto_id INT REFERENCES productos(id) ON DELETE SET NULL,
  descripcion TEXT NOT NULL,
  cantidad NUMERIC(12,3) NOT NULL DEFAULT 1,
  precio_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
  alicuota_iva NUMERIC(5,2) NOT NULL DEFAULT 0,
  importe_neto NUMERIC(12,2) NOT NULL DEFAULT 0,
  importe_iva NUMERIC(12,2) NOT NULL DEFAULT 0,
  importe_total NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_factura_items_factura
  ON factura_items (factura_id);

CREATE TABLE IF NOT EXISTS factura_afip_auditoria (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  factura_id BIGINT REFERENCES facturas(id) ON DELETE SET NULL,
  servicio TEXT NOT NULL,
  operacion TEXT NOT NULL,
  request_xml TEXT,
  response_xml TEXT,
  resultado TEXT,
  error_codigo TEXT,
  error_mensaje TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_factura_afip_auditoria_factura
  ON factura_afip_auditoria (factura_id, created_at DESC);

CREATE TABLE IF NOT EXISTS factura_eventos (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  factura_id BIGINT REFERENCES facturas(id) ON DELETE SET NULL,
  usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
  accion TEXT NOT NULL,
  detalle TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_factura_eventos_factura
  ON factura_eventos (factura_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_factura_eventos_empresa
  ON factura_eventos (empresa_id, created_at DESC);

