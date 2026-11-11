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
import type { Journey, LatLon, Leg, PlanOptions, PlanResponse, RailMode } from "./types";
import { ALL_RAIL_MODES, DEFAULT_MAX_WALK_MINUTES, DEFAULT_MODES, isRailMode } from "./modes";
import { formatDuration, haversine } from "./format";
import { PlanError } from "./routing/http";
import type { ProviderQuery, ProviderResult } from "./routing/provider";
import { planTransitous, TRANSITOUS_MAX_PREPOST_SECONDS } from "./providers/transitous";
import { googleEnabled, planGoogle } from "./providers/google";

export { PlanError } from "./routing/http";

export type PlanInput = {
  from: LatLon;
  to: LatLon;
  options: PlanOptions;
  /** Opaque cursor previously returned in PlanResponse.cursors. */
  cursor?: string;
  /** Language for station/line names, e.g. "en". */
  language?: string;
};

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
      try {
        const result = await planTransitous(query({ ...options, maxWalkMinutes: w }));
        attempt = { provider: "transitous", walk: w, result };
        if (result.journeys.length) break;
      } catch (e) {
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
  const journeys = sortJourneys(dedupe(kept), options.arriveBy);

  if (!journeys.length) {
    const walk = attempt.walk;
    if (result.rejected + dropped > 0)
      warnings.push(
        "The only connections found here use buses, ferries or train types you have switched off, so they are hidden.",
      );
    if (!input.cursor)
      warnings.push(
        `No train journey found${options.time ? " around that time" : ""}, even allowing up to ${walk} min of walking at each end. ` +
          "There may be no rail service nearby, or this region's timetables are not in Transitous yet.",
      );
    else warnings.push("No more train journeys in that direction.");
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
    providers: [attempt.provider],
    attribution: result.attribution,
    warnings: [...new Set(warnings)],
    cursors,
    originTz,
    destinationTz,
  };
}

function walkRaisedWarning(requested: number, used: number, longest?: number): string {
  const tail = longest && longest > requested ? ` The longest walk below is ${longest} min.` : "";
  return `No rail route within a ${requested}-min walk, so the walking limit was raised to ${used} min.${tail}`;
}
