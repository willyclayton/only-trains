/**
 * Transitous (https://transitous.org) — free, community-run MOTIS 2 instance.
 *
 * API: GET https://api.transitous.org/api/v6/plan (MOTIS v2.11.x, OpenAPI:
 * https://github.com/motis-project/motis/blob/master/openapi.yaml).
 * v6 is the newest plan version: precision-6 polylines (v2+), correct
 * maxTransfers semantics (v3+), displayName (v4+), SUBURBAN instead of METRO
 * (v5+), optional `level` (v6).
 *
 * Usage policy (https://transitous.org/api/): open-source, non-commercial,
 * light on resources (> 720 /plan requests per day: coordinate with them),
 * a User-Agent with app name + version + contact on every request, and a
 * visible link to https://transitous.org/sources/ plus OSM attribution.
 */
import type { Journey, LatLon, Leg, LegMode, LineInfo, RailMode, StopTime } from "../types";
import { normalizeColor, haversine } from "../format";
import { journeyTotals } from "../journey";
import { decodePolyline, pathLength } from "../polyline";
import { cached, fetchWithTimeout, PlanError, userAgent } from "../routing/http";
import type { ProviderQuery, ProviderResult } from "../routing/provider";
import { stableHash } from "../routing/provider";
import { classifyMotisLeg, cleanHeadsign, lineLabel, motisTransitModes, tripLabel } from "../routing/rail";
import { buildWalkSteps, type RawStep } from "../routing/walk";

export const TRANSITOUS_BASE = (process.env.TRANSITOUS_URL || "https://api.transitous.org").replace(/\/+$/, "");
const PLAN_PATH = "/api/v6/plan";

/**
 * Server caps reported by GET /api/v1/map/initial → serverConfig (v2.11.4, Nov 2026):
 *   maxPrePostTransitTimeLimit = 7200 s, maxDirectTimeLimit = 21600 s.
 * Larger values are silently capped by the server; we clamp ourselves so the
 * walking limit we report to the user is the one that was actually used.
 */
export const TRANSITOUS_MAX_PREPOST_SECONDS = 7200;
export const TRANSITOUS_MAX_DIRECT_SECONDS = 21600;

export const TRANSITOUS_ATTRIBUTION = [
  "Routing by Transitous (transitous.org), a community-run MOTIS service",
  "Timetable data: Transitous sources — https://transitous.org/sources/",
  "Street routing © OpenStreetMap contributors — https://www.openstreetmap.org/copyright",
];

// ---------------------------------------------------------------------------
// Raw MOTIS types (subset we use)
// ---------------------------------------------------------------------------

