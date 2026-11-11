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
import { formatDuration, haversine } from "./format";
import { PlanError } from "./routing/http";
import type { ProviderQuery, ProviderResult } from "./routing/provider";
import { planTransitous, TRANSITOUS_MAX_PREPOST_SECONDS, walkLeg } from "./providers/transitous";
import { journeyTotals } from "./journey";
import { googleEnabled, planGoogle } from "./providers/google";
import { nearbyRailStations, walkMinutesFor, type NearestStation } from "./routing/nearest";

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
/** Overall budget for one /api/plan call (Vercel maxDuration is 30 s). */
const TOTAL_BUDGET_MS = 24_000;
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
      if (firstError instanceof PlanError) throw firstError;
      throw new PlanError(502, "Routing service unavailable", firstError instanceof Error ? firstError.message : undefined);
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
  if (!journeys.length && !input.cursor && remaining() > 2500) {
    const r = await explainNoRoute(input, attempt.walk, remaining, note, nearbyP);
    if (r.stitched?.length) {
      journeys = sortJourneys(r.stitched, options.arriveBy);
      const h = r.hints!.find((x) => x.reachable)!;
      const w = journeys[0].legs[h.which === "to" ? journeys[0].legs.length - 1 : 0];
      warnings.push(
        `No station is within walking reach of your ${h.which === "to" ? "destination" : "start"}, so these trips ` +
          `${h.which === "to" ? "end" : "start"} with a ${formatDuration(w.duration)} walk (${Math.round((w.distance ?? 0) / 100) / 10} km) ` +
          `${h.which === "to" ? "from" : "to"} ${h.station!.name.replace(/\.$/, "")}.`,
      );
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
  const cursors = journeys.length || input.cursor ? { earlier: wrap(result.cursors.earlier), later: wrap(result.cursors.later) } : undefined;

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
 * When no journey exists, check whether an endpoint is beyond walking reach of
 * any station. If exactly one endpoint is stranded, plan to (or from) a few
 * stations near it in parallel and suggest the nearest one trains really reach:
 * the nearest station is often on a network that doesn't connect (e.g. Amtrak
 * reaches Gainesville, GA, but no data links it to Atlanta's MARTA).
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

  const hints: (StationHint & { candidates?: NearestStation[] })[] = [];
  nearby.forEach((list, i) => {
    const which = ends[i][0];
    if (list === undefined) return; // lookup failed: say nothing rather than guess
    if (!list.length) return void hints.push({ which, station: null });
    const n = list[0];
    const walkMinutes = walkMinutesFor(n.distance);
    if (walkMinutes > walk)
      hints.push({ which, station: n.place, distance: n.distance, walkMinutes, candidates: list });
  });
  if (!hints.length) return {};
  let stitched: Journey[] | undefined;

  const stranded = hints.filter((h) => h.station);
  if (stranded.length === 1 && hints.length === 1 && remaining() > 4000) {
    const h = stranded[0];
    const timeoutMs = Math.max(3000, Math.min(PER_CALL_TIMEOUT_MS, remaining() - 500));
    // One at a time, nearest first: Transitous rate-limits bursts (seen from
    // Vercel's shared egress IPs), and we can stop at the first reachable one.
    const tries: (Journey[] | null | undefined)[] = h.candidates!.map(() => undefined);
    const check = async (c: NearestStation) =>
      enforceRailOnly(
        (
          await planTransitous({
            from: h.which === "to" ? from : c.place,
            to: h.which === "to" ? c.place : to,
            options: { ...options, maxWalkMinutes: walk },
            language: input.language,
            timeoutMs: Math.max(3000, Math.min(PER_CALL_TIMEOUT_MS, remaining() - 500)),
          })
        ).journeys,
        options.modes,
      ).kept;
    for (let i = 0; i < h.candidates!.length && remaining() > 3500; i++) {
      const c = h.candidates![i];
      try {
        tries[i] = await check(c);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        note(`verify ${c.place.name} failed: ${msg}`);
        tries[i] = null;
        if (/rate-limit/i.test(msg) && remaining() > 5000) {
          await new Promise((r) => setTimeout(r, 1200));
          try {
            tries[i] = await check(c);
          } catch (e2) {
            note(`verify ${c.place.name} retry failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
          }
        }
      }
      if (tries[i]?.length) break;
    }
    note(`verify: ${tries.map((k, i) => `${h.candidates![i].place.name}=${k === undefined ? "skipped" : k === null ? "error" : k.length}`).join(", ")}`);
    const idx = tries.findIndex((k) => k && k.length);
    if (idx >= 0) {
      const c = h.candidates![idx];
      const best = tries[idx]!.reduce((a, b) => (b.duration < a.duration ? b : a));
      Object.assign(h, {
        station: c.place,
        distance: c.distance,
        walkMinutes: walkMinutesFor(c.distance),
        reachable: true,
        duration: best.duration,
        lines: [...new Set(best.legs.filter((l) => l.line).map((l) => l.line!.name))],
      });
      if (remaining() > 3000) {
        try {
          stitched = await withLongWalk(input, h.which, c.place, tries[idx]!, walk, remaining, note);
        } catch (e) {
          note(`long walk failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else if (tries.every((k) => Array.isArray(k))) {
      h.reachable = false; // every candidate answered, none reachable
    }
  }
  return { hints: hints.map(({ candidates: _c, ...h }) => h), stitched };
}

/** Add the long walk between a stranded endpoint and `station` to journeys that reach the station. */
async function withLongWalk(
  input: PlanInput,
  which: "from" | "to",
  station: Place,
  toStation: Journey[],
  walk: number,
  remaining: () => number,
  note: (m: string) => void,
): Promise<Journey[]> {
  const { from, to, options } = input;
  const timeoutMs = Math.max(3000, Math.min(PER_CALL_TIMEOUT_MS, remaining() - 500));
  const st = { ...station };
  const stitch = (legs: Leg[], id: string, transfers: number): Journey => {
    const startTime = legs[0].startTime;
    const endTime = legs[legs.length - 1].endTime;
    return { id, provider: "transitous", startTime, endTime, ...journeyTotals(legs, startTime, endTime), transfers, legs };
  };
  // The station-side leg of the rail journey ends/starts at the station itself.
  const rename = (l: Leg, end: "from" | "to"): Leg => ({ ...l, [end]: { ...l[end], name: st.name } });

  if (which === "to") {
    const out: Journey[] = [];
    let template: Leg | null = null;
    for (const j of toStation.slice(0, 6)) {
      const legs = j.legs.map((l, i) => (i === j.legs.length - 1 && l.mode === "WALK" ? rename(l, "to") : l));
      const tail = legs[legs.length - 1];
      template ??= await walkLeg(st, { ...to, name: "Destination" }, tail.endTime, timeoutMs);
      const shift = new Date(tail.endTime).getTime() - new Date(template.startTime).getTime();
      const w = shiftLeg(template, shift);
      w.from = { ...w.from, name: st.name };
      out.push(stitch([...legs, w], `${j.id}-w`, j.transfers));
    }
    note(`long walk to destination: ${template ? Math.round(template.duration / 60) : "?"} min`);
    return out;
  }

  // Stranded start: walk first, then catch trains from the station.
  const depart = options.time && !options.arriveBy ? options.time : new Date().toISOString();
  const w = await walkLeg({ ...from, name: "Start" }, st, depart, timeoutMs);
  note(`long walk from start: ${Math.round(w.duration / 60)} min`);
  const r = await planTransitous({
    from: st,
    to,
    options: { ...options, time: w.endTime, arriveBy: false, maxWalkMinutes: walk },
    language: input.language,
    timeoutMs: Math.max(3000, Math.min(PER_CALL_TIMEOUT_MS, remaining() - 500)),
  });
  return enforceRailOnly(r.journeys, options.modes)
    .kept.slice(0, 6)
    .map((j) => {
      const legs = j.legs.map((l, i) => (i === 0 && l.mode === "WALK" ? rename(l, "from") : l));
      const first = new Date(legs[0].startTime).getTime();
      const lead = shiftLeg(w, first - new Date(w.endTime).getTime());
      lead.to = { ...lead.to, name: st.name };
      return stitch([lead, ...legs], `${j.id}-w`, j.transfers);
    });
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
