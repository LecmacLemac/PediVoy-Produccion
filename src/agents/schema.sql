-- Personal integrations: intentionally no FKs into legacy user/company tables.
-- Deleted identities fail closed on canonical revalidation; legacy deletion is not blocked.
CREATE TABLE IF NOT EXISTS public.agent_connections (
 id uuid PRIMARY KEY,
 owner_uid integer NOT NULL,
 empresa_id integer NOT NULL CHECK (empresa_id > 0),
 owner_empresa_id integer,
 owner_chofer_id integer,
 owner_referente_id integer,
 role_at_issue text NOT NULL,
 name varchar(80) NOT NULL,
 scopes text[] NOT NULL,
 token_hash varchar(64) NOT NULL,
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 quota_start timestamptz,
 quota_count integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agent_connections_owner ON public.agent_connections(owner_uid,created_at DESC);
CREATE INDEX IF NOT EXISTS agent_connections_driver ON public.agent_connections(owner_chofer_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS agent_connections_referent ON public.agent_connections(owner_referente_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS public.agent_owner_quotas (
 owner_uid integer PRIMARY KEY,
 calls_start timestamptz,
 calls_count integer NOT NULL DEFAULT 0,
 creates_start timestamptz,
 creates_count integer NOT NULL DEFAULT 0
);

-- Permanent revocation survives identity A -> B -> A and account reactivation.
-- Lock order in the service is owner -> link -> company -> quota -> connection.
CREATE OR REPLACE FUNCTION public.revoke_sensitive_agent_connections() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF TG_TABLE_NAME = 'usuarios' THEN
  IF TG_OP = 'DELETE' OR OLD.empresa_id IS DISTINCT FROM NEW.empresa_id
   OR OLD.chofer_id IS DISTINCT FROM NEW.chofer_id
   OR OLD.referente_id IS DISTINCT FROM NEW.referente_id
   OR OLD.activo IS DISTINCT FROM NEW.activo THEN
   UPDATE public.agent_connections SET revoked_at = pg_catalog.clock_timestamp()
    WHERE owner_uid = OLD.id AND revoked_at IS NULL;
  END IF;
 ELSIF TG_TABLE_NAME = 'choferes' THEN
  IF TG_OP = 'DELETE' OR OLD.empresa_id IS DISTINCT FROM NEW.empresa_id
   OR OLD.activo IS DISTINCT FROM NEW.activo
   OR (pg_catalog.to_jsonb(OLD)->'deleted_at') IS DISTINCT FROM (pg_catalog.to_jsonb(NEW)->'deleted_at') THEN
   UPDATE public.agent_connections SET revoked_at = pg_catalog.clock_timestamp()
    WHERE owner_chofer_id = OLD.id AND revoked_at IS NULL;
  END IF;
 ELSIF TG_TABLE_NAME = 'referentes' THEN
  IF TG_OP = 'DELETE' OR OLD.empresa_id IS DISTINCT FROM NEW.empresa_id
   OR OLD.activo IS DISTINCT FROM NEW.activo
   OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
   UPDATE public.agent_connections SET revoked_at = pg_catalog.clock_timestamp()
    WHERE owner_referente_id = OLD.id AND revoked_at IS NULL;
  END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
DO $$
DECLARE relation_name text;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['usuarios','choferes','referentes'] LOOP
  IF pg_catalog.to_regclass('public.' || relation_name) IS NOT NULL THEN
   EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS revoke_sensitive_agents ON public.%I', relation_name);
   EXECUTE pg_catalog.format('CREATE TRIGGER revoke_sensitive_agents BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.revoke_sensitive_agent_connections()', relation_name);
  END IF;
 END LOOP;
END;
$$;
CREATE TABLE IF NOT EXISTS public.agent_audit (
 id bigserial PRIMARY KEY,
 connection_id uuid NOT NULL,
 owner_uid integer NOT NULL,
 empresa_id integer NOT NULL,
 tool varchar(80) NOT NULL,
 scope varchar(80),
 outcome varchar(24) NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_audit_owner ON public.agent_audit(owner_uid,id DESC);
CREATE TABLE IF NOT EXISTS public.agent_idempotency (
 connection_id uuid NOT NULL,
 idempotency_key uuid NOT NULL,
 tool varchar(80) NOT NULL,
 request_hash varchar(64) NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(connection_id,idempotency_key)
);
