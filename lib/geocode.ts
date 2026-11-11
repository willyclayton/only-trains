/**
 * Server-side geocoding for Only Trains.
 *
 * Two free, OSM-based providers, queried in parallel:
 *
 * - Transitous (MOTIS) `/api/v1/geocode` with `type=STOP` and a rail-only `mode`
 *   filter. It knows every stop in the routing graph, so "Clark/Lake" or
 *   "Gare de Lyon" resolve to the exact station the router will use.
 *   https://api.transitous.org/api/v1/geocode — usage: free/open-source and
 *   non-commercial projects only (https://transitous.org/api/).
 *
 * - Photon (komoot) `/api` for addresses, POIs, neighbourhoods and cities, and
 *   `/reverse` for map clicks. Public instance is fair-use only ("extensive
 *   usage will be throttled or completely banned"); production deployments
 *   with real traffic should self-host Photon or set PHOTON_URL.
 *   https://photon.komoot.io, https://github.com/komoot/photon
 *
 * Nominatim (nominatim.openstreetmap.org) is deliberately NOT used: its usage
 * policy forbids autocomplete/search-as-you-type and caps the whole app at
 * 1 req/s, which a serverless deployment cannot enforce.
 */
import type { Place, RailMode } from "./types";
import { haversine } from "./format";

// ---------- config ----------

const PHOTON_URL = (process.env.PHOTON_URL || "https://photon.komoot.io").replace(/\/+$/, "");
const TRANSITOUS_URL = (process.env.TRANSITOUS_URL || "https://api.transitous.org").replace(/\/+$/, "");

const CONTACT = process.env.ONLY_TRAINS_CONTACT?.trim();
export const USER_AGENT = `OnlyTrains/0.1 (+${CONTACT || "https://github.com/willyclayton/only-trains"})`;

const TIMEOUT_MS = 3000;
const MAX_RESULTS = 8;

/** MOTIS modes that are rail. `RAIL` expands to HIGHSPEED/LONG_DISTANCE/NIGHT/REGIONAL/SUBURBAN/SUBWAY. */
const TRANSITOUS_RAIL_MODES = "RAIL,SUBWAY,TRAM,FUNICULAR";

/** A Place plus optional extras the search UI can show (ignored by everyone else). */
export type GeoPlace = Place & {
  /** Rail modes served, for stations (normalized). */
  modes?: RailMode[];
  /** IANA timezone, when the provider knows it. */
  tz?: string;
};

// ---------- small utils ----------

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

async function fetchJson<T>(url: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return (await res.json()) as T;
}

/** Tiny in-memory TTL cache, per warm server instance. */
const memo = new Map<string, { at: number; value: unknown }>();
const MEMO_TTL = 10 * 60 * 1000;
const MEMO_MAX = 500;
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL) return hit.value as T;
  const value = await fn();
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
  memo.set(key, { at: Date.now(), value });
  return value;
}

