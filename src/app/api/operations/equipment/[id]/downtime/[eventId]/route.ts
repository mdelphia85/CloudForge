import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { closeEquipmentDowntime } from "@/server/phase4/downtime";
import { requireUuid } from "@/server/phase4/shared";

type Context = { params: Promise<{ id: string; eventId: string }> };

async function handlePATCH(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id, eventId } = await params;
    return NextResponse.json(await closeEquipmentDowntime(
      requireUuid(id, "equipmentId"),
      requireUuid(eventId, "downtimeId"),
      await readJson(request),
      user,
    ));
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}

export const PATCH = withOrganizationRoute(handlePATCH);
