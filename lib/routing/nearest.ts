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
  importance?: number;
};

export type NearestStation = {
  place: Place;
  /** Straight-line distance, meters. */
  distance: number;
};

/** Half-height of each search box in degrees of latitude (~7, 22, 55, 130 and 280 km). */
const BOX_HALF_DEG = [0.06, 0.2, 0.5, 1.2, 2.5];

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
  return stopsInBounds(p.lat - halfDeg, p.lon - halfLon, p.lat + halfDeg, p.lon + halfLon, timeoutMs, 0);
}

/**
 * Stops inside a lat/lon box. Transitous refuses boxes holding too many stops
 * ({"error":"too many stops"}, e.g. a box around Boise reaching Portland and
 * Salt Lake City), so split those into quarters, up to 3 levels deep.
 */
async function stopsInBounds(
  minLat: number,
  minLon: number,
  maxLat: number,
  maxLon: number,
  timeoutMs: number,
  depth: number,
): Promise<MStop[]> {
  const min = `${minLat.toFixed(5)},${minLon.toFixed(5)}`;
  const max = `${maxLat.toFixed(5)},${maxLon.toFixed(5)}`;
  const url = `${TRANSITOUS_BASE}/api/v1/map/stops?min=${min}&max=${max}`;
  const got = await cached(`stops:${url}`, 10 * 60_000, async () => {
    const res = await fetchWithTimeout(url, {
      timeoutMs,
      provider: "Transitous",
      headers: { "User-Agent": userAgent(), Accept: "application/json" },
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (Array.isArray(json)) return json as MStop[];
    if (json && typeof json === "object" && /too many/i.test(String((json as { error?: unknown }).error))) return "split" as const;
    throw new Error(`Transitous stops ${res.status}`);
  });
  if (got !== "split") return got;
  if (depth >= 3) return [];
  const midLat = (minLat + maxLat) / 2;
  const midLon = (minLon + maxLon) / 2;
  const out: MStop[] = [];
  for (const [a, b, c, d] of [
    [minLat, minLon, midLat, midLon],
    [minLat, midLon, midLat, maxLon],
    [midLat, minLon, maxLat, midLon],
    [midLat, midLon, maxLat, maxLon],
  ]) {
    out.push(...(await stopsInBounds(a, b, c, d, timeoutMs, depth + 1)));
  }
  return out;
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
      if (half < 0.5 && picked.every((x) => x.urban)) {
        const main = (await stationsIn(0.5)).find((x) => !x.urban);
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

const MAINLINE = new Set(["LONG_DISTANCE", "HIGHSPEED_RAIL", "NIGHT_RAIL", "REGIONAL_RAIL", "REGIONAL_FAST_RAIL"]);

/**
 * Major mainline stations with real scheduled service (MOTIS importance > 0)
 * within up to ~550 km of `p`: relay points for reaching regions whose own
 * stations have no published timetable. Busiest first, then nearest. Never throws.
 */
export async function serviceHubs(
  p: LatLon,
  timeoutMs = 8000,
  max = 4,
  prefer: "near" | "busy" = "near",
  minHalf = 0,
): Promise<NearestStation[]> {
  try {
    for (const half of [1.2, 2.5, 5].filter((h) => h >= minHalf)) {
      const stops = await stopsInBox(p, half, timeoutMs);
      const byName = new Map<string, NearestStation & { imp: number }>();
      for (const s of stops) {
        if (!s.name || !(s.importance! > 0) || !(s.modes ?? []).some((m) => MAINLINE.has(m))) continue;
        const name = tidyStationName(s.name);
        const key = name.toLowerCase();
        const prev = byName.get(key);
        if (prev && prev.imp >= (s.importance ?? 0)) continue;
        byName.set(key, {
          imp: s.importance ?? 0,
          distance: Math.round(haversine(p, s)),
          place: { id: `stop:${s.stopId ?? `${s.lat},${s.lon}`}`, name, lat: s.lat, lon: s.lon, kind: "station" },
        });
      }
      const all = [...byName.values()];
      if (all.length >= 2 || half === 5) {
        // The nearest served stations (Elko, NV for Boise) plus the two busiest
        // hubs (Portland, Seattle), nearest first.
        if (prefer === "busy")
          return [...all]
            .sort((a, b) => b.imp - a.imp)
            .slice(0, max)
            .map(({ place, distance }) => ({ place, distance }));
        const nearest = [...all].sort((a, b) => a.distance - b.distance).slice(0, Math.max(1, max - 2));
        const busiest = [...all].sort((a, b) => b.imp - a.imp).slice(0, 2);
        return [...new Set([...nearest, ...busiest])]
          .sort((a, b) => a.distance - b.distance)
          .slice(0, max)
          .map(({ place, distance }) => ({ place, distance }));
      }
    }
  } catch {
    // fall through
  }
  return [];
}

/** IANA time zone at a point, from the nearest stops' timetable data. */
export async function timezoneAt(p: LatLon, timeoutMs = 4000): Promise<string | undefined> {
  for (const half of [0.05, 0.3, 1.2]) {
    const stops = await stopsInBox(p, half, timeoutMs).catch(() => [] as MStop[]);
    const tz = stops.find((s) => s.tz)?.tz;
    if (tz) return tz;
  }
  return undefined;
}
