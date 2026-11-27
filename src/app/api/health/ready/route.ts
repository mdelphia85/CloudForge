import { NextResponse } from "next/server";
import { getPool } from "@/server/db";

export async function GET() {
  try {
    const result = await getPool().query(
      "SELECT count(*)::int AS applied FROM schema_migrations " +
      "WHERE name IN ('001_inventory_foundation.sql','002_auth_login_attempts.sql','003_phase2_operations.sql'," +
      "'004_phase3_manufacturing_change_control.sql','005_phase3_review_corrections.sql'," +
      "'006_phase4_equipment_maintenance_telemetry.sql','007_phase5_account_controls.sql'," +
      "'008_phase5_equipment_alarms.sql')",
    );
    if (result.rows[0]?.applied !== 8) {
      return NextResponse.json(
        { status: "not_ready", service: "cloud-forge" },
        { status: 503 },
      );
    }
    return NextResponse.json({ status: "ready", service: "cloud-forge" });
  } catch (error) {
    console.error("Readiness check failed.", error);
    return NextResponse.json(
      { status: "not_ready", service: "cloud-forge" },
      { status: 503 },
    );
  }
}
