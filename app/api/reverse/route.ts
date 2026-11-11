/**
 * GET /api/reverse?lat=..&lon=..&lang=en  → ReverseResponse (lib/types.ts)
 *
 * Nearest sensible label for a map click: a station right there, else a street
 * address, a named place, the street, or the neighbourhood (Photon reverse,
 * Transitous reverse-geocode as fallback). `{ place: null }` when nothing fits.
 */
import type { NextRequest } from "next/server";
import type { ApiError, ReverseResponse } from "@/lib/types";
import { reverseGeocode } from "@/lib/geocode";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const lat = Number(sp.get("lat"));
  const lon = Number(sp.get("lon"));
  if (!sp.get("lat") || !sp.get("lon") || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    const err: ApiError = { error: "Invalid coordinates", detail: "Pass lat and lon in degrees." };
    return Response.json(err, { status: 400 });
  }
  const lang = sp.get("lang") || request.headers.get("accept-language")?.split(",")[0]?.trim() || "en";
  const place = await reverseGeocode(lat, lon, lang);
  const body: ReverseResponse = { place };
  return Response.json(body, {
    headers: {
      "Cache-Control": place
        ? "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"
        : "public, max-age=0, s-maxage=60",
    },
  });
}
