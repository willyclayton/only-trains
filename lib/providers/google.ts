/**
 * Google Routes API v2 (transit) — optional fallback, used only when
 * process.env.GOOGLE_MAPS_API_KEY is set.
 *
 * POST https://routes.googleapis.com/directions/v2:computeRoutes
 *   travelMode: "TRANSIT", transitPreferences.allowedTravelModes ⊂ {SUBWAY, TRAIN, LIGHT_RAIL, RAIL}
 *   (RAIL = SUBWAY + TRAIN + LIGHT_RAIL; BUS is simply never requested).
 * A response field mask (X-Goog-FieldMask) is mandatory.
 * Transit steps carry transitDetails.transitLine {name, nameShort, color, textColor, agencies, uri,
 * vehicle.type}, stopDetails {departure/arrival stop + time}, headsign, stopCount, tripShortText.
 * Polylines are standard Google encoded polylines (precision 5).
 * Transit departure/arrival times may be up to 7 days in the past / 100 days in the future.
 * Billing: "Compute Routes Essentials" SKU (transit uses no Pro/Enterprise features).
 * Proto reference: googleapis/google/maps/routing/v2/{routes_service,route,transit,transit_preferences}.proto
 */
import type { Journey, Leg, LegMode, LineInfo, RailMode, StopTime, WalkStep } from "../types";
import { normalizeColor } from "../format";
import { journeyTotals } from "../journey";
import { decodePolyline, pathLength } from "../polyline";
import { fetchWithTimeout, PlanError } from "../routing/http";
import type { ProviderQuery, ProviderResult } from "../routing/provider";
import { stableHash } from "../routing/provider";
import { classifyGoogleVehicle } from "../routing/rail";

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

const FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.legs.startLocation",
  "routes.legs.endLocation",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.polyline.encodedPolyline",
  "routes.legs.steps.startLocation",
  "routes.legs.steps.endLocation",
  "routes.legs.steps.navigationInstruction",
  "routes.legs.steps.transitDetails",
].join(",");

export const GOOGLE_ATTRIBUTION = ["Routing fallback: Google Maps Platform (Routes API) — Map data ©Google"];

export function googleEnabled(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY;
}

type GLatLng = { latLng?: { latitude: number; longitude: number } };
type GStop = { name?: string; location?: GLatLng };
type GStep = {
  travelMode?: string;
  distanceMeters?: number;
  staticDuration?: string;
  polyline?: { encodedPolyline?: string };
  startLocation?: GLatLng;
  endLocation?: GLatLng;
  navigationInstruction?: { maneuver?: string; instructions?: string };
  transitDetails?: {
    stopDetails?: { arrivalStop?: GStop; arrivalTime?: string; departureStop?: GStop; departureTime?: string };
    localizedValues?: {
      arrivalTime?: { time?: { text?: string }; timeZone?: string };
      departureTime?: { time?: { text?: string }; timeZone?: string };
    };
    headsign?: string;
    headway?: string;
    transitLine?: {
      agencies?: { name?: string; uri?: string; phoneNumber?: string }[];
      name?: string;
      nameShort?: string;
      uri?: string;
      color?: string;
      textColor?: string;
      vehicle?: { name?: { text?: string }; type?: string };
    };
    stopCount?: number;
    tripShortText?: string;
  };
};
type GRoute = {
  duration?: string;
  distanceMeters?: number;
  legs?: { startLocation?: GLatLng; endLocation?: GLatLng; steps?: GStep[] }[];
};

function allowedTravelModes(modes: RailMode[]): string[] {
  const s = new Set<string>();
  for (const m of modes) {
    if (m === "SUBWAY") s.add("SUBWAY");
    if (m === "COMMUTER" || m === "INTERCITY") s.add("TRAIN");
    if (m === "LIGHT_RAIL") s.add("LIGHT_RAIL");
    if (m === "OTHER_RAIL") s.add("RAIL"); // monorail/funicular have no dedicated filter
  }
  return s.has("RAIL") ? ["RAIL"] : [...s];
}