function joinUnique(parts: (string | undefined | null)[], exclude: string[] = []): string | undefined {
  const seen = new Set(exclude.map(normalizeText));
  const out: string[] = [];
  for (const p of parts) {
    const v = p?.trim();
    if (!v) continue;
    const k = normalizeText(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.length ? out.join(", ") : undefined;
}

/** Photon supports default/en/de/fr; MOTIS takes any OSM language tag. */
function photonLang(lang: string): string {
  if (["en", "de", "fr"].includes(lang)) return lang;
  if (["ja", "zh", "ko"].includes(lang)) return "default";
  return "en";
}

/** "41.88, -87.63" → coordinate place. */
export function parseCoordinates(q: string): GeoPlace | null {
  const m = q.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    id: `coord:${lat.toFixed(6)},${lon.toFixed(6)}`,
    name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    detail: "Coordinates",
    lat,
    lon,
    kind: "coordinate",
  };
}

// ---------- Transitous (stations) ----------

type MotisArea = { name: string; adminLevel: number; matched?: boolean; unique?: boolean; default?: boolean };
type MotisMatch = {
  type: "ADDRESS" | "PLACE" | "STOP";
  name: string;
  id: string;
  lat: number;
  lon: number;
  tz?: string;
  country?: string;
  areas?: MotisArea[];
  score?: number;
  modes?: string[];
  importance?: number;
  street?: string;
  houseNumber?: string;
};

function motisModesToRail(modes: string[] | undefined): RailMode[] {
  const out = new Set<RailMode>();
  for (const m of modes ?? []) {
    if (m === "SUBWAY" || m === "METRO") out.add("SUBWAY");
    else if (m === "SUBURBAN" || m === "REGIONAL_RAIL" || m === "REGIONAL_FAST_RAIL") out.add("COMMUTER");
    else if (m === "HIGHSPEED_RAIL" || m === "LONG_DISTANCE" || m === "NIGHT_RAIL" || m === "RAIL") out.add("INTERCITY");
    else if (m === "TRAM") out.add("LIGHT_RAIL");
    else if (m === "FUNICULAR" || m === "CABLE_CAR") out.add("OTHER_RAIL");
  }
  const order: RailMode[] = ["SUBWAY", "COMMUTER", "INTERCITY", "LIGHT_RAIL", "OTHER_RAIL"];
  return order.filter((m) => out.has(m));
}

function motisDetail(m: MotisMatch, name: string): string | undefined {
  const areas = [...(m.areas ?? [])].sort((a, b) => b.adminLevel - a.adminLevel);
  const def = areas.find((a) => a.default) ?? areas.find((a) => a.adminLevel <= 8 && a.adminLevel >= 6);
  const state = areas.find((a) => a.adminLevel === 4);
  const country = areas.find((a) => a.adminLevel === 2);
  const cityish = def && /\btownship\b/i.test(def.name) ? undefined : def?.name;
  return joinUnique([cityish, state?.name, country?.name], [name]);
}

export async function searchStations(
  q: string,
  opts: { lat?: number; lon?: number; lang: string; limit?: number },
): Promise<(GeoPlace & { _rank: number; _importance: number })[]> {
  const sp = new URLSearchParams({
    text: q,
    type: "STOP",
    mode: TRANSITOUS_RAIL_MODES,
    numResults: String(opts.limit ?? 8),
    language: opts.lang,
  });
  if (opts.lat != null && opts.lon != null) {
    sp.set("place", `${opts.lat},${opts.lon}`);
    sp.set("placeBias", "4");
  }
  const url = `${TRANSITOUS_URL}/api/v1/geocode?${sp}`;
  const matches = await cached(url, () => fetchJson<MotisMatch[]>(url));
  if (!Array.isArray(matches)) return [];
  return matches
    .filter((m) => m.type === "STOP" && Number.isFinite(m.lat) && Number.isFinite(m.lon))
    .map((m, i) => {
      const modes = motisModesToRail(m.modes);
      return {
        id: `stop:${m.id}`,
        name: m.name,
        detail: motisDetail(m, m.name),
        lat: m.lat,
        lon: m.lon,
        kind: "station" as const,
        modes,
        tz: m.tz,
        _rank: i,
        _importance: m.importance ?? 0,
      };
    })
    .filter((p) => p.modes.length > 0);
}

// ---------- Photon (addresses, POIs, cities) ----------

type PhotonProps = {
  osm_type?: string;
  osm_id?: number;
  osm_key?: string;
  osm_value?: string;
  type?: string; // house | street | locality | district | city | county | state | country | other
  name?: string;
  housenumber?: string;
  street?: string;
  locality?: string;
  district?: string;
  city?: string;
  county?: string;
  state?: string;
  country?: string;
  countrycode?: string;
  postcode?: string;
};
type PhotonFeature = { properties: PhotonProps; geometry: { type: string; coordinates: [number, number] } };
type PhotonResponse = { features?: PhotonFeature[] };

/** Things we never offer as search results (buses, platform nodes, entrances...). */
function isNoise(p: PhotonProps): boolean {
  const k = p.osm_key ?? "";
  const v = p.osm_value ?? "";
  if (k === "public_transport") return true;
  if (k === "highway" && (v === "bus_stop" || v === "platform" || v === "elevator")) return true;
  if (k === "amenity" && (v === "bus_station" || v === "ferry_terminal" || v === "taxi")) return true;
  if (k === "railway" && !["station", "halt", "tram_stop"].includes(v)) return true;
  if (k === "building" && !p.name && !p.housenumber) return true;
  return false;
}

function photonKind(p: PhotonProps): Place["kind"] {
  const k = p.osm_key ?? "";
  const v = p.osm_value ?? "";
  if (k === "railway" && ["station", "halt", "tram_stop"].includes(v)) return "station";
  if (k === "building" && v === "train_station") return "station";
  if (k === "place" && ["city", "town", "village", "hamlet", "municipality"].includes(v)) return "city";
  if (p.type === "city" || p.type === "county" || p.type === "state" || p.type === "country") return "city";
  if (p.type === "locality" || p.type === "district") return "city";
  if (p.name && p.type !== "street") return "poi";
  if (p.housenumber || p.type === "house" || p.type === "street") return "address";
  return "other";
}

function cleanCity(city: string | undefined): string | undefined {
  // OSM civil townships (US) often shadow the real city in Photon's hierarchy.
  if (!city || /\btownship\b/i.test(city)) return undefined;
  return city;
}

function photonToPlace(f: PhotonFeature): GeoPlace | null {
  const p = f.properties ?? {};
  const [lon, lat] = f.geometry?.coordinates ?? [];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const street = p.street ? (p.housenumber ? `${p.housenumber} ${p.street}` : p.street) : undefined;
  const name = p.name || street || p.locality || p.district || p.city;
  if (!name) return null;
  const kind = photonKind(p);
  const city = cleanCity(p.city);
  let detail: string | undefined;
  if (kind === "city") {
    detail = joinUnique([p.type === "locality" || p.type === "district" ? city ?? p.county : undefined, p.state, p.country], [name]);
  } else if (kind === "station") {
    detail = joinUnique([p.locality || p.district, city ?? p.county, p.state, p.country], [name])
      ?.split(", ")
      .slice(0, 3)
      .join(", ");
  } else {
    const hood = p.locality || p.district;
    const where = city ?? p.county;
    // POIs: lead with the street address when we have one; addresses: neighbourhood.
    detail = joinUnique([p.name ? street : undefined, hood, where, p.state, p.country], [name]);
    // Keep it readable: at most four parts.
    if (detail) detail = detail.split(", ").slice(0, 4).join(", ");
  }
  return {
    id: `osm:${p.osm_type ?? "X"}${p.osm_id ?? `${lat.toFixed(5)},${lon.toFixed(5)}`}`,
    name,
    detail,
    lat,
    lon,
    kind,
  };
}

export async function searchPhoton(
  q: string,
  opts: { lat?: number; lon?: number; lang: string; limit?: number },
): Promise<(GeoPlace & { _rank: number })[]> {
  const sp = new URLSearchParams({ q, limit: String(opts.limit ?? 10), lang: photonLang(opts.lang) });
  if (opts.lat != null && opts.lon != null) {
    sp.set("lat", String(opts.lat));
    sp.set("lon", String(opts.lon));
    sp.set("zoom", "10");
    sp.set("location_bias_scale", "0.3");
  }
  const url = `${PHOTON_URL}/api?${sp}`;
  const json = await cached(url, () => fetchJson<PhotonResponse>(url));
  const out: (GeoPlace & { _rank: number })[] = [];
  (json.features ?? []).forEach((f, i) => {
    if (isNoise(f.properties ?? {})) return;
    const place = photonToPlace(f);
    if (place) out.push({ ...place, _rank: i });
  });
  return out;
}

// ---------- merge + rank ----------

function textScore(name: string, q: string): number {
  const n = normalizeText(name);
  const t = normalizeText(q);
  if (!t) return 0;
  if (n === t) return 100;
  if (n.startsWith(t)) return 75;
  if (n.split(" ").some((w) => w.startsWith(t))) return 60;
  if (n.includes(t)) return 50;
  // Every query word appears as a prefix of some name word ("lake clark" → "Clark/Lake").
  const words = t.split(" ");
  const nameWords = n.split(" ");
  if (words.every((w) => nameWords.some((nw) => nw.startsWith(w)))) return 55;
  return 25; // fuzzy / matched on address or area
}

function distanceScore(p: { lat: number; lon: number }, near?: { lat: number; lon: number } | null): number {
  if (!near) return 0;
  const km = haversine(p, near) / 1000;
  if (km < 3) return 22;
  if (km < 15) return 18;
  if (km < 50) return 12;
  if (km < 200) return 6;
  if (km < 1000) return 2;
  return 0;
}

type Candidate = GeoPlace & { _score: number };

/** Word-boundary containment: "damen" ⊂ "damen blue", "gare de lyon" ⊂ "paris gare de lyon". */
function nameContains(a: string, b: string): boolean {
  const x = ` ${normalizeText(a)} `;
  const y = ` ${normalizeText(b)} `;
  return x.includes(y) || y.includes(x);
}

function isSamePlace(a: GeoPlace, b: GeoPlace): boolean {
  const d = haversine(a, b);
  const na = normalizeText(a.name);
  const nb = normalizeText(b.name);
  if (a.kind === "station" && b.kind === "station") return d < 400 && nameContains(a.name, b.name);
  if (a.kind === "station" || b.kind === "station") return d < 250 && na === nb;
  if (na !== nb) return false;
  if (a.kind === "city" && b.kind === "city") return d < 30000 && (a.detail ?? "") === (b.detail ?? "");
  return d < 150 && a.kind === b.kind;
}

export async function geocode(
  q: string,
  opts: { lat?: number; lon?: number; lang?: string } = {},
): Promise<{ places: GeoPlace[]; failed: string[] }> {
  const query = q.trim().slice(0, 200);
  if (!query) return { places: [], failed: [] };

  const coord = parseCoordinates(query);
  if (coord) return { places: [coord], failed: [] };

  const lang = (opts.lang || "en").toLowerCase().split(/[-_]/)[0] || "en";
  const near = opts.lat != null && opts.lon != null ? { lat: opts.lat, lon: opts.lon } : null;
  const looksLikeAddress = /^\d+[a-z]?\b/i.test(query) || /\b\d{4,5}\b/.test(query);

  const [stationsR, photonR] = await Promise.allSettled([
    searchStations(query, { ...opts, lang, limit: 8 }),
    searchPhoton(query, { ...opts, lang, limit: 10 }),
  ]);
  const failed: string[] = [];
  if (stationsR.status === "rejected") {
    failed.push("transitous");
    console.warn("[geocode] transitous failed:", (stationsR.reason as Error)?.message);
  }
  if (photonR.status === "rejected") {
    failed.push("photon");
    console.warn("[geocode] photon failed:", (photonR.reason as Error)?.message);
  }
  const stations = stationsR.status === "fulfilled" ? stationsR.value : [];
  const others = photonR.status === "fulfilled" ? photonR.value : [];

  const candidates: Candidate[] = [];

  for (const s of stations) {
    const { _rank, _importance, ...place } = s;
    const score =
      textScore(s.name, query) +
      16 + // it's a train app: stations are what people usually want
      Math.min(12, Math.sqrt(_importance) * 45) +
      distanceScore(s, near) -
      _rank * 2 -
      (looksLikeAddress ? 30 : 0);
    candidates.push({ ...place, _score: score });
  }

  for (const o of others) {
    const { _rank, ...place } = o;
    let score = textScore(o.name, query) + distanceScore(o, near) - _rank * 3;
    if (o.kind === "city") score += textScore(o.name, query) >= 75 ? 14 : 4;
    if (o.kind === "address" && looksLikeAddress) score += 30;
    if (o.kind === "station") score += 6;
    candidates.push({ ...place, _score: score });
  }

  candidates.sort((a, b) => b._score - a._score);

  // Dedupe: same normalized name close together (Transitous "Shibuya" vs "SHIBUYA",
  // or a Photon railway=station duplicating a Transitous stop). Keep the best,
  // prefer Transitous stops (their coordinates are what the router snaps to).
  const kept: Candidate[] = [];
  for (const c of candidates) {
    const dupIdx = kept.findIndex((k) => isSamePlace(k, c));
    if (dupIdx === -1) {
      kept.push(c);
      continue;
    }
    const k = kept[dupIdx];
    const modes = Array.from(new Set([...(k.modes ?? []), ...(c.modes ?? [])])) as RailMode[];
    if (c.id.startsWith("stop:") && !k.id.startsWith("stop:")) {
      // A Transitous stop beats an OSM station node: it is what the router knows.
      kept[dupIdx] = { ...c, modes, _score: k._score };
    } else if (modes.length) {
      kept[dupIdx] = { ...k, modes };
    }
  }

  const places = kept.slice(0, MAX_RESULTS).map(({ _score, ...p }) => p); // eslint-disable-line @typescript-eslint/no-unused-vars
  return { places, failed };
}

// ---------- reverse ----------

/**
 * Nearest sensible label for a clicked point:
 * a station right there > a street address > a named place > the street > the neighbourhood.
 */
export async function reverseGeocode(lat: number, lon: number, lang = "en"): Promise<GeoPlace | null> {
  const l = lang.toLowerCase().split(/[-_]/)[0] || "en";
  const sp = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    limit: "8",
    radius: "0.4",
    lang: photonLang(l),
  });
  const url = `${PHOTON_URL}/reverse?${sp}`;
  let features: PhotonFeature[] = [];
  try {
    const json = await cached(url, () => fetchJson<PhotonResponse>(url, 3500));
    features = json.features ?? [];
  } catch {
    features = [];
  }

  const here = { lat, lon };
  type Scored = { f: PhotonFeature; d: number };
  const scored: Scored[] = features
    .filter((f) => !isNoise(f.properties ?? {}))
    .map((f) => ({ f, d: haversine(here, { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }) }));

  const pick = (pred: (p: PhotonProps) => boolean, maxD: number) =>
    scored.filter((s) => pred(s.f.properties) && s.d <= maxD).sort((a, b) => a.d - b.d)[0];

  const station = pick((p) => photonKind(p) === "station", 120);
  const address = pick((p) => !!p.housenumber && !!p.street, 60);
  const named = pick((p) => !!p.name && p.type !== "street" && photonKind(p) === "poi", 35);
  const streetF = pick((p) => p.type === "street" || !!p.street, 250);

  const best = station ?? address ?? named;
  if (best) {
    const p = best.f.properties;
    if (best === address && !station) {
      // Present addresses as the address itself, even if Photon attached a shop name to it.
      const name = `${p.housenumber} ${p.street}`;
      return {
        id: `rev:${lat.toFixed(6)},${lon.toFixed(6)}`,
        name,
        detail: joinUnique([p.locality || p.district, cleanCity(p.city) ?? p.county, p.state, p.country], [name])
          ?.split(", ")
          .slice(0, 3)
          .join(", "),
        lat,
        lon,
        kind: "address",
      };
    }
    const place = photonToPlace(best.f);
    if (place) return { ...place, id: `rev:${lat.toFixed(6)},${lon.toFixed(6)}`, lat, lon };
  }
  if (streetF) {
    const p = streetF.f.properties;
    const name = p.type === "street" ? p.name || p.street : p.street;
    if (name) {
      return {
        id: `rev:${lat.toFixed(6)},${lon.toFixed(6)}`,
        name,
        detail: joinUnique([p.locality || p.district, cleanCity(p.city) ?? p.county, p.state, p.country], [name])
          ?.split(", ")
          .slice(0, 3)
          .join(", "),
        lat,
        lon,
        kind: "address",
      };
    }
  }
  const area = scored.sort((a, b) => a.d - b.d)[0]?.f.properties;
  if (area) {
    const name = area.locality || area.district || cleanCity(area.city) || area.county || area.state;
    if (name) {
      return {
        id: `rev:${lat.toFixed(6)},${lon.toFixed(6)}`,
        name,
        detail: joinUnique([cleanCity(area.city), area.state, area.country], [name]),
        lat,
        lon,
        kind: "other",
      };
    }
  }

  // Fallback: Transitous reverse-geocode (OSM-based too), e.g. when Photon is down.
  try {
    const tsp = new URLSearchParams({ place: `${lat},${lon}`, numResults: "5" });
    const turl = `${TRANSITOUS_URL}/api/v1/reverse-geocode?${tsp}`;
    const matches = await cached(turl, () => fetchJson<MotisMatch[]>(turl, 3000));
    const m =
      (Array.isArray(matches) ? matches : []).find(
        (x) => x.type === "STOP" && motisModesToRail(x.modes).length > 0 && haversine(here, x) < 120,
      ) ??
      (Array.isArray(matches) ? matches : []).find((x) => x.type === "ADDRESS" && haversine(here, x) < 80) ??
      (Array.isArray(matches) ? matches : []).find((x) => haversine(here, x) < 40);
    if (m) {
      return {
        id: `rev:${lat.toFixed(6)},${lon.toFixed(6)}`,
        name: m.name,
        detail: motisDetail(m, m.name),
        lat,
        lon,
        kind: m.type === "STOP" ? "station" : m.type === "ADDRESS" ? "address" : "poi",
      };
    }
  } catch {
    // both providers down: caller falls back to raw coordinates
  }
  return null;
}
