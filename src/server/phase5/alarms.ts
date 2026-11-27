import "server-only";
import type { PoolClient } from "pg";
import type { AuthenticatedUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { audit, requireAssetAccess, requireOperationsRole, requireUuid, shortText } from "@/server/phase4/shared";

type Rule = {
  id: string;
  condition: "above" | "below" | "equals";
  threshold: string;
  severity: string;
  debounce_samples: number;
  data_type: string;
};
export type AlarmActor = { user: AuthenticatedUser; gatewayId?: never } | { user?: never; gatewayId: string };

async function recordAutomaticAlarm(
  client: PoolClient, actor: AlarmActor, alarmId: string, action: "triggered" | "cleared",
  value: string, ruleId: string, assetId: string,
) {
  await client.query(
    "INSERT INTO equipment_alarm_events(alarm_id,action,actor_id,gateway_actor_id,value) VALUES($1,$2,$3,$4,$5)",
    [alarmId, action, actor.user?.id ?? null, actor.gatewayId ?? null, value],
  );
  if (actor.user) {
    await audit(client, actor.user, `equipment_alarm.${action}`, "equipment_alarm", alarmId, { ruleId, assetId, value });
  } else {
    await client.query(
      "INSERT INTO audit_events(gateway_actor_id,action,entity_type,entity_id,details) VALUES($1,$2,'equipment_alarm',$3,$4)",
      [actor.gatewayId, `equipment_alarm.${action}`, alarmId, JSON.stringify({ ruleId, assetId, value })],
    );
  }
}

function matches(rule: Rule, value: string): boolean {
  if (rule.data_type === "number") {
    const measured = Number(value);
    const threshold = Number(rule.threshold);
    if (rule.condition === "above") return measured > threshold;
    if (rule.condition === "below") return measured < threshold;
    return measured === threshold;
  }
  return value === rule.threshold;
}

export async function evaluateAlarms(
  client: PoolClient,
  assetId: string,
  sourceId: string,
  tagId: string,
  value: string,
  observedAt: Date,
  actor: AlarmActor,
): Promise<void> {
  const rules = await client.query<Rule>(
    `SELECT r.id,r.condition,r.threshold,r.severity,r.debounce_samples,t.data_type
       FROM equipment_alarm_rules r JOIN asset_telemetry_tags t ON t.id=r.tag_id
      WHERE r.asset_id=$1 AND r.tag_id=$2 AND r.enabled ORDER BY r.id FOR UPDATE OF r`,
    [assetId, tagId],
  );
  for (const rule of rules.rows) {
    const active = await client.query<{ id: string }>(
      "SELECT id FROM equipment_alarms WHERE rule_id=$1 AND source_id=$2 AND cleared_at IS NULL FOR UPDATE",
      [rule.id, sourceId],
    );
    if (matches(rule, value)) {
      if (active.rowCount) continue;
      const state = await client.query<{ consecutive_matches: number }>(
        `INSERT INTO equipment_alarm_rule_source_state(rule_id,source_id,consecutive_matches) VALUES($1,$2,1)
         ON CONFLICT(rule_id,source_id) DO UPDATE SET consecutive_matches=
           LEAST(equipment_alarm_rule_source_state.consecutive_matches+1,$3)
         RETURNING consecutive_matches`,
        [rule.id, sourceId, rule.debounce_samples],
      );
      if (state.rows[0].consecutive_matches < rule.debounce_samples) continue;
      const alarm = await client.query<{ id: string }>(
        `INSERT INTO equipment_alarms(rule_id,asset_id,source_id,severity,triggered_at,trigger_value)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [rule.id, assetId, sourceId, rule.severity, observedAt, value],
      );
      await recordAutomaticAlarm(client, actor, alarm.rows[0].id, "triggered", value, rule.id, assetId);
    } else {
      await client.query("DELETE FROM equipment_alarm_rule_source_state WHERE rule_id=$1 AND source_id=$2", [rule.id, sourceId]);
      if (!active.rowCount) continue;
      await client.query("UPDATE equipment_alarms SET cleared_at=$2,clear_value=$3 WHERE id=$1", [active.rows[0].id, observedAt, value]);
      await recordAutomaticAlarm(client, actor, active.rows[0].id, "cleared", value, rule.id, assetId);
    }
  }
}

export async function listAlarms(assetId: string, user: AuthenticatedUser) {
  return inTransaction(async (client) => {
    await requireAssetAccess(client, assetId, user);
    const [rules, alarms] = await Promise.all([
      client.query(
        `SELECT r.id,r.name,r.condition,r.threshold,r.severity,r.enabled,r.debounce_samples AS "debounceSamples",
                t.label AS "tagLabel",t.id AS "tagId"
           FROM equipment_alarm_rules r JOIN asset_telemetry_tags t ON t.id=r.tag_id
          WHERE r.asset_id=$1 ORDER BY r.created_at DESC LIMIT 200`,
        [assetId],
      ),
      client.query(
        `SELECT a.id,a.severity,a.triggered_at AS "triggeredAt",a.trigger_value AS "triggerValue",
                a.acknowledged_at AS "acknowledgedAt",u.display_name AS "acknowledgedBy",
                a.cleared_at AS "clearedAt",a.clear_value AS "clearValue",r.name,src.provider,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('action',e.action,'value',e.value,
                  'at',e.occurred_at,'actor',COALESCE(actor.display_name,'Gateway: '||g.name)) ORDER BY e.occurred_at,e.id)
                  FROM equipment_alarm_events e LEFT JOIN users actor ON actor.id=e.actor_id
                  LEFT JOIN industrial_gateways g ON g.id=e.gateway_actor_id WHERE e.alarm_id=a.id),'[]'::jsonb) AS events
           FROM equipment_alarms a JOIN equipment_alarm_rules r ON r.id=a.rule_id
           JOIN asset_telemetry_sources src ON src.id=a.source_id
           LEFT JOIN users u ON u.id=a.acknowledged_by
          WHERE a.asset_id=$1 ORDER BY (a.cleared_at IS NULL) DESC,a.triggered_at DESC LIMIT 200`,
        [assetId],
      ),
    ]);
    return { rules: rules.rows, alarms: alarms.rows };
  });
}

export async function createAlarmRule(assetId: string, body: Record<string, unknown>, user: AuthenticatedUser) {
  requireOperationsRole(user);
  const tagId = requireUuid(body.tagId, "tagId");
  const name = shortText(body.name, "name", 160);
  if (name.length < 2) throw new HttpError(400, "INVALID_FIELD", "Name must have at least two characters.");
  const condition = body.condition;
  if (condition !== "above" && condition !== "below" && condition !== "equals") {
    throw new HttpError(400, "INVALID_CONDITION", "Choose above, below, or equals.");
  }
  const severity = body.severity;
  if (severity !== "low" && severity !== "medium" && severity !== "high" && severity !== "critical") {
    throw new HttpError(400, "INVALID_SEVERITY", "Choose low, medium, high, or critical.");
  }
  const threshold = shortText(body.threshold, "threshold", 1000);
  const debounce = body.debounceSamples === undefined ? 1 : Number(body.debounceSamples);
  if (!Number.isInteger(debounce) || debounce < 1 || debounce > 10) {
    throw new HttpError(400, "INVALID_DEBOUNCE", "Debounce must be from 1 to 10 samples.");
  }
  return inTransaction(async (client) => {
    const asset = await requireAssetAccess(client, assetId, user, true);
    if (asset.status === "retired") throw new HttpError(409, "EQUIPMENT_RETIRED", "Cannot add rules to retired equipment.");
    const tags = await client.query<{ data_type: string }>(
      "SELECT data_type FROM asset_telemetry_tags WHERE id=$1 AND asset_id=$2 AND enabled",
      [tagId, assetId],
    );
    if (!tags.rowCount) throw new HttpError(404, "TELEMETRY_TAG_NOT_FOUND", "Telemetry tag not found for this equipment.");
    const type = tags.rows[0].data_type;
    if ((type !== "number" && condition !== "equals") ||
        (type === "number" && !Number.isFinite(Number(threshold))) ||
        (type === "boolean" && threshold !== "true" && threshold !== "false")) {
      throw new HttpError(400, "INVALID_THRESHOLD", "Condition and threshold must match the tag's data type.");
    }
    const rule = await client.query<{ id: string }>(
      `INSERT INTO equipment_alarm_rules(asset_id,tag_id,name,condition,threshold,severity,debounce_samples,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [assetId, tagId, name, condition, threshold, severity, debounce, user.id],
    );
    await audit(client, user, "equipment_alarm.rule_created", "equipment_alarm_rule", rule.rows[0].id, { assetId, tagId, name, condition, threshold, severity, debounce });
    return { id: rule.rows[0].id };
  });
}

