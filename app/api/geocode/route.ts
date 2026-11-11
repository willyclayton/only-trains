/**
 * GET /api/geocode?q=text&lat=..&lon=..&lang=en  → GeocodeResponse (lib/types.ts)
 *
 * Merges rail stations (Transitous) with addresses / POIs / cities (Photon),
 * queried in parallel with timeouts. Provider failures degrade gracefully:
 * whatever arrived is returned (with an `X-Geocode-Degraded` header).
 */
import type { NextRequest } from "next/server";
import type { GeocodeResponse } from "@/lib/types";
import { geocode } from "@/lib/geocode";

function num(v: string | null): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  if (q.length === 0) {
    const empty: GeocodeResponse = { places: [] };
    return Response.json(empty, { headers: { "Cache-Control": "public, max-age=3600" } });
  }
  const lat = num(sp.get("lat"));
  const lon = num(sp.get("lon"));
  const bias =
    lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : {};
  const lang =
    sp.get("lang") || request.headers.get("accept-language")?.split(",")[0]?.trim() || "en";

  const { places, failed } = await geocode(q, { ...bias, lang });
  const body: GeocodeResponse = { places };
  const degraded = failed.length > 0;
  return Response.json(body, {
    headers: {
      // Results barely change; let the CDN absorb repeated keystrokes. Degraded answers are cached briefly.
      "Cache-Control": degraded
        ? "public, max-age=0, s-maxage=30"
        : "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
      ...(degraded ? { "X-Geocode-Degraded": failed.join(",") } : {}),
    },
  });
}
