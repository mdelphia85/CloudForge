import "server-only";
import type { AuthenticatedUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { audit, optionalText, requireUuid, shortText } from "./shared";

function parseTime(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new HttpError(400, "INVALID_TIME", `${name} must use 24-hour HH:MM format.`);
  }
  return value;
}

function parseTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
      Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, "INVALID_TIMESTAMP", `${name} must be a valid ISO timestamp with a timezone.`);
  }
  return new Date(value).toISOString();
}

export async function listProductionResources() {
  const [workCenters, shifts, assignments, downtime] = await Promise.all([
    getPool().query("SELECT * FROM production_work_centers ORDER BY code"),
    getPool().query("SELECT * FROM production_shifts ORDER BY starts_at"),
    getPool().query(
      "SELECT a.id,a.production_job_id AS \"productionJobId\",j.job_code AS \"jobCode\",j.title AS \"jobTitle\", " +
        "a.work_center_id AS \"workCenterId\",w.code AS \"workCenterCode\",a.shift_id AS \"shiftId\",sh.code AS \"shiftCode\", " +
        "a.operator_id AS \"operatorId\",u.display_name AS \"operatorName\",a.assigned_at AS \"assignedAt\" " +
        "FROM production_job_assignments a JOIN production_jobs j ON j.id=a.production_job_id " +
        "JOIN production_work_centers w ON w.id=a.work_center_id JOIN production_shifts sh ON sh.id=a.shift_id " +
        "JOIN users u ON u.id=a.operator_id WHERE a.is_active ORDER BY a.assigned_at DESC",
    ),
    getPool().query(
      "SELECT d.id,d.production_job_id AS \"productionJobId\",j.job_code AS \"jobCode\", " +
        "d.work_center_id AS \"workCenterId\",w.code AS \"workCenterCode\",d.reason,d.started_at AS \"startedAt\", " +
        "d.ended_at AS \"endedAt\",d.duration_seconds AS \"durationSeconds\",d.notes,u.display_name AS \"operatorName\" " +
        "FROM production_downtime d JOIN production_jobs j ON j.id=d.production_job_id " +
        "JOIN production_work_centers w ON w.id=d.work_center_id JOIN users u ON u.id=d.operator_id " +
        "ORDER BY d.started_at DESC LIMIT 200",
    ),
  ]);
  return { workCenters: workCenters.rows, shifts: shifts.rows, assignments: assignments.rows, downtime: downtime.rows };
}

export async function createWorkCenter(body: Record<string, unknown>, user: AuthenticatedUser) {
  const code = shortText(body.code, "code", 40).toUpperCase();
  const name = shortText(body.name, "name", 160);
  const location = optionalText(body.location, "location", 160);
  return inTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      "INSERT INTO production_work_centers(code,name,location,created_by) VALUES($1,$2,$3,$4) RETURNING id",
      [code, name, location, user.id],
    );
    await audit(client, user, "production.work_center.created", "production_work_center", result.rows[0].id, { code, name });
    return { id: result.rows[0].id };
  });
}

export async function createShift(body: Record<string, unknown>, user: AuthenticatedUser) {
  const code = shortText(body.code, "code", 40).toUpperCase();
  const name = shortText(body.name, "name", 120);
  const startsAt = parseTime(body.startsAt, "startsAt");
  const endsAt = parseTime(body.endsAt, "endsAt");
  if (startsAt === endsAt) throw new HttpError(400, "INVALID_SHIFT", "Shift start and end times must differ.");
  return inTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      "INSERT INTO production_shifts(code,name,starts_at,ends_at,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [code, name, startsAt, endsAt, user.id],
    );
    await audit(client, user, "production.shift.created", "production_shift", result.rows[0].id, { code, name });
    return { id: result.rows[0].id };
  });
}

export async function assignProductionJob(body: Record<string, unknown>, user: AuthenticatedUser) {
  const jobId = requireUuid(body.productionJobId, "productionJobId");
  const workCenterId = requireUuid(body.workCenterId, "workCenterId");
  const shiftId = requireUuid(body.shiftId, "shiftId");
  const operatorId = requireUuid(body.operatorId, "operatorId");
  return inTransaction(async (client) => {
    const job = await client.query<{ status: string }>("SELECT status FROM production_jobs WHERE id=$1 FOR UPDATE", [jobId]);
    if (!job.rowCount) throw new HttpError(404, "JOB_NOT_FOUND", "Production job not found.");
    if (job.rows[0].status === "completed") throw new HttpError(409, "JOB_CLOSED", "Completed production jobs cannot be assigned.");
    const resources = await client.query(
      "SELECT 1 FROM production_work_centers w JOIN production_shifts s ON s.id=$2 " +
        "JOIN users u ON u.id=$3 WHERE w.id=$1 AND w.is_active AND s.is_active AND u.is_active AND u.role IN ('admin','operator')",
      [workCenterId, shiftId, operatorId],
    );
    if (!resources.rowCount) throw new HttpError(404, "RESOURCE_NOT_FOUND", "Select an active work center, shift, and operator.");
    const conflict = await client.query(
      "SELECT 1 FROM production_job_assignments WHERE is_active AND shift_id=$1 AND production_job_id<>$2 " +
        "AND (operator_id=$3 OR work_center_id=$4) LIMIT 1",
      [shiftId, jobId, operatorId, workCenterId],
    );
    if (conflict.rowCount) throw new HttpError(409, "RESOURCE_CONFLICT", "The operator or work center is already assigned during this shift.");
    await client.query(
      "UPDATE production_job_assignments SET is_active=false,ended_at=now() WHERE production_job_id=$1 AND is_active",
      [jobId],
    );
    const assignment = await client.query<{ id: string }>(
      "INSERT INTO production_job_assignments(production_job_id,work_center_id,shift_id,operator_id,assigned_by) " +
        "VALUES($1,$2,$3,$4,$5) RETURNING id",
      [jobId, workCenterId, shiftId, operatorId, user.id],
    );
    await audit(client, user, "production.job.assigned", "production_job", jobId, {
      assignmentId: assignment.rows[0].id, workCenterId, shiftId, operatorId,
    });
    return { id: assignment.rows[0].id };
  });
}

