-- This compatibility stage deliberately permits only the existing installation.
-- Remove the singleton constraint only after all operational paths are isolated.
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  deployment_type text NOT NULL DEFAULT 'existing' CHECK (deployment_type IN ('existing', 'saas', 'dedicated', 'on_premises', 'air_gapped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organizations_single_installation_only ON organizations ((true));
INSERT INTO organizations (identifier, name) VALUES ('existing-installation', 'Existing installation');

CREATE TABLE organization_memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
INSERT INTO organization_memberships (organization_id, user_id, role)
SELECT o.id, u.id, u.role FROM users u CROSS JOIN organizations o;

CREATE FUNCTION maintain_existing_organization_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO organization_memberships (organization_id, user_id, role)
  SELECT id, NEW.id, NEW.role FROM organizations
  ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Existing installation organization is missing';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_existing_organization_membership
  AFTER INSERT OR UPDATE OF role ON users
  FOR EACH ROW EXECUTE FUNCTION maintain_existing_organization_membership();

CREATE TABLE platform_owners (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_owner_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  database_role text NOT NULL,
  action text NOT NULL CHECK (action = 'granted'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER platform_owner_events_append_only BEFORE UPDATE OR DELETE ON platform_owner_events
FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
CREATE TRIGGER platform_owner_events_no_truncate BEFORE TRUNCATE ON platform_owner_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_event_mutation();

CREATE TABLE organization_licenses (
  license_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  signed_payload text NOT NULL,
  signature text NOT NULL,
  issued_at timestamptz NOT NULL,
  activated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  installed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  CHECK (issued_at <= activated_at AND activated_at < expires_at)
);
CREATE INDEX organization_licenses_organization_idx ON organization_licenses (organization_id, issued_at DESC);

CREATE TABLE organization_license_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  license_id uuid NOT NULL REFERENCES organization_licenses(license_id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action = 'installed'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organization_license_events_append_only BEFORE UPDATE OR DELETE ON organization_license_events
FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
CREATE TRIGGER organization_license_events_no_truncate BEFORE TRUNCATE ON organization_license_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_event_mutation();

-- A constant default backfills historical rows without invoking append-only
-- update triggers and preserves the current single-organization write paths.
DO $$
DECLARE
  legacy_id uuid;
  table_name text;
BEGIN
  SELECT id INTO STRICT legacy_id FROM organizations WHERE identifier = 'existing-installation';
  FOREACH table_name IN ARRAY ARRAY[
    'sessions', 'inventory_items', 'inventory_stock', 'inventory_movements', 'audit_events',
    'projects', 'project_tasks', 'engineering_assets', 'engineering_bom_lines',
    'engineering_documents', 'engineering_revisions', 'production_jobs', 'production_events',
    'purchase_requests', 'field_service_jobs', 'field_program_installs', 'suppliers',
    'purchase_orders', 'purchase_order_lines', 'purchase_receipts', 'inventory_reservations',
    'engineering_bom_revisions', 'engineering_bom_revision_lines', 'engineering_change_orders',
    'engineering_change_links', 'engineering_change_approvals', 'project_task_dependencies',
    'project_milestones', 'project_milestone_dependencies', 'project_resources', 'project_cost_entries',
    'production_work_centers', 'production_shifts', 'production_job_assignments', 'production_downtime',
    'field_service_parts', 'field_service_updates', 'engineering_change_implementation_evidence',
    'asset_telemetry_sources', 'asset_telemetry_tags', 'asset_telemetry_samples',
    'asset_telemetry_hourly_rollups', 'maintenance_plans', 'maintenance_plan_checklist',
    'maintenance_work_orders', 'maintenance_work_order_checklist', 'maintenance_work_order_events',
    'maintenance_work_order_parts', 'maintenance_work_order_cost_events', 'asset_downtime_events',
    'equipment_alarm_rules', 'equipment_alarms', 'equipment_alarm_events', 'industrial_gateways',
    'gateway_allowed_tags', 'gateway_telemetry_batches', 'equipment_alarm_rule_source_state'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN organization_id uuid NOT NULL DEFAULT %L::uuid REFERENCES organizations(id) ON DELETE RESTRICT',
      table_name, legacy_id
    );
  END LOOP;
END;
$$;
