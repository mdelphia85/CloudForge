CREATE TABLE industrial_gateways (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
  public_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revoked_at timestamptz,
  highest_sequence bigint NOT NULL DEFAULT 0 CHECK (highest_sequence >= 0),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE asset_telemetry_sources
  DROP CONSTRAINT asset_telemetry_sources_asset_id_key,
  DROP CONSTRAINT asset_telemetry_sources_provider_check,
  ADD COLUMN gateway_id uuid REFERENCES industrial_gateways(id) ON DELETE RESTRICT,
  ADD COLUMN last_status_at timestamptz,
  ADD CONSTRAINT asset_telemetry_sources_provider_check CHECK (provider IN ('simulated', 'gateway')),
  ADD CONSTRAINT asset_telemetry_sources_gateway_check CHECK ((provider = 'gateway') = (gateway_id IS NOT NULL)),
  ADD CONSTRAINT asset_telemetry_sources_asset_provider_key UNIQUE (asset_id, provider);

CREATE TABLE gateway_allowed_tags (
  gateway_id uuid NOT NULL REFERENCES industrial_gateways(id) ON DELETE RESTRICT,
  tag_id uuid NOT NULL REFERENCES asset_telemetry_tags(id) ON DELETE RESTRICT,
  PRIMARY KEY (gateway_id, tag_id)
);

CREATE TABLE gateway_telemetry_batches (
  gateway_id uuid NOT NULL REFERENCES industrial_gateways(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence > 0),
  payload_hash text NOT NULL CHECK (length(payload_hash) = 64),
  asset_id uuid NOT NULL REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  accepted integer NOT NULL,
  out_of_order integer NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gateway_id, sequence)
);
CREATE TRIGGER gateway_telemetry_batches_append_only BEFORE UPDATE OR DELETE ON gateway_telemetry_batches
FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
CREATE TRIGGER gateway_telemetry_batches_no_truncate BEFORE TRUNCATE ON gateway_telemetry_batches
FOR EACH STATEMENT EXECUTE FUNCTION reject_event_mutation();

ALTER TABLE asset_telemetry_samples
  ALTER COLUMN created_by DROP NOT NULL,
  ADD COLUMN gateway_id uuid REFERENCES industrial_gateways(id) ON DELETE RESTRICT,
  ADD CONSTRAINT asset_telemetry_samples_actor_check CHECK ((created_by IS NULL) <> (gateway_id IS NULL));
CREATE UNIQUE INDEX asset_gateway_samples_observation_key
  ON asset_telemetry_samples(source_id,tag_id,observed_at) WHERE gateway_id IS NOT NULL;

ALTER TABLE asset_telemetry_hourly_rollups ADD COLUMN source_id uuid REFERENCES asset_telemetry_sources(id) ON DELETE RESTRICT;
UPDATE asset_telemetry_hourly_rollups r
SET source_id = s.id
FROM asset_telemetry_tags t JOIN asset_telemetry_sources s ON s.asset_id = t.asset_id AND s.provider = 'simulated'
WHERE r.tag_id = t.id;
ALTER TABLE asset_telemetry_hourly_rollups
  ALTER COLUMN source_id SET NOT NULL,
  DROP CONSTRAINT asset_telemetry_hourly_rollups_pkey,
  ADD PRIMARY KEY (tag_id, source_id, bucket_start);

ALTER TABLE audit_events
  ADD COLUMN gateway_actor_id uuid REFERENCES industrial_gateways(id) ON DELETE RESTRICT,
  DROP CONSTRAINT audit_events_actor_target_check,
  ADD CONSTRAINT audit_events_actor_target_check CHECK (
    (actor_user_id IS NOT NULL AND gateway_actor_id IS NULL AND entity_id IS NOT NULL)
    OR (actor_user_id IS NULL AND gateway_actor_id IS NOT NULL AND entity_id IS NOT NULL)
    OR (actor_user_id IS NULL AND gateway_actor_id IS NULL AND entity_id IS NULL
      AND action = 'auth.login_failed' AND entity_type = 'authentication')
  );
ALTER TABLE equipment_alarm_events
  ALTER COLUMN actor_id DROP NOT NULL,
  ADD COLUMN gateway_actor_id uuid REFERENCES industrial_gateways(id) ON DELETE RESTRICT,
  ADD CONSTRAINT equipment_alarm_events_actor_check CHECK ((actor_id IS NULL) <> (gateway_actor_id IS NULL));

ALTER TABLE equipment_alarms ADD COLUMN source_id uuid REFERENCES asset_telemetry_sources(id) ON DELETE RESTRICT;
UPDATE equipment_alarms a
SET source_id = s.id
FROM asset_telemetry_sources s
WHERE s.asset_id = a.asset_id AND s.provider = 'simulated';
ALTER TABLE equipment_alarms ALTER COLUMN source_id SET NOT NULL;
DROP INDEX equipment_alarms_one_active_idx;
CREATE UNIQUE INDEX equipment_alarms_one_active_idx ON equipment_alarms(rule_id,source_id) WHERE cleared_at IS NULL;