export async function recordDowntime(body: Record<string, unknown>, user: AuthenticatedUser) {
  const jobId = requireUuid(body.productionJobId, "productionJobId");
  const workCenterId = requireUuid(body.workCenterId, "workCenterId");
  const reason = shortText(body.reason, "reason", 120);
  const startedAt = parseTimestamp(body.startedAt, "startedAt");
  const endedAt = parseTimestamp(body.endedAt, "endedAt");
  const notes = optionalText(body.notes, "notes", 2000);
  const key = shortText(body.idempotencyKey, "idempotencyKey", 128);
  if (new Date(endedAt).getTime() <= new Date(startedAt).getTime()) {
    throw new HttpError(400, "INVALID_INTERVAL", "Downtime end must be after its start.");
  }
  if (key.length < 8) throw new HttpError(400, "INVALID_KEY", "An idempotency key of at least 8 characters is required.");
  return inTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["production-downtime:" + key]);
    const job = await client.query<{ status: string; created_at: Date }>(
      "SELECT status,created_at FROM production_jobs WHERE id=$1 FOR UPDATE",
      [jobId],
    );
    if (!job.rowCount) throw new HttpError(404, "JOB_NOT_FOUND", "Production job not found.");
    const assignment = await client.query<{
      operator_id: string; assigned_at: Date; ended_at: Date | null;
      first_started_at: Date | null; database_now: Date;
    }>(
      "SELECT a.operator_id,a.assigned_at,a.ended_at," +
        "(SELECT min(e.created_at) FROM production_events e WHERE e.job_id=$1 AND e.kind IN ('start','resume')) AS first_started_at," +
        "now() AS database_now FROM production_job_assignments a " +
        "WHERE a.production_job_id=$1 AND a.work_center_id=$2 AND a.is_active FOR SHARE",
      [jobId, workCenterId],
    );
    if (!assignment.rowCount) throw new HttpError(409, "NOT_ASSIGNED", "Downtime requires an active assignment at that work center.");
    if (user.role === "viewer" && assignment.rows[0].operator_id !== user.id) {
      throw new HttpError(403, "FORBIDDEN", "Only the assigned operator can record downtime.");
    }
    const previous = await client.query<{ id: string; production_job_id: string; work_center_id: string; reason: string; started_at: string; ended_at: string; notes: string }>(
      "SELECT id,production_job_id,work_center_id,reason,started_at::text,ended_at::text,notes FROM production_downtime WHERE idempotency_key=$1",
      [key],
    );
    if (previous.rowCount) {
      const row = previous.rows[0];
      const same = row.production_job_id === jobId && row.work_center_id === workCenterId &&
        row.reason === reason && new Date(row.started_at).getTime() === new Date(startedAt).getTime() &&
        new Date(row.ended_at).getTime() === new Date(endedAt).getTime() && row.notes === notes;
      if (!same) throw new HttpError(409, "KEY_REUSED", "The idempotency key was already used for different downtime details.");
      return { id: row.id, replayed: true };
    }
    if (job.rows[0].status !== "in_progress" && job.rows[0].status !== "on_hold") {
      throw new HttpError(409, "JOB_NOT_ACTIVE", "Downtime can only be recorded while a job is in progress or on hold.");
    }

    const intervalStart = new Date(startedAt).getTime();
    const intervalEnd = new Date(endedAt).getTime();
    const jobCreatedAt = job.rows[0].created_at.getTime();
    const assignmentStartedAt = assignment.rows[0].assigned_at.getTime();
    const databaseNow = assignment.rows[0].database_now.getTime();
    if (intervalStart < jobCreatedAt) {
      throw new HttpError(409, "DOWNTIME_BEFORE_JOB", "Downtime cannot start before the production job was created.");
    }
    if (intervalStart < assignmentStartedAt) {
      throw new HttpError(409, "DOWNTIME_BEFORE_ASSIGNMENT", "Downtime cannot start before the work-center assignment began.");
    }
    if (!assignment.rows[0].first_started_at || intervalStart < assignment.rows[0].first_started_at.getTime()) {
      throw new HttpError(409, "DOWNTIME_BEFORE_START", "Downtime cannot start before the production job began.");
    }
    if (intervalEnd > databaseNow) {
      throw new HttpError(409, "FUTURE_DOWNTIME", "Downtime cannot extend into the future.");
    }
    const assignmentEndedAt = assignment.rows[0].ended_at?.getTime();
    if (assignmentEndedAt !== undefined && intervalEnd > assignmentEndedAt) {
      throw new HttpError(409, "DOWNTIME_AFTER_ASSIGNMENT", "Downtime cannot extend past the work-center assignment.");
    }
    const result = await client.query<{ id: string }>(
      "INSERT INTO production_downtime(production_job_id,work_center_id,reason,started_at,ended_at,notes,operator_id,idempotency_key) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [jobId, workCenterId, reason, startedAt, endedAt, notes, user.id, key],
    );
    await audit(client, user, "production.downtime.recorded", "production_downtime", result.rows[0].id, {
      jobId, workCenterId, reason, startedAt, endedAt,
    });
    return { id: result.rows[0].id, replayed: false };
  });
}
