import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "cloud-forge",
    deployment: process.env.DEPLOYMENT_MODE ?? "local",
    timestamp: new Date().toISOString(),
  });
}
