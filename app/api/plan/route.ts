/**
 * OWNER: routing agent. STUB.
 * GET /api/plan?from=lat,lon&to=lat,lon&time=ISO&arriveBy=0|1&modes=SUBWAY,COMMUTER&maxWalk=20&cursor=...
 * → PlanResponse | ApiError (lib/types.ts)
 */
import type { PlanResponse } from "@/lib/types";

export async function GET() {
  const body: PlanResponse = { journeys: [], providers: [], attribution: [], warnings: ["Routing not implemented yet"] };
  return Response.json(body);
}
