-- Phase 4: equipment lifecycle, preventive maintenance, simulated telemetry,
-- equipment downtime, and bounded telemetry history.

ALTER TABLE engineering_assets
  ADD COLUMN manufacturer text NOT NULL DEFAULT '',
  ADD COLUMN model text NOT NULL DEFAULT '',
  ADD COLUMN serial_number text NOT NULL DEFAULT '',
  ADD COLUMN location text NOT NULL DEFAULT '',
  ADD COLUMN installed_on date,
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','standby','maintenance','retired')),
  ADD COLUMN parent_asset_id uuid REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  ADD COLUMN updated_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT engineering_assets_not_own_parent CHECK (parent_asset_id IS NULL OR parent_asset_id <> id);
CREATE INDEX engineering_assets_parent_idx ON engineering_assets(parent_asset_id);
CREATE INDEX engineering_assets_status_idx ON engineering_assets(status, asset_tag);

CREATE TABLE asset_telemetry_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL UNIQUE REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'simulated' CHECK (provider = 'simulated'),
  enabled boolean NOT NULL DEFAULT true,
  connection_state text NOT NULL DEFAULT 'disconnected'
    CHECK (connection_state IN ('connected','disconnected','faulted')),
  last_seen_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE asset_telemetry_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  tag_name text NOT NULL CHECK (length(tag_name) BETWEEN 1 AND 120),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
  data_type text NOT NULL CHECK (data_type IN ('number','boolean','string')),
  semantic_type text NOT NULL
    CHECK (semantic_type IN ('state','runtime_counter','cycle_counter','alarm','metric')),
  unit text NOT NULL DEFAULT '',
  minimum numeric(20,6),
  maximum numeric(20,6),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, tag_name),
  CHECK (minimum IS NULL OR maximum IS NULL OR minimum <= maximum),
  CHECK (semantic_type NOT IN ('runtime_counter','cycle_counter') OR data_type = 'number')
);
CREATE INDEX asset_telemetry_tags_semantic_idx ON asset_telemetry_tags(asset_id, semantic_type)
  WHERE enabled;

CREATE TABLE asset_telemetry_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id uuid NOT NULL REFERENCES asset_telemetry_tags(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES asset_telemetry_sources(id) ON DELETE RESTRICT,
  value text NOT NULL,
  numeric_value numeric(20,6),
  quality text NOT NULL CHECK (quality IN ('good','uncertain','bad')),
  ordering_state text NOT NULL DEFAULT 'ordered' CHECK (ordering_state IN ('ordered','out_of_order')),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX asset_telemetry_samples_tag_time_idx
  ON asset_telemetry_samples(tag_id, observed_at DESC, received_at DESC);
CREATE INDEX asset_telemetry_samples_retention_idx ON asset_telemetry_samples(observed_at);
CREATE TRIGGER asset_telemetry_samples_no_update
  BEFORE UPDATE ON asset_telemetry_samples
  FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

CREATE TABLE asset_telemetry_hourly_rollups (
  tag_id uuid NOT NULL REFERENCES asset_telemetry_tags(id) ON DELETE RESTRICT,
  bucket_start timestamptz NOT NULL,
  sample_count integer NOT NULL CHECK (sample_count > 0),
  numeric_count integer NOT NULL DEFAULT 0 CHECK (numeric_count >= 0),
  numeric_sum numeric(30,6) NOT NULL DEFAULT 0,
  numeric_min numeric(20,6),
  numeric_max numeric(20,6),
  last_value text NOT NULL,
  last_numeric_value numeric(20,6),
  last_quality text NOT NULL CHECK (last_quality IN ('good','uncertain','bad')),
  last_observed_at timestamptz NOT NULL,
  PRIMARY KEY (tag_id, bucket_start),
  CHECK (numeric_count <= sample_count)
);

CREATE TABLE maintenance_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  description text NOT NULL DEFAULT '',
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  trigger_type text NOT NULL CHECK (trigger_type IN ('calendar','runtime','cycle')),
  interval_days integer,
  interval_value numeric(20,3),
  next_due_at timestamptz,
  next_due_value numeric(20,3),
  assigned_to uuid REFERENCES users(id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, name),
  CHECK (
    (trigger_type = 'calendar' AND interval_days > 0 AND interval_value IS NULL AND next_due_at IS NOT NULL AND next_due_value IS NULL)
    OR
    (trigger_type IN ('runtime','cycle') AND interval_days IS NULL AND interval_value > 0 AND next_due_at IS NULL AND next_due_value > 0)
  )
);
CREATE INDEX maintenance_plans_due_idx ON maintenance_plans(is_active, trigger_type, next_due_at);
CREATE INDEX maintenance_plans_asset_idx ON maintenance_plans(asset_id, is_active);

CREATE TABLE maintenance_plan_checklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES maintenance_plans(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position > 0),
  label text NOT NULL CHECK (length(label) BETWEEN 2 AND 240),
  required boolean NOT NULL DEFAULT true,
  UNIQUE (plan_id, position)
);

