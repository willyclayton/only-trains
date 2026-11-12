/**
 * Only Trains journey planning orchestrator.
 *
 *  1. validate input
 *  2. ask Transitous (rail modes only, walking only before/between/after)
 *  3. nothing found → escalate the walking limit (requested → 30 → 60 min) and say so
 *  4. still nothing and GOOGLE_MAPS_API_KEY set → Google Routes (rail-only transit)
 *  5. HARD GUARANTEE: drop any journey with a leg that is not WALK or a selected RailMode
 *  6. dedupe, sort, wrap paging cursors, timezones, attribution, warnings
 */
import type { Journey, LatLon, Leg, PlanOptions, PlanResponse, Place, RailMode, StationHint } from "./types";
import { ALL_RAIL_MODES, DEFAULT_MAX_WALK_MINUTES, DEFAULT_MODES, isRailMode } from "./modes";
import { formatDistance, formatDuration, haversine } from "./format";
import { PlanError } from "./routing/http";
import type { ProviderQuery, ProviderResult } from "./routing/provider";
import { planTransitous, TRANSITOUS_ATTRIBUTION, TRANSITOUS_MAX_PREPOST_SECONDS, walkLeg } from "./providers/transitous";
import { journeyTotals } from "./journey";
import { googleEnabled, planGoogle } from "./providers/google";
import { nearbyRailStations, serviceHubs, walkMinutesFor, type NearestStation } from "./routing/nearest";

export { PlanError } from "./routing/http";

export type PlanInput = {
  from: LatLon;
  to: LatLon;
  options: PlanOptions;
  /** Opaque cursor previously returned in PlanResponse.cursors. */
  cursor?: string;
  /** Language for station/line names, e.g. "en". */
  language?: string;
  /** Include timing/error diagnostics in the response. */
  debug?: boolean;
};

type Nearby = (NearestStation[] | undefined)[];

/** Walking limits tried, in minutes, when nothing is found within the requested one. */
const ESCALATION_STEPS = [30, 60];
const MAX_WALK_MINUTES = Math.min(120, TRANSITOUS_MAX_PREPOST_SECONDS / 60);
/** Overall budget for one /api/plan call (Vercel maxDuration is 60 s). */
const TOTAL_BUDGET_MS = 50_000;
const PER_CALL_TIMEOUT_MS = 12_000;

const FORBIDDEN_RAW = /^(BUS|COACH|FERRY|AIRPLANE|AERIAL_LIFT|AREAL_LIFT|CABLE_CAR|GONDOLA_LIFT|TROLLEYBUS|INTERCITY_BUS|SHARE_TAXI|ODM|RIDE_SHARING|FLEX|TAXI|CAR|BIKE|RENTAL)$/i;

// ---------------------------------------------------------------------------
// Input parsing / validation
// ---------------------------------------------------------------------------

export function parseLatLon(v: string | null | undefined, label: string): LatLon {
  if (!v) throw new PlanError(400, `Missing ${label}`, `Pass ${label}=lat,lon`);
  const parts = v.split(",").map((s) => s.trim());
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (parts.length < 2 || !Number.isFinite(lat) || !Number.isFinite(lon) || parts[0] === "" || parts[1] === "")
    throw new PlanError(400, `Invalid ${label} coordinates`, `Expected "lat,lon", got "${v.slice(0, 60)}"`);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180)
    throw new PlanError(400, `Invalid ${label} coordinates`, "Latitude must be within ±90 and longitude within ±180.");
  return { lat, lon };
}

