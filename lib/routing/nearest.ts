/**
 * Nearest rail station lookup, used to explain "no route" results.
 *
 * Transitous (MOTIS) has no nearest-stop endpoint with a mode filter, but
 * GET /api/v1/map/stops?min=lat,lon&max=lat,lon returns every stop in a box
 * with its served modes. We search a few growing boxes and stop at the first
 * one that contains a station served by an enabled train type.
 */
import type { LatLon, Place, RailMode } from "../types";
import { haversine } from "../format";
import { MOTIS_MODES_FOR } from "./rail";
import { TRANSITOUS_BASE } from "../providers/transitous";
import { cached, fetchWithTimeout, userAgent } from "./http";

type MStop = {
  name?: string;
  stopId?: string;
  lat: number;
  lon: number;
  tz?: string;
  modes?: string[];
};

export type NearestStation = {
  place: Place;
  /** Straight-line distance, meters. */
  distance: number;
};

/** Half-height of each search box in degrees of latitude (~7 km, ~22 km, ~55 km). */
const BOX_HALF_DEG = [0.06, 0.2, 0.5];

/** Rough walking time for a straight-line distance: 80 m/min with a 1.3 detour factor. */
export function walkMinutesFor(straightMeters: number): number {
  return Math.round((straightMeters * 1.3) / 80);
}

function allowedMotisModes(modes: RailMode[]): Set<string> {
  const s = new Set<string>();
  for (const m of modes) for (const x of MOTIS_MODES_FOR[m]) s.add(x);
  // MOTIS "OTHER" also covers elevators and lifts; it is not a station signal.
  s.delete("OTHER");
  return s;
}

async function stopsInBox(p: LatLon, halfDeg: number, timeoutMs: number): Promise<MStop[]> {
  const halfLon = Math.min(180, halfDeg / Math.max(0.2, Math.cos((p.lat * Math.PI) / 180)));
  const min = `${(p.lat - halfDeg).toFixed(5)},${(p.lon - halfLon).toFixed(5)}`;
  const max = `${(p.lat + halfDeg).toFixed(5)},${(p.lon + halfLon).toFixed(5)}`;
  const url = `${TRANSITOUS_BASE}/api/v1/map/stops?min=${min}&max=${max}`;
  return cached(`stops:${url}`, 10 * 60_000, async () => {
    const res = await fetchWithTimeout(url, {
      timeoutMs,
      provider: "Transitous",
      headers: { "User-Agent": userAgent(), Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Transitous stops ${res.status}`);
    const json = (await res.json()) as unknown;
    return Array.isArray(json) ? (json as MStop[]) : [];
  });
}

/** Urban modes; everything else counts as mainline rail. */
const URBAN = new Set(["SUBWAY", "TRAM", "FUNICULAR"]);

/**
 * Up to `max` distinct stations near `p` served by one of `modes`, nearest
 * first, always including the nearest mainline and nearest urban station when
 * there is one (they are often on networks that do not connect to each other).
 * [] when there is none within ~55 km; undefined when the lookup failed.
 * Never throws.
 */
export async function nearbyRailStations(
  p: LatLon,
  modes: RailMode[],
  max = 4,
  timeoutMs = 6000,
): Promise<NearestStation[] | undefined> {
  const allowed = allowedMotisModes(modes);
  if (!allowed.size) return [];
  const stationsIn = async (half: number) => {
    const stops = await stopsInBox(p, half, timeoutMs);
    const byName = new Map<string, NearestStation & { urban: boolean }>();
    for (const s of stops) {
      if (!s.name || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
      const served = (s.modes ?? []).filter((m) => allowed.has(m));
      if (!served.length) continue;
      const d = Math.round(haversine(p, s));
      const name = tidyStationName(s.name);
      const key = name.toLowerCase();
      const prev = byName.get(key);
      if (prev && prev.distance <= d) continue;
      byName.set(key, {
        distance: d,
        urban: served.every((m) => URBAN.has(m)),
        place: { id: `stop:${s.stopId ?? `${s.lat},${s.lon}`}`, name, lat: s.lat, lon: s.lon, kind: "station" },
      });
    }
    return [...byName.values()].sort((a, b) => a.distance - b.distance);
  };
  try {
    for (const half of BOX_HALF_DEG) {
      const all = await stationsIn(half);
      const largest = BOX_HALF_DEG[BOX_HALF_DEG.length - 1];
      const isLast = half === largest;
      // Only trust a nearest hit inside this box's inscribed circle; a corner
      // hit could hide a nearer station just outside the box edge.
      if (!all.length || (!isLast && all[0].distance > half * 111_000)) continue;
      const picked = all.slice(0, Math.max(1, max - 1));
      for (const urban of [false, true]) {
        const extra = all.find((x) => x.urban === urban);
        if (extra && !picked.includes(extra)) picked.push(extra);
      }
      // Urban networks often don't connect to intercity trains in the data
      // (MARTA vs Amtrak in Atlanta): make sure a mainline station is a
      // candidate, looking in the widest box if this one has none.
      if (!isLast && picked.every((x) => x.urban)) {
        const main = (await stationsIn(largest)).find((x) => !x.urban);
        if (main) picked.push(main);
      }
      // Keep the mainline candidate even when it is the farthest of the set.
      const sorted = picked.sort((a, b) => a.distance - b.distance);
      const top = sorted.slice(0, max);
      const mainline = sorted.find((x) => !x.urban);
      if (mainline && !top.includes(mainline)) top[top.length - 1] = mainline;
      return top.map(({ place, distance }) => ({ place, distance }));
    }
  } catch {
    return undefined;
  }
  return [];
}

/** "DORAVILLE STATION" → "Doraville Station"; leaves mixed-case names alone. */
function tidyStationName(name: string): string {
  const n = name.trim();
  if (n !== n.toUpperCase() || !/[A-Z]/.test(n)) return n;
  return n.toLowerCase().replace(/(^|[\s\-/(])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}