CREATE TABLE maintenance_work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  plan_id uuid REFERENCES maintenance_plans(id) ON DELETE RESTRICT,
  due_instance text,
  work_type text NOT NULL CHECK (work_type IN ('preventive','corrective')),
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  description text NOT NULL DEFAULT '',
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','in_progress','completed','closed','cancelled')),
  due_at timestamptz,
  assigned_to uuid REFERENCES users(id) ON DELETE RESTRICT,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, due_instance),
  CHECK ((plan_id IS NULL) = (due_instance IS NULL)),
  CHECK ((status NOT IN ('completed','closed')) OR completed_at IS NOT NULL)
);
CREATE INDEX maintenance_work_orders_asset_idx ON maintenance_work_orders(asset_id, due_at DESC);
CREATE INDEX maintenance_work_orders_assignment_idx ON maintenance_work_orders(assigned_to, status, due_at);
CREATE INDEX maintenance_work_orders_status_idx ON maintenance_work_orders(status, due_at);

CREATE TABLE maintenance_work_order_checklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES maintenance_work_orders(id) ON DELETE RESTRICT,
  source_item_id uuid REFERENCES maintenance_plan_checklist(id) ON DELETE SET NULL,
  position integer NOT NULL CHECK (position > 0),
  label text NOT NULL CHECK (length(label) BETWEEN 2 AND 240),
  required boolean NOT NULL DEFAULT true,
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','pass','fail','not_applicable')),
  notes text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_order_id, position)
);

CREATE TABLE maintenance_work_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES maintenance_work_orders(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('created','assigned','started','checklist_updated','part_issued','part_returned','completed','closed','cancelled')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maintenance_work_order_events_history_idx
  ON maintenance_work_order_events(work_order_id, created_at DESC);
CREATE TRIGGER maintenance_work_order_events_append_only
  BEFORE UPDATE OR DELETE ON maintenance_work_order_events
  FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

CREATE TABLE maintenance_work_order_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES maintenance_work_orders(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('used','returned')),
  quantity numeric(15,3) NOT NULL CHECK (quantity > 0),
  location text NOT NULL,
  bin text NOT NULL,
  unit_cost numeric(15,4) NOT NULL CHECK (unit_cost >= 0),
  inventory_movement_id uuid NOT NULL UNIQUE REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  notes text NOT NULL DEFAULT '',
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, location, bin)
    REFERENCES inventory_stock(item_id, location, bin) ON DELETE RESTRICT
);
CREATE INDEX maintenance_work_order_parts_history_idx
  ON maintenance_work_order_parts(work_order_id, created_at DESC);
CREATE TRIGGER maintenance_work_order_parts_append_only
  BEFORE UPDATE OR DELETE ON maintenance_work_order_parts
  FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

CREATE TABLE maintenance_work_order_cost_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES maintenance_work_orders(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  source_part_id uuid UNIQUE REFERENCES maintenance_work_order_parts(id) ON DELETE RESTRICT,
  cost_type text NOT NULL CHECK (cost_type IN ('material','labor','other')),
  description text NOT NULL CHECK (length(description) BETWEEN 2 AND 240),
  amount numeric(15,4) NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maintenance_work_order_cost_project_idx
  ON maintenance_work_order_cost_events(project_id, created_at DESC);
CREATE INDEX maintenance_work_order_cost_history_idx
  ON maintenance_work_order_cost_events(work_order_id, created_at DESC);
CREATE TRIGGER maintenance_work_order_cost_events_append_only
  BEFORE UPDATE OR DELETE ON maintenance_work_order_cost_events
  FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

CREATE TABLE asset_downtime_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  production_downtime_id uuid UNIQUE REFERENCES production_downtime(id) ON DELETE RESTRICT,
  maintenance_work_order_id uuid REFERENCES maintenance_work_orders(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('manual','production')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 2 AND 240),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  notes text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL UNIQUE,
  reported_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at > started_at),
  CHECK ((source = 'production') = (production_downtime_id IS NOT NULL))
);
CREATE INDEX asset_downtime_events_asset_time_idx ON asset_downtime_events(asset_id, started_at DESC);
CREATE INDEX asset_downtime_events_work_order_idx ON asset_downtime_events(maintenance_work_order_id);
CREATE UNIQUE INDEX asset_downtime_one_open_idx ON asset_downtime_events(asset_id) WHERE ended_at IS NULL;

INSERT INTO asset_telemetry_sources(asset_id, provider, connection_state)
SELECT id, 'simulated', 'disconnected' FROM engineering_assets;

INSERT INTO asset_telemetry_tags(asset_id, tag_name, label, data_type, semantic_type, unit, minimum, maximum)
SELECT a.id, t.tag_name, t.label, t.data_type, t.semantic_type, t.unit, t.minimum, t.maximum
FROM engineering_assets a
CROSS JOIN (VALUES
  ('machine_state','Machine state','string','state','',NULL::numeric,NULL::numeric),
  ('runtime_seconds','Runtime','number','runtime_counter','s',0::numeric,NULL::numeric),
  ('cycle_count','Cycle count','number','cycle_counter','cycles',0::numeric,NULL::numeric),
  ('temperature_c','Temperature','number','metric','degC',-50::numeric,250::numeric),
  ('alarm_code','Alarm code','string','alarm','',NULL::numeric,NULL::numeric),
  ('production_count','Production count','number','metric','cycles',0::numeric,NULL::numeric)
) AS t(tag_name,label,data_type,semantic_type,unit,minimum,maximum);
