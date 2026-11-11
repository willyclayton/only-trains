/**
 * GET /api/plan?from=lat,lon&to=lat,lon&modes=SUBWAY,COMMUTER,...&maxWalk=20&arriveBy=0|1[&time=ISO][&cursor=...][&lang=en]
 * → PlanResponse (200) | ApiError ({ error, detail }) with 400 / 502 / 503 / 504.
 *
 * Runtime: Node.js (the default; Edge is deprecated in Next 16 and gains nothing
 * here because the time is spent waiting on Transitous).
 *
 * Caching:
 *  - explicit `time` or a paging `cursor`: the answer is a deterministic timetable
 *    lookup, so let the CDN share it briefly — `s-maxage=30, stale-while-revalidate=120`.
 *    Short enough that realtime delays/cancellations still show up.
 *  - "now" (no time): the answer is relative to the moment of the request, and two
 *    users almost never send identical coordinates, so a CDN copy would only serve
 *    stale departures → `no-store`. lib/routing/http.ts still dedupes identical
 *    upstream calls for ~20 s per instance to protect the free Transitous API.
 *  - errors: `no-store`.
 */
import type { NextRequest } from "next/server";
import type { ApiError } from "@/lib/types";
import { parsePlanParams, plan, PlanError } from "@/lib/plan";

/** Seconds. Worst case is ~3 upstream calls with a 24 s overall budget; within Vercel Hobby limits. */
export const maxDuration = 30;

function languageFrom(req: NextRequest): string {
  const al = req.headers.get("accept-language") || "";
  const m = al.match(/^\s*([a-zA-Z]{2,3})\b/);
  return (m?.[1] || "en").toLowerCase();
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  try {
    const input = parsePlanParams(sp);
    if (!input.language) input.language = languageFrom(req);
    input.debug = sp.get("debug") === "1";
    const body = await plan(input);
    const cacheable = !!(input.options.time || input.cursor);
    return Response.json(body, {
      headers: {
        "Cache-Control": cacheable ? "public, max-age=0, s-maxage=30, stale-while-revalidate=120" : "private, no-store",
        Vary: "Accept-Language",
      },
    });
  } catch (e) {
    const err =
      e instanceof PlanError
        ? e
        : new PlanError(500, "Unexpected error while planning", e instanceof Error ? e.message : String(e));
    if (err.status >= 500) console.error("[api/plan]", err.status, err.message, err.detail ?? "");
    const body: ApiError = { error: err.message, ...(err.detail ? { detail: err.detail } : {}) };
    return Response.json(body, { status: err.status, headers: { "Cache-Control": "no-store" } });
  }
}