const secs = (d: string | undefined) => {
  const n = d ? parseFloat(d) : NaN;
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");

function pt(loc: GLatLng | undefined): { lat: number; lon: number } | null {
  const ll = loc?.latLng;
  return ll && Number.isFinite(ll.latitude) && Number.isFinite(ll.longitude) ? { lat: ll.latitude, lon: ll.longitude } : null;
}

type Piece =
  | { kind: "walk"; steps: GStep[]; duration: number; distance: number }
  | { kind: "rail"; step: GStep; mode: RailMode };

function normalizeRoute(r: GRoute, q: ProviderQuery, allowed: Set<LegMode>): Journey | null {
  const steps = (r.legs ?? []).flatMap((l) => l.steps ?? []);
  if (!steps.length) return null;

  // 1) split into walk runs and rail steps; reject anything else
  const pieces: Piece[] = [];
  for (const s of steps) {
    const tm = (s.travelMode || "").toUpperCase();
    if (tm === "WALK" || (!tm && !s.transitDetails)) {
      const last = pieces[pieces.length - 1];
      const dur = secs(s.staticDuration);
      const dist = s.distanceMeters ?? 0;
      if (last && last.kind === "walk") {
        last.steps.push(s);
        last.duration += dur;
        last.distance += dist;
      } else pieces.push({ kind: "walk", steps: [s], duration: dur, distance: dist });
      continue;
    }
    if (tm !== "TRANSIT" || !s.transitDetails) return null; // DRIVE/BICYCLE/...: never
    const tl = s.transitDetails.transitLine;
    const names = [tl?.nameShort, tl?.name, tl?.vehicle?.name?.text, s.transitDetails.tripShortText].filter(Boolean).join(" | ");
    const mode = classifyGoogleVehicle(tl?.vehicle?.type, names);
    if (!mode || !allowed.has(mode)) return null; // hard rule
    pieces.push({ kind: "rail", step: s, mode });
  }
  const railIdx = pieces.map((p, i) => (p.kind === "rail" ? i : -1)).filter((i) => i >= 0);
  if (!railIdx.length) return null;

  // 2) build legs with absolute times anchored on transit departures/arrivals
  const legs: Leg[] = [];
  const keys: string[] = [];
  let cursorMs = NaN; // end time of the previous leg
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (p.kind === "rail") {
      const td = p.step.transitDetails!;
      const sd = td.stopDetails ?? {};
      const dep = Date.parse(sd.departureTime ?? "");
      const arr = Date.parse(sd.arrivalTime ?? "");
      if (!Number.isFinite(dep) || !Number.isFinite(arr)) return null;
      const depTz = td.localizedValues?.departureTime?.timeZone;
      const arrTz = td.localizedValues?.arrivalTime?.timeZone;
      const a = pt(sd.departureStop?.location) ?? pt(p.step.startLocation);
      const b = pt(sd.arrivalStop?.location) ?? pt(p.step.endLocation);
      if (!a || !b) return null;
      const geometry = decodePolyline(p.step.polyline?.encodedPolyline, 5);
      const geom: [number, number][] = geometry.length >= 2 ? geometry : [[a.lon, a.lat], [b.lon, b.lat]];
      const tl = td.transitLine ?? {};
      const agency = tl.agencies?.[0];
      const line: LineInfo = { name: googleLineName(tl, td.tripShortText, p.mode) };
      if (tl.nameShort) line.shortName = tl.nameShort;
      if (tl.name) line.longName = tl.name;
      const color = normalizeColor(tl.color);
      if (color) line.color = color;
      const textColor = normalizeColor(tl.textColor);
      if (color && textColor) line.textColor = textColor;
      if (agency?.name) line.agency = agency.name;
      if (agency?.uri) line.agencyUrl = agency.uri;
      if (tl.uri) line.routeUrl = tl.uri;
      if (td.tripShortText && (p.mode === "INTERCITY" || p.mode === "COMMUTER")) {
        const prefix = tl.nameShort || agency?.name || "Train";
        line.tripName = /[A-Za-z]/.test(td.tripShortText) ? td.tripShortText : `${prefix} ${td.tripShortText}`;
      }
      const from: StopTime = { name: sd.departureStop?.name || "Station", lat: a.lat, lon: a.lon, departure: iso(dep) };
      const to: StopTime = { name: sd.arrivalStop?.name || "Station", lat: b.lat, lon: b.lon, arrival: iso(arr) };
      if (depTz) from.tz = depTz;
      if (arrTz) to.tz = arrTz;
      const leg: Leg = {
        mode: p.mode,
        rawMode: tl.vehicle?.type,
        from,
        to,
        startTime: iso(dep),
        endTime: iso(arr),
        duration: Math.max(0, Math.round((arr - dep) / 1000)),
        distance: Math.round(p.step.distanceMeters || pathLength(geom)),
        geometry: geom,
        line,
      };
      if (td.headsign) leg.headsign = td.headsign;
      legs.push(leg);
      keys.push(`${line.name}@${from.name}@${leg.startTime}`);
      cursorMs = arr;
      continue;
    }
    // walk run
    const firstStep = p.steps[0];
    const lastStep = p.steps[p.steps.length - 1];
    const a = pt(firstStep.startLocation) ?? (i === 0 ? q.from : null);
    const b = pt(lastStep.endLocation) ?? (i === pieces.length - 1 ? q.to : null);
    if (!a || !b) continue;
    let start: number;
    if (Number.isFinite(cursorMs)) start = cursorMs;
    else {
      const next = pieces[i + 1];
      const nextDep = next && next.kind === "rail" ? Date.parse(next.step.transitDetails?.stopDetails?.departureTime ?? "") : NaN;
      start = Number.isFinite(nextDep) ? nextDep - p.duration * 1000 : Date.now();
    }
    const end = start + p.duration * 1000;
    const geometry: [number, number][] = [];
    for (const s of p.steps) for (const c of decodePolyline(s.polyline?.encodedPolyline, 5)) geometry.push(c);
    const prevLeg = legs[legs.length - 1];
    const nextPiece = pieces[i + 1];
    const fromName = i === 0 ? "Start" : prevLeg?.to.name ?? "Station";
    const toName =
      i === pieces.length - 1
        ? "Destination"
        : nextPiece && nextPiece.kind === "rail"
          ? nextPiece.step.transitDetails?.stopDetails?.departureStop?.name || "Station"
          : "Station";
    const walkSteps: WalkStep[] = p.steps
      .filter((s) => s.navigationInstruction?.instructions)
      .map((s) => ({ instruction: s.navigationInstruction!.instructions!.replace(/\s+/g, " ").trim(), distance: s.distanceMeters ?? 0 }));
    if (walkSteps.length) walkSteps.push({ instruction: `Arrive at ${toName}`, distance: 0 });
    const leg: Leg = {
      mode: "WALK",
      from: { name: fromName, lat: a.lat, lon: a.lon, departure: iso(start) },
      to: { name: toName, lat: b.lat, lon: b.lon, arrival: iso(end) },
      startTime: iso(start),
      endTime: iso(end),
      duration: p.duration,
      distance: Math.round(p.distance),
      geometry: geometry.length >= 2 ? geometry : [[a.lon, a.lat], [b.lon, b.lat]],
    };
    if (prevLeg?.to.tz) leg.from.tz = leg.to.tz = prevLeg.to.tz;
    if (walkSteps.length) leg.steps = walkSteps;
    if (leg.duration > 0 || (leg.distance ?? 0) >= 1) legs.push(leg);
    cursorMs = end;
  }
  // first walk leg has no tz yet: borrow from the first rail leg
  const firstRail = legs.find((l) => l.mode !== "WALK");
  for (const l of legs) {
    if (l.mode !== "WALK") break;
    if (firstRail?.from.tz) l.from.tz = l.to.tz = firstRail.from.tz;
  }
  if (!legs.length) return null;
  const startTime = legs[0].startTime;
  const endTime = legs[legs.length - 1].endTime;
  const totals = journeyTotals(legs, startTime, endTime);
  return {
    id: `g-${stableHash(keys.join("|"))}`,
    provider: "google",
    startTime,
    endTime,
    ...totals,
    legs,
  };
}

