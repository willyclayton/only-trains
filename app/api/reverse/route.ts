/**
 * OWNER: ui agent. STUB.
 * GET /api/reverse?lat=..&lon=..  → ReverseResponse (lib/types.ts)
 */
import type { ReverseResponse } from "@/lib/types";

export async function GET() {
  const body: ReverseResponse = { place: null };
  return Response.json(body);
}
