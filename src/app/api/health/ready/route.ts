import { NextResponse } from "next/server";
import { getPool } from "@/server/db";
import { engineeringScannerReady } from "@/server/engineering-file-security";

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
    // The irreversible commercial activation is a separate, audited database
    // operation. The app and database activation gates MUST agree.
    const activated = await getPool().query<{exists:boolean}>(
      "SELECT to_regclass('public.platform_commercial_activations') IS NOT NULL AS exists",
    );
    const multiEnabled=process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED==="true";
    const activationRecorded=activated.rows[0]?.exists
      ? (await getPool().query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM platform_commercial_activations",
        )).rows[0]?.count===1
      : false;
    if (multiEnabled !== activationRecorded) {
      return NextResponse.json({status:"not_ready",service:"cloud-forge"},{status:503});
    }
    if (multiEnabled) {
      if (!await engineeringScannerReady()) {
        return NextResponse.json({status:"not_ready",service:"cloud-forge"},{status:503});
      }
      if (process.env.CLOUDFORGE_LICENSE_ENFORCEMENT_REQUIRED!=="true" ||
          process.env.CLOUDFORGE_MFA_REQUIRED!=="true" ||
          !/^[0-9a-fA-F]{64}$/.test(process.env.CLOUDFORGE_MFA_ENCRYPTION_KEY ?? "")) {
        return NextResponse.json({status:"not_ready",service:"cloud-forge"},{status:503});
      }
      const db = await getPool().query<{superuser:boolean;bypass:boolean}>(
        "SELECT rolsuper AS superuser,rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user",
      );
      const role=db.rows[0];
      const migrations=await getPool().query<{count:number}>(
        "SELECT COUNT(*)::int AS count FROM schema_migrations WHERE name IN " +
          "('012_organization_foundation.sql','013_engineering_direct_uploads.sql'," +
          "'014_session_organization_binding.sql','015_cross_organization_references.sql'," +
          "'016_tenant_row_security.sql','017_organization_business_keys.sql'," +
          "'018_explicit_memberships_and_invitations.sql','019_inventory_auto_reorder.sql','020_totp_mfa_recovery.sql','021_mfa_device_recovery.sql')",
      );
      const singleton=await getPool().query<{exists:boolean}>(
        "SELECT to_regclass('public.organizations_single_installation_only') IS NOT NULL AS exists",
      );
      const staleDefaults=await getPool().query<{count:number}>(
        `SELECT COUNT(*)::int AS count FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
         JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id'
         LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
         WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity
           AND (d.oid IS NULL OR pg_get_expr(d.adbin,d.adrelid) NOT LIKE '%cloudforge_current_org%')`,
      );
      if (!role || role.superuser || role.bypass ||
          migrations.rows[0]?.count!==10 || singleton.rows[0]?.exists ||
          staleDefaults.rows[0]?.count!==0) {
        return NextResponse.json({status:"not_ready",service:"cloud-forge"},{status:503});
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