/** Parse /api/plan query parameters into a PlanInput (throws PlanError 400). */
export function parsePlanParams(sp: URLSearchParams): PlanInput {
  const from = parseLatLon(sp.get("from"), "from");
  const to = parseLatLon(sp.get("to"), "to");

  let modes: RailMode[] = DEFAULT_MODES;
  const rawModes = sp.get("modes");
  if (rawModes !== null) {
    const list = rawModes
      .split(",")
      .map((m) => m.trim().toUpperCase())
      .filter(Boolean);
    const valid = list.filter(isRailMode) as RailMode[];
    const invalid = list.filter((m) => !isRailMode(m));
    if (invalid.length) throw new PlanError(400, "Unknown train type", `Unknown mode(s): ${invalid.join(", ")}. Use ${ALL_RAIL_MODES.join(", ")}.`);
    if (!valid.length) throw new PlanError(400, "Pick at least one kind of train");
    modes = ALL_RAIL_MODES.filter((m) => valid.includes(m)); // canonical order, deduped
  }

  let maxWalkMinutes = DEFAULT_MAX_WALK_MINUTES;
  const rawWalk = sp.get("maxWalk");
  if (rawWalk !== null && rawWalk !== "") {
    const n = Number(rawWalk);
    if (!Number.isFinite(n) || n <= 0) throw new PlanError(400, "Invalid maxWalk", "maxWalk is the walking limit in minutes, e.g. 20.");
    maxWalkMinutes = Math.min(MAX_WALK_MINUTES, Math.max(1, Math.round(n)));
  }

  let time: string | null = null;
  const rawTime = sp.get("time");
  if (rawTime) {
    const t = Date.parse(rawTime);
    if (!Number.isFinite(t)) throw new PlanError(400, "Invalid time", "Use an ISO-8601 timestamp, e.g. 2026-11-12T08:30:00Z.");
    time = new Date(t).toISOString();
  }
  const arr = (sp.get("arriveBy") ?? "").toLowerCase();
  const arriveBy = arr === "1" || arr === "true";

  const cursor = sp.get("cursor") || undefined;
  const language = sp.get("lang") || undefined;
  return { from, to, options: { time, arriveBy, modes, maxWalkMinutes }, cursor, language };
}

// ---------------------------------------------------------------------------
// Cursors: wrap the provider's cursor with the provider id + effective walk limit
// so the next page repeats the exact same query (MOTIS requires that).
// ---------------------------------------------------------------------------

type CursorPayload = { v: 1; p: "t" | "g"; c: string; w: number };

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

function decodeCursor(s: string): CursorPayload {
  try {
    const p = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as CursorPayload;
    if (p && p.v === 1 && (p.p === "t" || p.p === "g") && typeof p.c === "string" && Number.isFinite(p.w)) return p;
  } catch {}
  throw new PlanError(400, "Invalid paging cursor", "Run the search again.");
}

// ---------------------------------------------------------------------------
// Guarantees
// ---------------------------------------------------------------------------

function legIsAllowed(l: Leg, allowed: Set<string>): boolean {
  if (!allowed.has(l.mode)) return false;
  if (l.mode === "WALK") return true;
  if (l.rawMode && FORBIDDEN_RAW.test(l.rawMode)) return false;
  return !!l.line; // rail legs must say which train they are
}

/** Belt and braces: providers already filter, but nothing non-rail may ever leave this function. */
export function enforceRailOnly(journeys: Journey[], modes: RailMode[]): { kept: Journey[]; dropped: number } {
  const allowed = new Set<string>(["WALK", ...modes]);
  const kept = journeys.filter((j) => j.legs.length > 0 && j.legs.some((l) => l.mode !== "WALK") && j.legs.every((l) => legIsAllowed(l, allowed)));
  return { kept, dropped: journeys.length - kept.length };
}

function signature(j: Journey): string {
  return j.legs
    .filter((l) => l.mode !== "WALK")
    .map((l) => `${l.line?.name}|${l.from.name}|${l.startTime}|${l.to.name}`)
    .join(">");
}

function dedupe(journeys: Journey[]): Journey[] {
  const seenId = new Set<string>();
  const seenSig = new Set<string>();
  const out: Journey[] = [];
  for (const j of journeys) {
    const sig = signature(j);
    if (seenId.has(j.id) || seenSig.has(sig)) continue;
    seenId.add(j.id);
    seenSig.add(sig);
    out.push(j);
  }
  return out;
}

function sortJourneys(journeys: Journey[], arriveBy: boolean): Journey[] {
  return [...journeys].sort((a, b) =>
    arriveBy
      ? a.endTime.localeCompare(b.endTime) || b.startTime.localeCompare(a.startTime)
      : a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime) || a.transfers - b.transfers,
  );
}

