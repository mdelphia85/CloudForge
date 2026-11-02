import { NextResponse } from "next/server";
import { getPool } from "@/server/db";

export async function GET() {
  try {
    const result = await getPool().query(
      "SELECT 1 FROM schema_migrations WHERE name = '001_inventory_foundation.sql'",
    );
    if (result.rowCount !== 1) {
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
