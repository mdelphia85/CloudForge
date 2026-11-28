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
    // A shared SaaS instance must never run tenant RLS as PostgreSQL superuser
    // or a role with BYPASSRLS, even if FORCE RLS was applied to all tables.
    if (process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED === "true") {
      const db = await getPool().query<{ superuser: boolean; bypass: boolean }>(
        "SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user",
      );
      const role = db.rows[0];
      const migrations = await getPool().query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM schema_migrations WHERE name IN " +
          "('012_organization_foundation.sql','014_session_organization_binding.sql'," +
          "'015_cross_organization_references.sql','016_tenant_row_security.sql')",
      );
      if (!role || role.superuser || role.bypass || migrations.rows[0]?.count !== 4) {
        return NextResponse.json({ status: "not_ready", service: "cloud-forge" }, { status: 503 });
      }
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
