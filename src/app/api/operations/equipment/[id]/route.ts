import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { getEquipment, retireEquipment, updateEquipment } from "@/server/phase4/equipment";
import { requireUuid } from "@/server/phase4/shared";

type Context = { params: Promise<{ id: string }> };

async function handleGET(request: Request, { params }: Context) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    return NextResponse.json(await getEquipment(requireUuid(id, "equipmentId"), user), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handlePATCH(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    return NextResponse.json(await updateEquipment(requireUuid(id, "equipmentId"), await readJson(request), user));
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}

async function handleDELETE(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    return NextResponse.json(await retireEquipment(requireUuid(id, "equipmentId"), user));
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}

export const GET = withOrganizationRoute(handleGET);
export const PATCH = withOrganizationRoute(handlePATCH);
export const DELETE = withOrganizationRoute(handleDELETE);
