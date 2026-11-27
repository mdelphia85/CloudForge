CREATE TABLE equipment_alarm_rule_source_state (
  rule_id uuid NOT NULL REFERENCES equipment_alarm_rules(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES asset_telemetry_sources(id) ON DELETE RESTRICT,
  consecutive_matches integer NOT NULL DEFAULT 0 CHECK (consecutive_matches >= 0),
  PRIMARY KEY (rule_id, source_id)
);

INSERT INTO equipment_alarm_rule_source_state(rule_id, source_id, consecutive_matches)
SELECT r.id, s.id, r.consecutive_matches
FROM equipment_alarm_rules r
JOIN LATERAL (
  SELECT id FROM asset_telemetry_sources
  WHERE asset_id = r.asset_id AND enabled
  ORDER BY (provider = 'gateway') DESC
  LIMIT 1
) s ON true
WHERE r.consecutive_matches > 0;
