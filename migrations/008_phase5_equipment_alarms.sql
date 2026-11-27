CREATE TABLE equipment_alarm_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  tag_id uuid NOT NULL REFERENCES asset_telemetry_tags(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
  condition text NOT NULL CHECK (condition IN ('above','below','equals')),
  threshold text NOT NULL CHECK (length(threshold) BETWEEN 1 AND 1000),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  debounce_samples integer NOT NULL DEFAULT 1 CHECK (debounce_samples BETWEEN 1 AND 10),
  consecutive_matches integer NOT NULL DEFAULT 0 CHECK (consecutive_matches >= 0),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, name)
);
CREATE INDEX equipment_alarm_rules_tag_idx ON equipment_alarm_rules(tag_id) WHERE enabled;

CREATE TABLE equipment_alarms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES equipment_alarm_rules(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  triggered_at timestamptz NOT NULL,
  trigger_value text NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  cleared_at timestamptz,
  clear_value text,
  CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
  CHECK ((cleared_at IS NULL) = (clear_value IS NULL))
);
CREATE UNIQUE INDEX equipment_alarms_one_active_idx ON equipment_alarms(rule_id) WHERE cleared_at IS NULL;
CREATE INDEX equipment_alarms_asset_idx ON equipment_alarms(asset_id, triggered_at DESC);

CREATE TABLE equipment_alarm_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alarm_id uuid NOT NULL REFERENCES equipment_alarms(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('triggered','acknowledged','cleared')),
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  value text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX equipment_alarm_events_history_idx ON equipment_alarm_events(alarm_id, occurred_at, id);
CREATE TRIGGER equipment_alarm_events_append_only BEFORE UPDATE OR DELETE ON equipment_alarm_events
FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
CREATE TRIGGER equipment_alarm_events_no_truncate BEFORE TRUNCATE ON equipment_alarm_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_event_mutation();
