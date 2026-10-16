-- Explicit migration only. Run inside a transaction under the runner advisory lock.
-- No historical backfill and no dependency on the application feature flag.
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS menu_config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.productos ADD COLUMN IF NOT EXISTS disponibilidad_config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS fecha_entrega_programada DATE;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS menu_intent_hash TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS menu_channel TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.pedidos'::pg_catalog.regclass AND conname = 'pedidos_menu_channel_check') THEN
    ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_menu_channel_check
      CHECK (menu_channel IS NULL OR menu_channel IN ('catalog', 'landing'));
  END IF;
END $$;

-- A statement-level write barrier is deliberately global, not a SUM-based check.
-- Updating (rather than just advisory-locking) this row also gives snapshot-based
-- isolation a serialization failure instead of allowing stale capacity/config reads.
CREATE TABLE IF NOT EXISTS public.menu_write_barrier (
  id INTEGER PRIMARY KEY CHECK (id = 1), revision BIGINT NOT NULL DEFAULT 0
);
INSERT INTO public.menu_write_barrier(id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.menu_cupos_diarios (
  empresa_id INTEGER NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES public.productos(id) ON DELETE CASCADE,
  fecha DATE NOT NULL,
  reservado NUMERIC NOT NULL DEFAULT 0 CHECK (reservado >= 0 AND reservado < 'Infinity'::numeric),
  PRIMARY KEY (empresa_id, producto_id, fecha)
);
CREATE TABLE IF NOT EXISTS public.menu_reservas_items (
  item_id INTEGER PRIMARY KEY REFERENCES public.items_pedido(id) DEFERRABLE INITIALLY DEFERRED,
  pedido_id INTEGER NOT NULL REFERENCES public.pedidos(id) DEFERRABLE INITIALLY DEFERRED,
  empresa_id INTEGER NOT NULL REFERENCES public.empresas(id) DEFERRABLE INITIALLY DEFERRED,
  producto_id INTEGER NOT NULL REFERENCES public.productos(id) DEFERRABLE INITIALLY DEFERRED,
  fecha DATE NOT NULL,
  cantidad NUMERIC NOT NULL CHECK (cantidad > 0 AND cantidad < 'Infinity'::numeric),
  entregado BOOLEAN NOT NULL DEFAULT FALSE,
  activa BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (empresa_id, producto_id, fecha) REFERENCES public.menu_cupos_diarios
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS menu_reservas_pedido_idx ON public.menu_reservas_items(pedido_id);
CREATE INDEX IF NOT EXISTS menu_reservas_producto_idx ON public.menu_reservas_items(producto_id);

CREATE OR REPLACE FUNCTION public.menu_serialize_writes() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.menu_write_barrier SET revision = revision + 1 WHERE id = 1;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.menu_capacity(config jsonb, service_date date) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE value jsonb; exception jsonb; capacity numeric; seen_dates text[] := '{}'; parsed_date date;
BEGIN
  IF pg_catalog.jsonb_typeof(config) IS DISTINCT FROM 'object'
    OR (config ? 'exceptions' AND pg_catalog.jsonb_typeof(config->'exceptions') IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'MENU_INVALID_CAPACITY' USING ERRCODE = '23514';
  END IF;
  -- Validate every capacity, not only the one selected for this date. The app
  -- uses Number.MAX_SAFE_INTEGER and rejects duplicate exception dates.
  FOR value IN SELECT config->'daily_capacity' UNION ALL
    SELECT v->'capacity' FROM pg_catalog.jsonb_array_elements(COALESCE(config->'exceptions','[]'::jsonb)) v LOOP
    IF value IS NULL OR value = 'null'::jsonb THEN CONTINUE; END IF;
    IF pg_catalog.jsonb_typeof(value) <> 'number' THEN
      RAISE EXCEPTION 'MENU_INVALID_CAPACITY' USING ERRCODE = '23514';
    END IF;
    capacity := value::text::numeric;
    IF capacity < 0 OR capacity > 9007199254740991 THEN
      RAISE EXCEPTION 'MENU_INVALID_CAPACITY' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  value := config->'daily_capacity';
  FOR exception IN SELECT v FROM pg_catalog.jsonb_array_elements(COALESCE(config->'exceptions','[]'::jsonb)) v LOOP
    IF pg_catalog.jsonb_typeof(exception) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(exception->'date') IS DISTINCT FROM 'string'
      OR (exception->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR (exception->>'date') = ANY(seen_dates) THEN
      RAISE EXCEPTION 'MENU_INVALID_CAPACITY' USING ERRCODE = '23514';
    END IF;
    BEGIN
      parsed_date := (exception->>'date')::date;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'MENU_INVALID_CAPACITY' USING ERRCODE = '23514';
    END;
    seen_dates := pg_catalog.array_append(seen_dates, exception->>'date');
    IF exception->>'date' = pg_catalog.to_char(service_date, 'YYYY-MM-DD') AND exception ? 'capacity' THEN
      value := exception->'capacity';
    END IF;
  END LOOP;
  IF value IS NULL OR value = 'null'::jsonb THEN RETURN NULL; END IF;
  RETURN value::text::numeric;
END $$;

CREATE OR REPLACE FUNCTION public.menu_release_item(target integer) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE previous public.menu_reservas_items%ROWTYPE;
BEGIN
  SELECT * INTO previous FROM public.menu_reservas_items WHERE item_id = target;
  IF NOT FOUND THEN RETURN; END IF;
  IF previous.entregado THEN
    RAISE EXCEPTION 'MENU_DELIVERED_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF previous.activa THEN
    UPDATE public.menu_cupos_diarios SET reservado = reservado - previous.cantidad
      WHERE empresa_id = previous.empresa_id AND producto_id = previous.producto_id AND fecha = previous.fecha;
  END IF;
  DELETE FROM public.menu_reservas_items WHERE item_id = target;
END $$;

CREATE OR REPLACE FUNCTION public.menu_sync_item(target integer) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE item public.items_pedido%ROWTYPE; order_row public.pedidos%ROWTYPE;
  product public.productos%ROWTYPE; previous public.menu_reservas_items%ROWTYPE;
  company_config jsonb; scheduled boolean; had_reservation boolean; capacity numeric; consumed numeric; active boolean;
BEGIN
  SELECT * INTO item FROM public.items_pedido WHERE id = target;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO order_row FROM public.pedidos WHERE id = item.pedido_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'MENU_ORDER_REQUIRED' USING ERRCODE = '23503'; END IF;
  SELECT menu_config INTO company_config FROM public.empresas WHERE id = order_row.empresa_id;
  SELECT * INTO previous FROM public.menu_reservas_items WHERE item_id = target;
  had_reservation := FOUND;
  IF item.producto_id IS NULL THEN
    -- Only server-generated accounting discounts are nonphysical. Gifts still
    -- require canonical identity and consume capacity, even with a zero price.
    IF NOT had_reservation AND item.cantidad = 1
      AND pg_catalog.starts_with(item.producto, '🎟️ DESCUENTO PROMO: ')
      AND pg_catalog.length(pg_catalog.btrim(pg_catalog.substr(item.producto, pg_catalog.length('🎟️ DESCUENTO PROMO: ') + 1))) > 0
      AND (pg_catalog.to_jsonb(item)->>'precio_unitario')::numeric < 0
      AND (pg_catalog.to_jsonb(item)->>'precio_unitario')::numeric > '-Infinity'::numeric THEN
      RETURN;
    END IF;
    IF had_reservation OR (company_config->'enabled' = 'true'::jsonb AND EXISTS (
      SELECT 1 FROM public.productos WHERE empresa_id = order_row.empresa_id AND disponibilidad_config->'enabled' = 'true'::jsonb
    )) THEN
      RAISE EXCEPTION 'MENU_CANONICAL_PRODUCT_REQUIRED' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  SELECT * INTO product FROM public.productos WHERE id = item.producto_id;
  IF NOT FOUND OR product.empresa_id IS DISTINCT FROM order_row.empresa_id THEN
    RAISE EXCEPTION 'MENU_PRODUCT_TENANT_MISMATCH' USING ERRCODE = '23503';
  END IF;
  scheduled := COALESCE(company_config->'enabled' = 'true'::jsonb AND product.disponibilidad_config->'enabled' = 'true'::jsonb, false);
  IF previous.entregado THEN
    IF previous.pedido_id IS DISTINCT FROM item.pedido_id OR previous.producto_id IS DISTINCT FROM item.producto_id
      OR previous.empresa_id IS DISTINCT FROM order_row.empresa_id OR previous.fecha IS DISTINCT FROM order_row.fecha_entrega_programada
      OR previous.cantidad IS DISTINCT FROM item.cantidad THEN
      RAISE EXCEPTION 'MENU_DELIVERED_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  IF had_reservation THEN PERFORM public.menu_release_item(target); END IF;
  IF NOT (scheduled OR had_reservation) THEN RETURN; END IF;
  IF item.cantidad IS NULL OR item.cantidad <= 0 OR item.cantidad > 9007199254740991 THEN
    RAISE EXCEPTION 'MENU_INVALID_QUANTITY' USING ERRCODE = '23514';
  END IF;
  IF order_row.fecha_entrega_programada IS NULL OR NOT pg_catalog.isfinite(order_row.fecha_entrega_programada) THEN
    RAISE EXCEPTION 'MENU_SERVICE_DATE_REQUIRED' USING ERRCODE = '23514';
  END IF;
  active := pg_catalog.lower(COALESCE(order_row.estado,'')) <> 'cancelado';
  consumed := CASE WHEN active THEN item.cantidad ELSE 0 END;
  capacity := public.menu_capacity(product.disponibilidad_config, order_row.fecha_entrega_programada);
  INSERT INTO public.menu_cupos_diarios(empresa_id,producto_id,fecha,reservado)
    VALUES(order_row.empresa_id,item.producto_id,order_row.fecha_entrega_programada,consumed)
    ON CONFLICT (empresa_id,producto_id,fecha) DO UPDATE
    SET reservado = public.menu_cupos_diarios.reservado + EXCLUDED.reservado
    WHERE capacity IS NULL OR public.menu_cupos_diarios.reservado + EXCLUDED.reservado <= capacity;
  IF NOT FOUND THEN RAISE EXCEPTION 'MENU_CAPACITY_EXCEEDED' USING ERRCODE = '23514'; END IF;
  -- The conflict WHERE cannot guard a brand new key.
  IF capacity IS NOT NULL AND consumed > capacity THEN
    RAISE EXCEPTION 'MENU_CAPACITY_EXCEEDED' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.menu_reservas_items(item_id,pedido_id,empresa_id,producto_id,fecha,cantidad,entregado,activa)
    VALUES(target,item.pedido_id,order_row.empresa_id,item.producto_id,order_row.fecha_entrega_programada,item.cantidad,
      pg_catalog.lower(COALESCE(order_row.estado,'')) = 'entregado', active);
END $$;

CREATE OR REPLACE FUNCTION public.menu_items_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM public.menu_release_item(OLD.id); RETURN OLD; END IF;
  -- An unrelated edit is not a new scheduling intent for an unreserved legacy
  -- line. Identity, quantity, parent and date changes still use the full guard.
  IF TG_OP = 'UPDATE' AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.pedido_id IS NOT DISTINCT FROM OLD.pedido_id
    AND NEW.producto_id IS NOT DISTINCT FROM OLD.producto_id
    AND NEW.producto IS NOT DISTINCT FROM OLD.producto
    AND NOT COALESCE(pg_catalog.starts_with(OLD.producto, '🎟️ DESCUENTO PROMO: '), false)
    AND NEW.cantidad IS NOT DISTINCT FROM OLD.cantidad
    AND NOT EXISTS (SELECT 1 FROM public.menu_reservas_items WHERE item_id = OLD.id)
    AND EXISTS (SELECT 1 FROM public.pedidos WHERE id = NEW.pedido_id AND fecha_entrega_programada IS NULL) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    IF EXISTS (SELECT 1 FROM public.menu_reservas_items WHERE item_id = OLD.id AND entregado) THEN
      RAISE EXCEPTION 'MENU_DELIVERED_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    UPDATE public.menu_reservas_items SET item_id = NEW.id WHERE item_id = OLD.id;
  END IF;
  PERFORM public.menu_sync_item(NEW.id);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.menu_orders_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE target integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    FOR target IN SELECT item_id FROM public.menu_reservas_items WHERE pedido_id = OLD.id ORDER BY item_id LOOP
      PERFORM public.menu_release_item(target);
    END LOOP;
    RETURN OLD;
  END IF;
  IF NEW.menu_channel IS DISTINCT FROM OLD.menu_channel
    AND ((OLD.fecha_entrega_programada IS NOT NULL AND OLD.menu_intent_hash IS NOT NULL)
      OR EXISTS (SELECT 1 FROM public.menu_reservas_items WHERE pedido_id = OLD.id)) THEN
    RAISE EXCEPTION 'MENU_CHANNEL_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  -- Payment/logistics metadata must never retrofit scheduling onto old orders.
  IF NEW.id IS NOT DISTINCT FROM OLD.id AND NEW.empresa_id IS NOT DISTINCT FROM OLD.empresa_id
    AND NEW.fecha_entrega_programada IS NOT DISTINCT FROM OLD.fecha_entrega_programada
    AND pg_catalog.lower(COALESCE(NEW.estado,'')) = pg_catalog.lower(COALESCE(OLD.estado,'')) THEN
    RETURN NEW;
  END IF;
  FOR target IN SELECT i.id FROM public.items_pedido i WHERE i.pedido_id = NEW.id ORDER BY i.id LOOP
    -- Preserve historical, dateless, unreserved lines through normal lifecycle,
    -- but never grandfather a reopening, tenant/date change, or existing ledger.
    IF NEW.id IS NOT DISTINCT FROM OLD.id AND NEW.empresa_id IS NOT DISTINCT FROM OLD.empresa_id
      AND NEW.fecha_entrega_programada IS NULL AND OLD.fecha_entrega_programada IS NULL
      AND (pg_catalog.lower(COALESCE(OLD.estado,'')) NOT IN ('cancelado','entregado')
        OR pg_catalog.lower(COALESCE(NEW.estado,'')) IN ('cancelado','entregado'))
      AND NOT EXISTS (SELECT 1 FROM public.menu_reservas_items WHERE item_id = target) THEN
      CONTINUE;
    END IF;
    PERFORM public.menu_sync_item(target);
  END LOOP;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.menu_product_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE counter public.menu_cupos_diarios%ROWTYPE; capacity numeric;
BEGIN
  IF TG_OP = 'DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id THEN
    IF EXISTS (SELECT 1 FROM public.menu_reservas_items WHERE producto_id = OLD.id) THEN
      RAISE EXCEPTION 'MENU_PRODUCT_COMMITTED' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  END IF;
  -- Check even when disabled/paused: existing commitments never disappear.
  FOR counter IN SELECT * FROM public.menu_cupos_diarios WHERE producto_id = OLD.id ORDER BY fecha LOOP
    capacity := public.menu_capacity(NEW.disponibilidad_config, counter.fecha);
    IF capacity IS NOT NULL AND counter.reservado > capacity THEN
      RAISE EXCEPTION 'MENU_CAPACITY_BELOW_RESERVED' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.menu_company_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE target integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    FOR target IN SELECT item_id FROM public.menu_reservas_items WHERE empresa_id = OLD.id ORDER BY item_id LOOP
      PERFORM public.menu_release_item(target);
    END LOOP;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id AND EXISTS (SELECT 1 FROM public.menu_reservas_items WHERE empresa_id = OLD.id) THEN
    RAISE EXCEPTION 'MENU_COMPANY_COMMITTED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS menu_write_barrier ON public.empresas;
CREATE TRIGGER menu_write_barrier BEFORE INSERT OR UPDATE OR DELETE ON public.empresas FOR EACH STATEMENT EXECUTE FUNCTION public.menu_serialize_writes();
DROP TRIGGER IF EXISTS menu_write_barrier ON public.productos;
CREATE TRIGGER menu_write_barrier BEFORE INSERT OR UPDATE OR DELETE ON public.productos FOR EACH STATEMENT EXECUTE FUNCTION public.menu_serialize_writes();
DROP TRIGGER IF EXISTS menu_write_barrier ON public.pedidos;
CREATE TRIGGER menu_write_barrier BEFORE INSERT OR UPDATE OR DELETE ON public.pedidos FOR EACH STATEMENT EXECUTE FUNCTION public.menu_serialize_writes();
DROP TRIGGER IF EXISTS menu_write_barrier ON public.items_pedido;
CREATE TRIGGER menu_write_barrier BEFORE INSERT OR UPDATE OR DELETE ON public.items_pedido FOR EACH STATEMENT EXECUTE FUNCTION public.menu_serialize_writes();
DROP TRIGGER IF EXISTS menu_items_sync ON public.items_pedido;
CREATE TRIGGER menu_items_sync AFTER INSERT OR UPDATE ON public.items_pedido FOR EACH ROW EXECUTE FUNCTION public.menu_items_changed();
DROP TRIGGER IF EXISTS menu_items_delete ON public.items_pedido;
CREATE TRIGGER menu_items_delete BEFORE DELETE ON public.items_pedido FOR EACH ROW EXECUTE FUNCTION public.menu_items_changed();
DROP TRIGGER IF EXISTS menu_orders_sync ON public.pedidos;
CREATE TRIGGER menu_orders_sync AFTER UPDATE ON public.pedidos FOR EACH ROW EXECUTE FUNCTION public.menu_orders_changed();
DROP TRIGGER IF EXISTS menu_orders_delete ON public.pedidos;
CREATE TRIGGER menu_orders_delete BEFORE DELETE ON public.pedidos FOR EACH ROW EXECUTE FUNCTION public.menu_orders_changed();
DROP TRIGGER IF EXISTS menu_product_guard ON public.productos;
CREATE TRIGGER menu_product_guard BEFORE UPDATE OR DELETE ON public.productos FOR EACH ROW EXECUTE FUNCTION public.menu_product_guard();
DROP TRIGGER IF EXISTS menu_company_guard ON public.empresas;
CREATE TRIGGER menu_company_guard BEFORE UPDATE OR DELETE ON public.empresas FOR EACH ROW EXECUTE FUNCTION public.menu_company_guard();
