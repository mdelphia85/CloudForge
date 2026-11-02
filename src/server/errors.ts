import "server-only";
import { NextResponse } from "next/server";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof HttpError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }

  console.error("Unhandled API error.", error);
  return NextResponse.json(
    { error: "The request could not be completed.", code: "INTERNAL_ERROR" },
    { status: 500 },
  );
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HttpError(403, "INVALID_ORIGIN", "Request origin was rejected.");
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 65_536) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Request body exceeds the 64 KB limit.");
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    throw new HttpError(400, "INVALID_BODY", "Unable to read request body.");
  }
  if (Buffer.byteLength(body, "utf8") > 65_536) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Request body exceeds the 64 KB limit.");
  }

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}
