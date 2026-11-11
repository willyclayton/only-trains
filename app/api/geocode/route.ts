/**
 * OWNER: ui agent. STUB.
 * GET /api/geocode?q=text&lat=..&lon=..  → GeocodeResponse (lib/types.ts)
 */
import type { GeocodeResponse } from "@/lib/types";

export async function GET() {
  const body: GeocodeResponse = { places: [] };
  return Response.json(body);
}