type MPolyline = { points: string; precision: number; length: number };
type MAlert = {
  headerText?: string;
  descriptionText?: string;
  url?: string;
  effect?: string;
  severityLevel?: string;
  impactPeriod?: { start?: string; end?: string }[];
  communicationPeriod?: { start?: string; end?: string }[];
};
type MPlace = {
  name: string;
  stopId?: string;
  parentId?: string;
  lat: number;
  lon: number;
  tz?: string;
  arrival?: string;
  departure?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  track?: string;
  scheduledTrack?: string;
  vertexType?: string;
  cancelled?: boolean;
  pickupType?: string;
  dropoffType?: string;
  alerts?: MAlert[];
};
type MStep = {
  relativeDirection?: string;
  distance: number;
  fromLevel?: number;
  toLevel?: number;
  polyline?: MPolyline;
  streetName?: string;
};
type MLeg = {
  mode: string;
  source?: string;
  from: MPlace;
  to: MPlace;
  duration: number;
  startTime: string;
  endTime: string;
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  realTime?: boolean;
  scheduled?: boolean;
  distance?: number;
  interlineWithPreviousLeg?: boolean;
  headsign?: string;
  tripFrom?: MPlace;
  tripTo?: MPlace;
  category?: { id?: string; name?: string; shortName?: string };
  routeId?: string;
  routeUrl?: string;
  routeColor?: string;
  routeTextColor?: string;
  routeType?: number;
  agencyName?: string;
  agencyUrl?: string;
  agencyId?: string;
  tripId?: string;
  routeShortName?: string;
  routeLongName?: string;
  tripShortName?: string;
  displayName?: string;
  cancelled?: boolean;
  intermediateStops?: MPlace[];
  legGeometry?: MPolyline;
  steps?: MStep[];
  alerts?: MAlert[];
};
type MItinerary = { duration: number; startTime: string; endTime: string; transfers: number; legs: MLeg[] };
type MPlanResponse = {
  from?: MPlace;
  to?: MPlace;
  direct?: MItinerary[];
  itineraries?: MItinerary[];
  previousPageCursor?: string;
  nextPageCursor?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export function buildTransitousUrl(q: ProviderQuery): string {
  const o = q.options;
  const walkSec = clamp(Math.round(o.maxWalkMinutes * 60), 60, TRANSITOUS_MAX_PREPOST_SECONDS);
  const p = new URLSearchParams();
  p.set("fromPlace", `${round6(q.from.lat)},${round6(q.from.lon)}`);
  p.set("toPlace", `${round6(q.to.lat)},${round6(q.to.lon)}`);
  if (o.time) p.set("time", new Date(o.time).toISOString());
  p.set("arriveBy", o.arriveBy ? "true" : "false");
  p.set("transitModes", motisTransitModes(o.modes).join(","));
  // Walking is the only non-rail mode ever allowed, before, between and after trains.
  p.set("preTransitModes", "WALK");
  p.set("postTransitModes", "WALK");
  p.set("maxPreTransitTime", String(walkSec));
  p.set("maxPostTransitTime", String(walkSec));
  // Walk-only direct connections (first page only) let us tell the user when walking is quicker.
  p.set("directModes", "WALK");
  if (q.cursor) p.set("pageCursor", q.cursor);
  if (q.searchWindowSec) p.set("searchWindow", String(q.searchWindowSec));
  // Direct (walk-only) results are informational; cap at 45 min of walking.
  p.set("maxDirectTime", String(Math.min(45 * 60, TRANSITOUS_MAX_DIRECT_SECONDS)));
  p.set("timetableView", "true");
  p.set("numItineraries", "6");
  // Without a cap, paged requests can return 40+ itineraries spanning hours.
  p.set("maxItineraries", "8");
  p.set("detailedTransfers", "true");
  p.set("joinInterlinedLegs", "true");
  if (q.language) p.set("language", q.language);
  // Ask the server to give up a little before we do.
  p.set("timeout", String(Math.max(3, Math.floor(q.timeoutMs / 1000) - 1)));
  return `${TRANSITOUS_BASE}${PLAN_PATH}?${p.toString()}`;
}

async function fetchPlan(url: string, timeoutMs: number): Promise<MPlanResponse> {
  const res = await fetchWithTimeout(url, {
    timeoutMs,
    provider: "Transitous",
    headers: { "User-Agent": userAgent(), Accept: "application/json" },
  });
  const text = await res.text();
  let json: MPlanResponse | null = null;
  try {
    json = JSON.parse(text) as MPlanResponse;
  } catch {
    json = null;
  }
  if (res.ok && json) return json;

  const msg = (json?.error || text || "").toString().slice(0, 300);
  if (res.status === 400 && /outside of loaded timetable window/i.test(msg)) {
    const m = msg.match(/\[(\d{4}-\d{2}-\d{2})[^,]*,\s*(\d{4}-\d{2}-\d{2})/);
    throw new PlanError(
      400,
      "That date is outside the published timetables",
      m ? `Timetables cover ${m[1]} to ${m[2]}. Pick a time in that range.` : msg,
    );
  }
  if (res.status === 400 || res.status === 422) throw new PlanError(400, "Transitous could not use this request", msg);
  if (res.status === 403)
    throw new PlanError(
      502,
      "Transitous refused the request (HTTP 403)",
      "The routing service rejected this app's requests (User-Agent or usage policy). Set ONLY_TRAINS_CONTACT for your deployment and try again later.",
    );
  if (res.status === 429)
    throw new PlanError(503, "Transitous is rate-limiting requests", "Too many searches right now. Please wait a minute and retry.");
  if (res.status === 404) return { itineraries: [], direct: [] };
  if (res.status === 504) throw new PlanError(504, "Transitous timed out", msg || "The routing search took too long.");
  throw new PlanError(502, `Transitous error (HTTP ${res.status})`, msg || "The routing service is unavailable.");
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function stopTime(p: MPlace, role: "start" | "end" | "stop"): StopTime {
  let name = (p.name || "").trim();
  if (p.vertexType === "NORMAL" || !name) {
    if (name === "START" || (role === "start" && !name)) name = "Start";
    else if (name === "END" || (role === "end" && !name)) name = "Destination";
  }
  const st: StopTime = { name: name || "Stop", lat: p.lat, lon: p.lon };
  if (p.stopId) st.stopId = p.stopId;
  if (p.arrival) st.arrival = p.arrival;
  if (p.departure) st.departure = p.departure;
  if (p.scheduledArrival) st.scheduledArrival = p.scheduledArrival;
  if (p.scheduledDeparture) st.scheduledDeparture = p.scheduledDeparture;
  const track = (p.track || p.scheduledTrack || "").trim();
  if (track) st.track = track;
  if (p.tz) st.tz = p.tz;
  return st;
}

const SERIOUS_STOP_EFFECTS = new Set([
  "NO_SERVICE",
  "REDUCED_SERVICE",
  "SIGNIFICANT_DELAYS",
  "DETOUR",
  "STOP_MOVED",
  "MODIFIED_SERVICE",
  "ACCESSIBILITY_ISSUE",
]);

function overlaps(periods: { start?: string; end?: string }[] | undefined, start: number, end: number): boolean {
  if (!periods || !periods.length) return true;
  return periods.some((p) => {
    const s = p.start ? Date.parse(p.start) : -Infinity;
    const e = p.end ? Date.parse(p.end) : Infinity;
    return s < end && e > start;
  });
}

function legAlerts(l: MLeg): Leg["alerts"] {
  const start = Date.parse(l.startTime);
  const end = Date.parse(l.endTime);
  const out: NonNullable<Leg["alerts"]> = [];
  const seen = new Set<string>();
  const add = (a: MAlert, stop: boolean) => {
    if (stop && a.effect && !SERIOUS_STOP_EFFECTS.has(a.effect)) return;
    if (!overlaps(a.impactPeriod ?? a.communicationPeriod, start, end)) return;
    const header = (a.headerText || "").trim();
    const description = (a.descriptionText || "").trim();
    if (!header && !description) return;
    const key = `${header}|${description.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      header: header || undefined,
      description: description && description !== header ? description : undefined,
      url: a.url || undefined,
    });
  };
  for (const a of l.alerts ?? []) add(a, false);
  for (const a of l.from.alerts ?? []) add(a, true);
  for (const a of l.to.alerts ?? []) add(a, true);
  return out.length ? out.slice(0, 5) : undefined;
}

function legGeometry(l: MLeg): [number, number][] {
  const g = l.legGeometry;
  const pts = g?.points ? decodePolyline(g.points, g.precision || 6) : [];
  if (pts.length >= 2) return pts;
  // No shape: straight segments through the stops we know about.
  const chain: [number, number][] = [[l.from.lon, l.from.lat]];
  for (const s of l.intermediateStops ?? []) chain.push([s.lon, s.lat]);
  chain.push([l.to.lon, l.to.lat]);
  return chain;
}

function railDistance(l: MLeg, geometry: [number, number][]): number {
  const geomLen = pathLength(geometry);
  if (geomLen > 0) return Math.round(geomLen);
  let d = 0;
  let prev = { lat: l.from.lat, lon: l.from.lon };
  for (const s of [...(l.intermediateStops ?? []), l.to]) {
    d += haversine(prev, s);
    prev = s;
  }
  return Math.round(d);
}

type NormalizedLeg = { leg: Leg; mode: LegMode | null; tripKey: string };

function normalizeLeg(l: MLeg, isFirst: boolean, isLast: boolean): NormalizedLeg {
  const categoryShort = l.category?.shortName || l.category?.name || undefined;
  const mode = classifyMotisLeg({
    rawMode: l.mode,
    feed: l.source,
    routeType: l.routeType,
    agency: l.agencyName,
    shortName: l.routeShortName,
    longName: l.routeLongName,
    displayName: l.displayName,
    tripShortName: l.tripShortName,
    category: categoryShort,
  });
  const geometry = legGeometry(l);
  const from = stopTime(l.from, isFirst ? "start" : "stop");
  const to = stopTime(l.to, isLast ? "end" : "stop");
  const duration = Math.max(0, Math.round(l.duration ?? (Date.parse(l.endTime) - Date.parse(l.startTime)) / 1000));

  const leg: Leg = {
    mode: mode ?? "WALK", // placeholder; itineraries with mode === null are discarded
    rawMode: l.mode,
    from,
    to,
    startTime: l.startTime,
    endTime: l.endTime,
    duration,
    geometry,
  };
  if (l.scheduledStartTime) leg.scheduledStartTime = l.scheduledStartTime;
  if (l.scheduledEndTime) leg.scheduledEndTime = l.scheduledEndTime;
  if (l.realTime) leg.realTime = true;
  // MOTIS sometimes flags transfer walks as cancelled; only a train can be cancelled.
  if (l.cancelled && mode !== "WALK") leg.cancelled = true;

  if (mode === "WALK") {
    leg.distance = Math.round(l.distance ?? pathLength(geometry));
    const raw: RawStep[] = (l.steps ?? []).map((s) => ({
      distance: s.distance,
      streetName: s.streetName,
      direction: s.relativeDirection,
      fromLevel: s.fromLevel,
      toLevel: s.toLevel,
      geometry: s.polyline?.points ? decodePolyline(s.polyline.points, s.polyline.precision || 6) : [],
    }));
    const steps = buildWalkSteps(raw, to.name);
    if (steps.length) leg.steps = steps;
  } else if (mode) {
    const rail = mode as RailMode;
    leg.distance = railDistance(l, geometry);
    const labelInput = {
      mode: rail,
      rawMode: l.mode,
      shortName: l.routeShortName,
      longName: l.routeLongName,
      displayName: l.displayName,
      tripShortName: l.tripShortName,
      agency: l.agencyName,
      category: categoryShort,
    };
    const line: LineInfo = { name: lineLabel(labelInput) };
    const sn = (l.routeShortName || "").trim();
    const ln = (l.routeLongName || "").trim();
    if (sn) line.shortName = sn;
    if (ln) line.longName = ln;
    const color = normalizeColor(l.routeColor);
    if (color) line.color = color;
    const textColor = normalizeColor(l.routeTextColor);
    if (textColor && color) line.textColor = textColor;
    if (l.agencyName) line.agency = l.agencyName.trim();
    if (l.agencyUrl) line.agencyUrl = l.agencyUrl;
    if (l.routeUrl) line.routeUrl = l.routeUrl;
    const trip = tripLabel(labelInput);
    if (trip) line.tripName = trip;
    if (typeof l.routeType === "number") line.routeType = l.routeType;
    leg.line = line;
    const hs = cleanHeadsign(l.headsign, l.tripTo?.name);
    if (hs) leg.headsign = hs;
    const inter = (l.intermediateStops ?? []).map((s) => stopTime(s, "stop"));
    if (inter.length) leg.intermediateStops = inter;
  }
  const alerts = legAlerts(l);
  if (alerts) leg.alerts = alerts;

  const tripKey = mode && mode !== "WALK" ? `${l.tripId ?? l.routeId ?? leg.line?.name}@${l.from.stopId ?? from.name}@${l.startTime}` : "";
  return { leg, mode, tripKey };
}

/** True when a walk leg carries no information (same spot, zero time). */
function isEmptyWalk(leg: Leg): boolean {
  return leg.mode === "WALK" && leg.duration === 0 && (leg.distance ?? 0) < 1;
}

export function normalizeItinerary(it: MItinerary, allowed: Set<LegMode>): Journey | null {
  const legs: Leg[] = [];
  const keys: string[] = [];
  const n = it.legs.length;
  for (let i = 0; i < n; i++) {
    const { leg, mode, tripKey } = normalizeLeg(it.legs[i], i === 0, i === n - 1);
    if (mode === null || !allowed.has(mode)) return null; // hard rule: rail + walk only
    if (isEmptyWalk(leg)) continue;
    legs.push(leg);
    if (tripKey) keys.push(tripKey);
  }
  if (!legs.some((l) => l.mode !== "WALK")) return null; // walk-only "journeys" are not train trips
  const totals = journeyTotals(legs, it.startTime, it.endTime);
  return {
    id: `t-${stableHash(keys.join("|") || `${it.startTime}|${it.endTime}`)}`,
    provider: "transitous",
    startTime: it.startTime,
    endTime: it.endTime,
    ...totals,
    // Prefer MOTIS' own count (stay-seated / interlined connections are not transfers).
    transfers: Number.isFinite(it.transfers) ? it.transfers : totals.transfers,
    legs,
  };
}

// ---------------------------------------------------------------------------
// Provider entry point
// ---------------------------------------------------------------------------

export async function planTransitous(q: ProviderQuery): Promise<ProviderResult> {
  const url = buildTransitousUrl(q);
  // Same URL within a short window → same answer (explicit times are stable for longer).
  const ttl = q.options.time || q.cursor ? 60_000 : 20_000;
  const raw = await cached(`transitous:${url}`, ttl, () => fetchPlan(url, q.timeoutMs));

  const allowed = new Set<LegMode>(["WALK", ...q.options.modes]);
  const journeys: Journey[] = [];
  let rejected = 0;
  for (const it of raw.itineraries ?? []) {
    const j = normalizeItinerary(it, allowed);
    if (j) journeys.push(j);
    else rejected++;
  }

  const agencies = new Set<string>();
  for (const j of journeys) for (const l of j.legs) if (l.line?.agency) agencies.add(l.line.agency);
  const attribution = [...TRANSITOUS_ATTRIBUTION];
  if (agencies.size) attribution.push(`Operators: ${[...agencies].slice(0, 8).join(", ")}`);

  const firstLeg = (raw.itineraries ?? [])[0]?.legs?.[0];
  const lastLegs = (raw.itineraries ?? [])[0]?.legs;
  const lastLeg = lastLegs?.[lastLegs.length - 1];
  const direct = (raw.direct ?? []).find((d) => d.legs?.every((l) => l.mode === "WALK"));

  return {
    journeys,
    rejected,
    cursors: { earlier: raw.previousPageCursor || undefined, later: raw.nextPageCursor || undefined },
    // Stop time zones (from the timetable) beat MOTIS' guess for the raw coordinate.
    originTz: firstRailTz(journeys, "from") || raw.from?.tz || firstLeg?.from?.tz,
    destinationTz: firstRailTz(journeys, "to") || raw.to?.tz || lastLeg?.to?.tz,
    directWalk: direct
      ? { duration: direct.duration, distance: direct.legs.reduce((s, l) => s + (l.distance ?? 0), 0) }
      : undefined,
    attribution,
    warnings: [],
  };
}

function firstRailTz(journeys: Journey[], end: "from" | "to"): string | undefined {
  const j = journeys[0];
  if (!j) return undefined;
  const rail = j.legs.filter((l) => l.mode !== "WALK");
  const leg = end === "from" ? rail[0] : rail[rail.length - 1];
  return end === "from" ? leg?.from.tz : leg?.to.tz;
}

function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

function round6(x: number) {
  return Math.round(x * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Long walks (used to reach a station that is beyond the walking limit)
// ---------------------------------------------------------------------------

/**
 * A walking leg between two points that departs at `departAt` (ISO), routed on
 * OSM streets by Transitous when it is under its 6 h direct-walk cap, otherwise
 * a straight-line estimate (80 m/min with a 1.3 detour factor). Never throws.
 */
export async function walkLeg(
  from: LatLon & { name: string },
  to: LatLon & { name: string },
  departAt: string,
  timeoutMs: number,
): Promise<Leg> {
  const start = new Date(departAt).getTime();
  // Transitous routes walks up to roughly 15 km; route longer ones (up to
  // ~65 km) as a chain of street-routed pieces between points on the line.
  const total = haversine(from, to);
  const pieces = total <= 13_000 ? 1 : total <= 65_000 ? Math.ceil(total / 13_000) : 0;
  if (pieces) {
    const pts: LatLon[] = Array.from({ length: pieces + 1 }, (_, i) => ({
      lat: from.lat + ((to.lat - from.lat) * i) / pieces,
      lon: from.lon + ((to.lon - from.lon) * i) / pieces,
    }));
    const parts: { duration: number; legs: Leg[] }[] = [];
    for (let i = 0; i < pieces; i++) {
      const part = await streetWalk(pts[i], pts[i + 1], new Date(start).toISOString(), timeoutMs).catch(() => null);
      if (!part) break;
      parts.push(part);
    }
    if (parts.length === pieces) {
      const legs = parts.flatMap((x) => x.legs);
      const dur = parts.reduce((sum, x) => sum + x.duration, 0);
      const steps = legs.flatMap((l) => l.steps ?? []).filter((st) => !/^Arrive at /i.test(st.instruction) || st === legs[legs.length - 1].steps?.at(-1));
      return {
        mode: "WALK",
        from: { name: from.name, lat: from.lat, lon: from.lon, departure: new Date(start).toISOString() },
        to: { name: to.name, lat: to.lat, lon: to.lon, arrival: new Date(start + dur * 1000).toISOString() },
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + dur * 1000).toISOString(),
        duration: dur,
        distance: Math.round(legs.reduce((sum, l) => sum + (l.distance ?? 0), 0)),
        geometry: legs.flatMap((l) => l.geometry),
        steps,
      };
    }
  }
  const straight = haversine(from, to);
  const distance = Math.round(straight * 1.3);
  const dur = Math.round(distance / (80 / 60));
  return {
    mode: "WALK",
    from: { name: from.name, lat: from.lat, lon: from.lon, departure: new Date(start).toISOString() },
    to: { name: to.name, lat: to.lat, lon: to.lon, arrival: new Date(start + dur * 1000).toISOString() },
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + dur * 1000).toISOString(),
    duration: dur,
    distance,
    geometry: [
      [from.lon, from.lat],
      [to.lon, to.lat],
    ],
    steps: [{ instruction: `Walk about ${Math.round(distance / 1000)} km to ${to.name} (no street route available; straight-line estimate)`, distance }],
  };
}

async function streetWalk(from: LatLon, to: LatLon, departAt: string, timeoutMs: number): Promise<{ duration: number; legs: Leg[] } | null> {
  const p = new URLSearchParams();
  p.set("fromPlace", `${round6(from.lat)},${round6(from.lon)}`);
  p.set("toPlace", `${round6(to.lat)},${round6(to.lon)}`);
  p.set("time", departAt);
  p.set("transitModes", "RAIL");
  p.set("maxTransfers", "0");
  p.set("maxPreTransitTime", "60");
  p.set("maxPostTransitTime", "60");
  p.set("directModes", "WALK");
  p.set("maxDirectTime", String(TRANSITOUS_MAX_DIRECT_SECONDS));
  p.set("numItineraries", "1");
  p.set("timeout", String(Math.max(3, Math.floor(timeoutMs / 1000) - 1)));
  const url = `${TRANSITOUS_BASE}${PLAN_PATH}?${p}`;
  const raw = await cached(`walk:${url.replace(/time=[^&]+&/, "")}`, 10 * 60_000, () => fetchPlan(url, timeoutMs));
  const d = (raw.direct ?? []).find((x) => x.legs?.length && x.legs.every((l) => l.mode === "WALK"));
  if (!d) return null;
  return { duration: d.duration, legs: d.legs.map((l, i) => normalizeLeg(l, i === 0, i === d.legs.length - 1).leg) };
}