function maxWalkLegMinutes(journeys: Journey[]): number {
  let m = 0;
  for (const j of journeys) for (const l of j.legs) if (l.mode === "WALK") m = Math.max(m, l.duration);
  return Math.round(m / 60);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

type Attempt = { provider: "transitous" | "google"; walk: number; result: ProviderResult };

export async function plan(input: PlanInput): Promise<PlanResponse> {
  const { from, to, options } = input;
  if (!options.modes.length) throw new PlanError(400, "Pick at least one kind of train");
  const distance = haversine(from, to);
  if (distance < 50)
    throw new PlanError(400, "Start and destination are the same place", "Pick two points at least a short walk apart.");

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const remaining = () => deadline - Date.now();
  const query = (opts: PlanOptions, cursor?: string): ProviderQuery => ({
    from,
    to,
    options: opts,
    cursor,
    language: input.language,
    timeoutMs: Math.max(3000, Math.min(PER_CALL_TIMEOUT_MS, remaining() - 500)),
  });

  const warnings: string[] = [];
  const t0 = Date.now();
  const dbg: string[] = [];
  const note = (m: string) => {
    if (input.debug) dbg.push(`${Date.now() - t0}ms ${m}`);
  };
  let nearbyP: Promise<Nearby> | null = null;
  const requestedWalk = options.maxWalkMinutes;
  let attempt: Attempt | null = null;
  let firstError: unknown = null;

  if (input.cursor) {
    // ---- paging: repeat the original query exactly -------------------------
    const c = decodeCursor(input.cursor);
    const opts = { ...options, maxWalkMinutes: c.w };
    if (c.p === "g") {
      if (!googleEnabled()) throw new PlanError(400, "Invalid paging cursor", "Run the search again.");
      attempt = { provider: "google", walk: c.w, result: await planGoogle(query(opts, c.c)) };
    } else {
      attempt = { provider: "transitous", walk: c.w, result: await planTransitous(query(opts, c.c)) };
    }
    if (c.w > requestedWalk) warnings.push(walkRaisedWarning(requestedWalk, c.w));
  } else {
    // ---- first page: Transitous with walking-limit escalation ---------------
    const walks = [requestedWalk, ...ESCALATION_STEPS.filter((w) => w > requestedWalk && w <= MAX_WALK_MINUTES)];
    for (let i = 0; i < walks.length; i++) {
      const w = walks[i];
      if (i > 0 && remaining() < 5000) break;
      if (i > 0 && nearbyP) {
        // More walking can't help when an endpoint is farther than the largest
        // walk we would try from any station: skip the extra upstream calls.
        const nb = await nearbyP;
        const maxTry = walks[walks.length - 1];
        if (nb.some((l) => l !== undefined && (!l.length || walkMinutesFor(l[0].distance) > maxTry))) {
          note(`skip escalation: endpoint beyond ${maxTry} min walk of any station`);
          break;
        }
      }
      try {
        const result = await planTransitous(query({ ...options, maxWalkMinutes: w }));
        attempt = { provider: "transitous", walk: w, result };
        note(`plan walk=${w}: ${result.journeys.length} journeys`);
        if (result.journeys.length) break;
        // Nothing yet: start looking for nearby stations in parallel with any escalation.
        nearbyP ??= Promise.all(
          [from, to].map((p) => nearbyRailStations(p, options.modes, 4, Math.min(6000, remaining() - 500))),
        );
      } catch (e) {
        note(`plan walk=${w} failed: ${e instanceof Error ? e.message : String(e)}`);
        if (i === 0) firstError = e;
        // A bad date won't improve with more walking, and a struggling provider
        // should not be hammered with escalations: stop at the first error.
        break;
      }
    }

    // ---- fallback: Google (only with a key) ----------------------------------
    if ((!attempt || !attempt.result.journeys.length) && googleEnabled() && remaining() > 3000) {
      try {
        const result = await planGoogle(query(options));
        if (result.journeys.length || !attempt) attempt = { provider: "google", walk: requestedWalk, result };
        if (result.journeys.length)
          warnings.push(
            firstError
              ? "Transitous was unavailable, so these results come from Google Maps."
              : "Transitous had no rail route here, so these results come from Google Maps.",
          );
      } catch (e) {
        if (!attempt && !firstError) firstError = e;
      }
    }

    if (!attempt) {
      if (firstError instanceof PlanError && firstError.status < 500) throw firstError;
      // Trains can't be checked right now, but there is always a way: walk.
      const walking = remaining() > 2000 ? await walkingJourney(input, remaining).catch(() => null) : null;
      if (!walking) {
        if (firstError instanceof PlanError) throw firstError;
        throw new PlanError(502, "Routing service unavailable", firstError instanceof Error ? firstError.message : undefined);
      }
      return {
        journeys: [walking],
        providers: ["transitous"],
        attribution: [...TRANSITOUS_ATTRIBUTION],
        warnings: [
          `Train timetables couldn't be checked right now (${firstError instanceof Error ? firstError.message : "routing unavailable"}), so this shows walking the whole way. Try again in a minute for train options.`,
        ],
        ...(input.debug ? { debug: dbg } : {}),
      };
    }
    if (attempt.provider === "transitous" && attempt.walk > requestedWalk && attempt.result.journeys.length)
      warnings.push(walkRaisedWarning(requestedWalk, attempt.walk, maxWalkLegMinutes(attempt.result.journeys)));
  }

  const { result } = attempt;
  const { kept, dropped } = enforceRailOnly(result.journeys, options.modes);
  let journeys = sortJourneys(dedupe(kept), options.arriveBy);

  // ---- no route: find out whether an endpoint is simply too far from rail ---
  // If one end is just too far to walk within the limit, walk anyway: plan to
  // the nearest station trains reach and add the long walk to the journey.
  let stationHints: StationHint[] | undefined;
  const hadTimetableResults = journeys.length > 0;
  if (!journeys.length && !input.cursor && remaining() > 2500) {
    const r = await explainNoRoute(input, attempt.walk, remaining, note, nearbyP);
    const why = (r.hints ?? [])
      .map((h) => {
        const end = h.which === "to" ? "your destination" : "your start";
        if (!h.station) return `There are no train timetables within about 280 km of ${end}.`;
        const km = Math.round((h.distance ?? 0) / 1000);
        return `The nearest station ${h.reachable ? "with a train connection" : ""} to ${end} is ${h.station.name.replace(/\.$/, "")}, ${km} km away.`.replace("  ", " ");
      })
      .join(" ");
    let walking: Journey | null = null;
    if (remaining() > 2500) walking = await walkingJourney(input, remaining).catch(() => null);
    let trains = r.stitched?.length ? sortJourneys(r.stitched, options.arriveBy) : [];
    // Trains that are far slower than just walking are noise, not options.
    if (walking) trains = trains.filter((j) => j.duration <= walking!.duration * 1.5);
    if (trains.length) {
      const longest = Math.max(...trains[0].legs.filter((l) => l.mode === "WALK").map((l) => l.duration));
      warnings.push(`No station is within walking reach, so these trips include a long walk (up to ${formatDuration(longest)}). ${why}`);
      journeys = trains;
      const est = trains[0].legs.find((l) => l.estimated);
      if (est)
        warnings.push(
          `The train from ${est.from.name} to ${est.to.name} runs on a line whose schedule isn't in the open data, so that leg's time is an estimate (about ${formatDistance(est.distance ?? 0)} at ~65 km/h).`,
        );
      if (walking && walking.duration < trains[0].duration) {
        journeys = [walking, ...trains];
        warnings.push(`Walking the whole way (${formatDistance(walking.walkDistance)}) is faster than any train here.`);
      }
    } else if (walking) {
      journeys = [walking];
      warnings.push(`No train helps on this trip, so the route is to walk the whole way: ${formatDistance(walking.walkDistance)}, about ${formatDuration(walking.duration)}. ${why}`);
    } else stationHints = r.hints;
  }

  if (!journeys.length) {
    const walk = attempt.walk;
    if (result.rejected + dropped > 0)
      warnings.push(
        "The only connections found here use buses, ferries or train types you have switched off, so they are hidden.",
      );
    if (input.cursor) warnings.push("No more train journeys in that direction.");
    // With station hints the UI explains the gap precisely; skip the generic text.
    else if (!stationHints)
      warnings.push(
        `No train journey found${options.time ? " around that time" : ""}, even allowing up to ${walk} min of walking at each end. ` +
          "There may be no rail service nearby, or this region's timetables are not in Transitous yet.",
      );
  }

  if (!input.cursor && result.directWalk && result.directWalk.duration > 0) {
    const fastest = Math.min(...journeys.map((j) => j.duration), Infinity);
    if (result.directWalk.duration <= 20 * 60 || result.directWalk.duration < fastest)
      warnings.push(`Walking the whole way takes about ${formatDuration(result.directWalk.duration)}.`);
  }
  for (const w of result.warnings) warnings.push(w);

  const providerCode = attempt.provider === "google" ? "g" : "t";
  const wrap = (c?: string) => (c ? encodeCursor({ v: 1, p: providerCode, c, w: attempt!.walk }) : undefined);
  // Long-walk and walk-only trips are built here, not paged by the provider.
  const cursors = hadTimetableResults || input.cursor ? { earlier: wrap(result.cursors.earlier), later: wrap(result.cursors.later) } : undefined;

  const first = journeys[0];
  const originTz = result.originTz ?? first?.legs.find((l) => l.from.tz)?.from.tz;
  const destinationTz = result.destinationTz ?? [...(first?.legs ?? [])].reverse().find((l) => l.to.tz)?.to.tz;

  return {
    journeys,
    ...(stationHints ? { stationHints } : {}),
    providers: [attempt.provider],
    attribution: result.attribution,
    warnings: [...new Set(warnings)],
    cursors,
    originTz,
    destinationTz,
    ...(input.debug ? { debug: dbg } : {}),
  };
}

/**
 * When no journey exists, find out why and build the best trip anyway.
 *
 * For each endpoint beyond walking reach of any station, gather a few nearby
 * candidate stations (incl. the nearest mainline one: urban networks often do
 * not connect to intercity trains in the data). Try station pairs nearest
 * first, one request at a time (Transitous rate-limits bursts), and stitch
 * the long walks onto the first rail connection found.
 */
async function explainNoRoute(
  input: PlanInput,
  walk: number,
  remaining: () => number,
  note: (m: string) => void,
  nearbyP: Promise<Nearby> | null,
): Promise<{ hints?: StationHint[]; stitched?: Journey[] }> {
  const { from, to, options } = input;
  const t = Math.min(6000, remaining() - 500);
  const ends = [
    ["from", from],
    ["to", to],
  ] as const;
  const nearby = await (nearbyP ?? Promise.all(ends.map(([, p]) => nearbyRailStations(p, options.modes, 4, t))));
  note(`nearby: ${nearby.map((l) => (l === undefined ? "lookup failed" : l.map((c) => `${c.place.name} ${Math.round(c.distance / 1000)}km`).join(", ") || "none")).join(" | ")}`);

  const hints: StationHint[] = [];
  const cands: Record<"from" | "to", (NearestStation | null)[]> = { from: [null], to: [null] };
  nearby.forEach((list, i) => {
    const which = ends[i][0];
    if (list === undefined) return; // lookup failed: say nothing rather than guess
    if (!list.length) return void hints.push({ which, station: null });
    const n = list[0];
    const walkMinutes = walkMinutesFor(n.distance);
    if (walkMinutes > walk) {
      hints.push({ which, station: n.place, distance: n.distance, walkMinutes });
      // Two nearest plus the nearest mainline station (nearbyRailStations puts it last if needed).
      const top = list.slice(0, 2);
      const last = list[list.length - 1];
      if (list.length > 2 && !top.includes(last)) top.push(last);
      cands[which] = top;
    }
  });
  const allHaveStations = hints.every((h) => h.station);

  // Pairs ordered by total walking distance; at most 5 upstream checks.
  const pairs = cands.from
    .flatMap((a) => cands.to.map((b) => [a, b] as const))
    .sort((x, y) => (x[0]?.distance ?? 0) + (x[1]?.distance ?? 0) - ((y[0]?.distance ?? 0) + (y[1]?.distance ?? 0)))
    .slice(0, 6);
  const railFor = async (a: NearestStation | null, b: NearestStation | null, time: string | null) =>
    enforceRailOnly(
      (
        await planTransitous({
          from: a?.place ?? from,
          to: b?.place ?? to,
          options: { ...options, time, arriveBy: time ? false : options.arriveBy, maxWalkMinutes: walk },
          language: input.language,
          timeoutMs: Math.max(3000, Math.min(PER_CALL_TIMEOUT_MS, remaining() - 500)),
          // Remote lines may run a few times a week: look 3 days ahead.
          searchWindowSec: 3 * 86400,
        })
      ).journeys,
      options.modes,
    ).kept;

  for (const [a, b] of hints.length && allHaveStations ? pairs : []) {
    if (remaining() < 4000) break;
    let rail: Journey[] = [];
    try {
      rail = await railFor(a, b, options.time);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      note(`check ${a?.place.name ?? "start"} → ${b?.place.name ?? "end"} failed: ${msg}`);
      if (/rate-limit/i.test(msg) && remaining() > 5000) {
        await new Promise((r) => setTimeout(r, 1200));
        rail = await railFor(a, b, options.time).catch(() => []);
      }
    }
    note(`check ${a?.place.name ?? "start"} → ${b?.place.name ?? "end"}: ${rail.length}`);
    if (!rail.length) continue;

    for (const [st, which] of [
      [a, "from"],
      [b, "to"],
    ] as const) {
      const h = hints.find((x) => x.which === which);
      if (h && st) Object.assign(h, { station: st.place, distance: st.distance, walkMinutes: walkMinutesFor(st.distance), reachable: true });
    }
    try {
      const stitched = await withLongWalks(input, a?.place ?? null, b?.place ?? null, rail, walk, remaining, note, railFor, a, b);
      if (stitched.length) return { hints, stitched };
    } catch (e) {
      note(`long walk failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { hints };
  }
  // Still nothing: the nearby stations may have no published schedule (e.g.
  // VIA Rail's Canadian is missing from the open data). Relay through a busy
  // hub further out, bridging to it with an estimated train on the line.
  for (const side of ["from", "to"] as const) {
    if (remaining() < 8000) break;
    try {
      const relayed = await relay(input, side, nearby, cands, walk, remaining, note, railFor);
      if (relayed.length) return { hints: hints.length ? hints : undefined, stitched: relayed };
    } catch (e) {
      note(`relay ${side} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const h of hints) if (h.reachable === undefined) h.reachable = false;
  return { hints: hints.length ? hints : undefined };
}

/** Rail distance ≈ 1.35 × straight line; long-distance trains average ~65 km/h with stops. */
function estimatedTrainLeg(a: Place, b: Place, departAt: string): Leg {
  const distance = Math.round(haversine(a, b) * 1.35);
  const duration = Math.round(distance / (65_000 / 3600));
  const start = new Date(departAt).getTime();
  const end = new Date(start + duration * 1000).toISOString();
  return {
    mode: "INTERCITY",
    rawMode: "ESTIMATED",
    estimated: true,
    from: { name: a.name, lat: a.lat, lon: a.lon, departure: departAt },
    to: { name: b.name, lat: b.lat, lon: b.lon, arrival: end },
    startTime: departAt,
    endTime: end,
    duration,
    distance,
    geometry: [
      [a.lon, a.lat],
      [b.lon, b.lat],
    ],
    line: { name: "Train (no timetable)" },
  };
}

/**
 * Reach the stranded `side` through a hub with real service: e.g. Canim Lake,
 * BC → walk to Clearwater (VIA, no schedule in the data) → estimated train to
 * Vancouver → real Amtrak trains onward. Mirrored for a stranded destination.
 */
async function relay(
  input: PlanInput,
  side: "from" | "to",
  nearby: Nearby,
  cands: Record<"from" | "to", (NearestStation | null)[]>,
  walk: number,
  remaining: () => number,
  note: (m: string) => void,
  railFor: (a: NearestStation | null, b: NearestStation | null, time: string | null) => Promise<Journey[]>,
): Promise<Journey[]> {
  const { from, to, options } = input;
  const end = side === "from" ? from : to;
  const hubs = await serviceHubs(end, Math.min(8000, remaining() - 1000));
  note(`relay ${side}: hubs ${hubs.map((h) => `${h.place.name} ${Math.round(h.distance / 1000)}km`).join(", ") || "none"}`);
  if (!hubs.length) return [];
  const local = (nearby[side === "from" ? 0 : 1] ?? [])[0] ?? null; // nearest rail station, served or not
  const pool = side === "from" ? cands.to : cands.from;
  // Prefer the mainline candidate (kept last by explainNoRoute), then the nearest.
  const others = pool.length > 2 ? [pool[pool.length - 1], pool[0]] : pool.slice(0, 2);
  const timeoutMs = () => Math.max(3000, Math.min(PER_CALL_TIMEOUT_MS, remaining() - 500));
  const depart = options.time && !options.arriveBy ? options.time : new Date().toISOString();

  let checks = 0;
  for (const hub of hubs.slice(0, 3)) {
    for (const other of others) {
      if (checks++ >= 5 || remaining() < 6000) return [];
      const [a, b] = side === "from" ? [hub, other] : [other, hub];
      const rail = await railFor(a, b, options.time).catch(() => [] as Journey[]);
      note(`relay check ${a?.place.name ?? "start"} (${a ? `${a.place.lat},${a.place.lon}` : ""}) → ${b?.place.name ?? "end"}: ${rail.length} ${rail.slice(0, 1).map((j) => `${j.startTime} ${Math.round(j.duration / 3600)}h ${j.legs.map((l) => l.line?.name ?? "walk").join(">")}`).join("")}`);
      if (!rail.length) continue;

      const viaLocal = local && local.place.name !== hub.place.name && haversine(local.place, hub.place) > 20_000;
      const endPt = { ...end, name: side === "from" ? "Start" : "Destination" };
      if (side === "from") {
        // Walk → (estimated train) → hub, then the first real trains after arrival.
        const legs: Leg[] = [];
        let t = depart;
        const firstStop = viaLocal ? local!.place : hub.place;
        const w = await walkLeg(endPt, { ...firstStop }, t, timeoutMs());
        legs.push(w);
        t = w.endTime;
        if (viaLocal) {
          const est = estimatedTrainLeg(local!.place, hub.place, t);
          legs.push(est);
          t = est.endTime;
        }
        let onward = (await railFor(hub, other, t).catch(() => [] as Journey[])).slice(0, 3);
        note(`relay onward from ${hub.place.name} after ${t}: ${onward.length}`);
        // Rare trains: no later run in the data yet. Use the run we found and
        // time the approach to arrive just before it (durations still hold).
        const reuse = !onward.length;
        if (reuse) onward = rail.slice(0, 3);
        const tailTo = other ? await walkLeg({ ...other.place }, { ...to, name: "Destination" }, onward[0].endTime, timeoutMs()) : null;
        return onward.map((j) => {
          const lead = reuse ? legs.map((l) => shiftLeg(l, new Date(j.startTime).getTime() - new Date(t).getTime())) : legs;
          const tail = tailTo ? shiftLeg(tailTo, new Date(j.endTime).getTime() - new Date(tailTo.startTime).getTime()) : null;
          return stitchJourney([...lead, ...j.legs, ...(tail ? [tail] : [])], `${j.id}-r`, j.transfers + 1);
        });
      }
      // side === "to": real trains to the hub, then (estimated train) → walk.
      const lead = other ? await walkLeg({ ...from, name: "Start" }, { ...other.place }, depart, timeoutMs()) : null;
      let onward = (await railFor(other, hub, lead ? lead.endTime : options.time).catch(() => [] as Journey[])).slice(0, 3);
      if (!onward.length) onward = rail.slice(0, 3); // rare trains: reuse the run we found
      const out: Journey[] = [];
      for (const j of onward) {
        const legs: Leg[] = [];
        if (lead) legs.push(shiftLeg(lead, new Date(j.startTime).getTime() - new Date(lead.endTime).getTime()));
        legs.push(...j.legs);
        let t = j.endTime;
        const lastStop = viaLocal ? local!.place : hub.place;
        if (viaLocal) {
          const est = estimatedTrainLeg(hub.place, local!.place, t);
          legs.push(est);
          t = est.endTime;
        }
        legs.push(await walkLeg({ ...lastStop }, endPt, t, timeoutMs()));
        out.push(stitchJourney(legs, `${j.id}-r`, j.transfers + 1));
      }
      return out;
    }
  }
  return [];
}

/** Add long walks between stranded endpoints and their stations to rail journeys. */
async function withLongWalks(
  input: PlanInput,
  fromSt: Place | null,
  toSt: Place | null,
  rail: Journey[],
  walk: number,
  remaining: () => number,
  note: (m: string) => void,
  railFor: (a: NearestStation | null, b: NearestStation | null, time: string | null) => Promise<Journey[]>,
  a: NearestStation | null,
  b: NearestStation | null,
): Promise<Journey[]> {
  const { from, to, options } = input;
  const timeoutMs = () => Math.max(3000, Math.min(PER_CALL_TIMEOUT_MS, remaining() - 500));
  let lead: Leg | null = null;
  if (fromSt) {
    // Walk first, then take the trains that leave after you arrive.
    const depart = options.time && !options.arriveBy ? options.time : new Date().toISOString();
    lead = await walkLeg({ ...from, name: "Start" }, { ...fromSt }, depart, timeoutMs());
    note(`long walk from start: ${Math.round(lead.duration / 60)} min`);
    const later = await railFor(a, b, lead.endTime).catch(() => []);
    if (later.length) rail = later;
  }
  let tail: Leg | null = null;
  const out: Journey[] = [];
  for (const j of rail.slice(0, 6)) {
    let legs = [...j.legs];
    if (fromSt && legs[0].mode === "WALK") legs[0] = { ...legs[0], from: { ...legs[0].from, name: fromSt.name } };
    if (toSt && legs[legs.length - 1].mode === "WALK") {
      const l = legs[legs.length - 1];
      legs[legs.length - 1] = { ...l, to: { ...l.to, name: toSt.name } };
    }
    if (lead) {
      const w = shiftLeg(lead, new Date(legs[0].startTime).getTime() - new Date(lead.endTime).getTime());
      legs = [{ ...w, to: { ...w.to, name: fromSt!.name } }, ...legs];
    }
    if (toSt) {
      const end = legs[legs.length - 1].endTime;
      tail ??= await walkLeg({ ...toSt }, { ...to, name: "Destination" }, end, timeoutMs());
      const w = shiftLeg(tail, new Date(end).getTime() - new Date(tail.startTime).getTime());
      legs = [...legs, { ...w, from: { ...w.from, name: toSt.name } }];
    }
    out.push(stitchJourney(legs, `${j.id}-w`, j.transfers));
  }
  if (tail) note(`long walk to destination: ${Math.round(tail.duration / 60)} min`);
  return out;
}

function stitchJourney(legs: Leg[], id: string, transfers: number): Journey {
  const startTime = legs[0].startTime;
  const endTime = legs[legs.length - 1].endTime;
  return { id, provider: "transitous", startTime, endTime, ...journeyTotals(legs, startTime, endTime), transfers, legs };
}

/** Walking the whole way, as a journey. */
async function walkingJourney(input: PlanInput, remaining: () => number): Promise<Journey> {
  const depart = input.options.time && !input.options.arriveBy ? input.options.time : new Date().toISOString();
  const leg = await walkLeg(
    { ...input.from, name: "Start" },
    { ...input.to, name: "Destination" },
    depart,
    Math.max(3000, Math.min(PER_CALL_TIMEOUT_MS, remaining() - 500)),
  );
  const j = stitchJourney([leg], `walk-${Math.round(input.from.lat * 1e4)}-${Math.round(input.to.lat * 1e4)}`, 0);
  return { ...j, transfers: 0 };
}

function shiftLeg(l: Leg, ms: number): Leg {
  const sh = (iso?: string) => (iso ? new Date(new Date(iso).getTime() + ms).toISOString() : iso);
  return {
    ...l,
    startTime: sh(l.startTime)!,
    endTime: sh(l.endTime)!,
    from: { ...l.from, departure: sh(l.from.departure) },
    to: { ...l.to, arrival: sh(l.to.arrival) },
  };
}

function walkRaisedWarning(requested: number, used: number, longest?: number): string {
  const tail = longest && longest > requested ? ` The longest walk below is ${longest} min.` : "";
  return `No rail route within a ${requested}-min walk, so the walking limit was raised to ${used} min.${tail}`;
}