export async function acknowledgeAlarm(assetId: string, alarmId: string, user: AuthenticatedUser) {
  requireOperationsRole(user);
  return inTransaction(async (client) => {
    await requireAssetAccess(client, assetId, user, true);
    const result = await client.query<{ acknowledged_at: Date | null }>(
      "SELECT acknowledged_at FROM equipment_alarms WHERE id=$1 AND asset_id=$2 FOR UPDATE",
      [alarmId, assetId],
    );
    if (!result.rowCount) throw new HttpError(404, "ALARM_NOT_FOUND", "Alarm not found for this equipment.");
    if (result.rows[0].acknowledged_at) return { id: alarmId, alreadyAcknowledged: true };
    await client.query("UPDATE equipment_alarms SET acknowledged_at=now(),acknowledged_by=$2 WHERE id=$1", [alarmId, user.id]);
    await client.query("INSERT INTO equipment_alarm_events(alarm_id,action,actor_id) VALUES($1,'acknowledged',$2)", [alarmId, user.id]);
    await audit(client, user, "equipment_alarm.acknowledged", "equipment_alarm", alarmId, { assetId });
    return { id: alarmId, alreadyAcknowledged: false };
  });
}

export async function setAlarmRuleEnabled(assetId: string, ruleId: string, enabled: unknown, user: AuthenticatedUser) {
  requireOperationsRole(user);
  if (typeof enabled !== "boolean") throw new HttpError(400, "INVALID_FIELD", "enabled must be a boolean.");
  return inTransaction(async (client) => {
    await requireAssetAccess(client, assetId, user, true);
    const rule = await client.query<{ enabled: boolean }>(
      "SELECT enabled FROM equipment_alarm_rules WHERE id=$1 AND asset_id=$2 FOR UPDATE",
      [ruleId, assetId],
    );
    if (!rule.rowCount) throw new HttpError(404, "ALARM_RULE_NOT_FOUND", "Alarm rule not found for this equipment.");
    if (!enabled) {
      const active = await client.query("SELECT 1 FROM equipment_alarms WHERE rule_id=$1 AND cleared_at IS NULL", [ruleId]);
      if (active.rowCount) throw new HttpError(409, "ALARM_ACTIVE", "An active alarm must clear before its rule can be paused.");
    }
    if (rule.rows[0].enabled !== enabled) {
      await client.query("UPDATE equipment_alarm_rules SET enabled=$2,consecutive_matches=0 WHERE id=$1", [ruleId, enabled]);
      await client.query("DELETE FROM equipment_alarm_rule_source_state WHERE rule_id=$1", [ruleId]);
      await audit(client, user, "equipment_alarm.rule_enabled_changed", "equipment_alarm_rule", ruleId, { assetId, enabled });
    }
    return { id: ruleId, enabled };
  });
}