function googleLineName(
  tl: NonNullable<NonNullable<GStep["transitDetails"]>["transitLine"]>,
  tripShortText: string | undefined,
  mode: RailMode,
): string {
  const short = (tl.nameShort || "").trim();
  const long = (tl.name || "").trim();
  if (mode === "INTERCITY" && short && tripShortText && /^\d+$/.test(tripShortText)) return `${short} ${tripShortText}`;
  if (short && long && long.toLowerCase().includes(short.toLowerCase()) && long.length <= 28) return long;
  return short || long || tl.vehicle?.name?.text || "Train";
}

/** Google has no paging cursor; ours is the ISO departure time to search from. */
export async function planGoogle(q: ProviderQuery): Promise<ProviderResult> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new PlanError(500, "Google fallback is not configured");
  const o = q.options;
  const body: Record<string, unknown> = {
    origin: { location: { latLng: { latitude: q.from.lat, longitude: q.from.lon } } },
    destination: { location: { latLng: { latitude: q.to.lat, longitude: q.to.lon } } },
    travelMode: "TRANSIT",
    computeAlternativeRoutes: true,
    languageCode: q.language || "en",
    units: "METRIC",
    transitPreferences: { allowedTravelModes: allowedTravelModes(o.modes) },
  };
  if (q.cursor) body.departureTime = new Date(q.cursor).toISOString();
  else if (o.time) body[o.arriveBy ? "arrivalTime" : "departureTime"] = new Date(o.time).toISOString();

  const res = await fetchWithTimeout(ENDPOINT, {
    method: "POST",
    timeoutMs: q.timeoutMs,
    provider: "Google Routes",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message || msg;
    } catch {}
    if (res.status === 400) throw new PlanError(400, "Google Routes could not use this request", msg);
    if (res.status === 401 || res.status === 403) throw new PlanError(502, "Google Routes refused the API key", msg);
    if (res.status === 429) throw new PlanError(503, "Google Routes quota exceeded", msg);
    throw new PlanError(502, `Google Routes error (HTTP ${res.status})`, msg);
  }
  const data = JSON.parse(text || "{}") as { routes?: GRoute[] };
  const allowed = new Set<LegMode>(["WALK", ...o.modes]);
  const journeys: Journey[] = [];
  let rejected = 0;
  for (const r of data.routes ?? []) {
    const j = normalizeRoute(r, q, allowed);
    if (j) journeys.push(j);
    else rejected++;
  }
  journeys.sort((a, b) => a.startTime.localeCompare(b.startTime));
  const first = journeys[0];
  const last = journeys[journeys.length - 1];
  return {
    journeys,
    rejected,
    cursors: {
      earlier: first ? new Date(Date.parse(first.startTime) - 45 * 60_000).toISOString() : undefined,
      later: last ? new Date(Date.parse(last.startTime) + 60_000).toISOString() : undefined,
    },
    originTz: first?.legs.find((l) => l.from.tz)?.from.tz,
    destinationTz: [...(first?.legs ?? [])].reverse().find((l) => l.to.tz)?.to.tz,
    attribution: GOOGLE_ATTRIBUTION,
    warnings: [],
  };
}
