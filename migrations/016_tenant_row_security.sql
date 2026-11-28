-- Strict organization row-level security for customer operational tables.
-- IMPORTANT: application connections MUST use a non-superuser/NOBYPASSRLS role
-- for these policies to enforce tenant isolation. Production provisioning and
-- credential separation are independent release gates.
--
-- Sessions and control-plane license tables intentionally remain globally
-- addressable for authentication and platform-owner operations, and therefore
-- require application-level authorization. Audit and gateway-identity tables
-- also need dedicated global-auth / signed-ingestion treatment.
DO $$
DECLARE
  record_table record;
  check_expr text :=
    'organization_id = NULLIF(current_setting(''cloudforge.organization_id'', true), '''')::uuid';
BEGIN
  FOR record_table IN
    SELECT c.oid::regclass AS relation
    FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
                  AND a.attname='organization_id' AND NOT a.attisdropped)
      AND c.relname NOT IN (
        'sessions', 'audit_events',
        'industrial_gateways', 'gateway_allowed_tags', 'gateway_telemetry_batches',
        'organization_licenses', 'organization_license_events', 'organization_memberships'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',record_table.relation);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',record_table.relation);
    EXECUTE format(
      'CREATE POLICY cloudforge_tenant_scope ON %s FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      record_table.relation,check_expr,check_expr
    );
  END LOOP;
END;
$$;
