/**
 * Rail classification + line labelling shared by all providers.
 *
 * The single most important rule of Only Trains lives here: a leg is only ever
 * accepted if it is WALK or a positively identified rail mode. Anything we
 * cannot positively identify as rail is rejected (fail closed).
 */
import type { LegMode, RailMode } from "../types";

// ---------------------------------------------------------------------------
// MOTIS (Transitous) modes
// ---------------------------------------------------------------------------

/**
 * MOTIS transit modes requested for each Only Trains category.
 * Source: MOTIS openapi.yaml `Mode` (v2.11.x). Notes:
 *  - `RAIL` is a MOTIS alias for HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,SUBURBAN,SUBWAY,
 *    so we never send it (it would silently enable SUBWAY).
 *  - `METRO` is a deprecated (<= v4) name for SUBURBAN; `REGIONAL_FAST_RAIL` is deprecated → REGIONAL_RAIL.
 *  - INTERCITY also pulls REGIONAL_RAIL because GTFS route_type 2 ("Rail") is mapped to REGIONAL_RAIL
 *    by nigiri; we re-classify those legs (Amtrak/VIA/... names) and post-filter.
 *  - OTHER_RAIL pulls `OTHER` because nigiri maps monorail (GTFS 12 / 405) to OTHER; non-monorail
 *    OTHER legs (elevators, drag lifts, horse carriages, unknown types) are rejected by routeType.
 */
export const MOTIS_MODES_FOR: Record<RailMode, string[]> = {
  SUBWAY: ["SUBWAY"],
  COMMUTER: ["SUBURBAN", "REGIONAL_RAIL", "REGIONAL_FAST_RAIL"],
  INTERCITY: ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "REGIONAL_RAIL"],
  LIGHT_RAIL: ["TRAM"],
  OTHER_RAIL: ["FUNICULAR", "OTHER"],
};

/** MOTIS modes that are never acceptable, even if a server returns them. */
const MOTIS_FORBIDDEN = new Set([
  "BUS",
  "COACH",
  "FERRY",
  "AIRPLANE",
  "AERIAL_LIFT",
  "AREAL_LIFT",
  "CABLE_CAR", // deprecated MOTIS alias for aerial lift
  "ODM",
  "RIDE_SHARING",
  "FLEX",
  "RENTAL",
  "BIKE",
  "CAR",
  "HGV",
  "CAR_PARKING",
  "CAR_DROPOFF",
  "DEBUG_BUS_ROUTE",
  "DEBUG_FERRY_ROUTE",
  "DEBUG_RAILWAY_ROUTE",
]);

export function motisTransitModes(modes: RailMode[]): string[] {
  const set = new Set<string>();
  for (const m of modes) for (const x of MOTIS_MODES_FOR[m]) set.add(x);
  return [...set];
}

/** GTFS (basic + extended) route types that are positively rail. */
export function railModeFromRouteType(rt: number | undefined): RailMode | null {
  if (rt === undefined || rt === null || !Number.isFinite(rt)) return null;
  switch (rt) {
    case 0:
      return "LIGHT_RAIL"; // tram / streetcar / light rail
    case 1:
      return "SUBWAY";
    case 2:
      return "COMMUTER"; // "Rail" – refined by name heuristics
    case 5:
    case 7:
    case 12:
      return "OTHER_RAIL"; // cable tram, funicular, monorail
  }
  if (rt === 101 || rt === 102 || rt === 104 || rt === 105 || rt === 114) return "INTERCITY";
  if (rt >= 100 && rt <= 117) return rt === 116 ? "OTHER_RAIL" : "COMMUTER";
  if (rt === 400 || rt === 401 || rt === 402) return "SUBWAY";
  if (rt === 403 || rt === 404) return "COMMUTER";
  if (rt === 405) return "OTHER_RAIL"; // monorail
  if (rt >= 900 && rt <= 906) return "LIGHT_RAIL";
  if (rt === 1400) return "OTHER_RAIL"; // funicular
  return null; // buses (3, 11, 200s, 700s, 800), ferries, air, aerial lifts (6, 1300s), taxis, misc
}

export type RailContext = {
  rawMode: string;
  /** Source feed file as reported by MOTIS `leg.source`, e.g. "kr_korea.gtfs.zip/stop_times.txt:12". */
  feed?: string;
  routeType?: number;
  agency?: string;
  shortName?: string;
  longName?: string;
  displayName?: string;
  tripShortName?: string;
  category?: string;
};

/**
 * Names that betray a road vehicle or boat masquerading under a rail route type.
 * Strong terms are checked in every name field; weak terms ("bus", "ferry") only in the
 * short/display/category names because long names often list destinations ("Ferry Building").
 */
const ROAD_STRONG_RE =
  /\b(schienenersatzverkehr|ersatzverkehr|SEV|rail replacement|replacement bus|bus replacement|thruway|autocar|autobus|bus de substitution)\b/i;
const ROAD_WEAK_RE = /\b(bus|buses|coach|ferry|boat|bateau|shuttle bus)\b/i;

export function looksLikeRoadVehicle(ctx: Pick<RailContext, "shortName" | "longName" | "displayName" | "category">): boolean {
  const strong = [ctx.shortName, ctx.longName, ctx.displayName, ctx.category].filter(Boolean).join(" | ");
  const weak = [ctx.shortName, ctx.displayName, ctx.category].filter(Boolean).join(" | ");
  return ROAD_STRONG_RE.test(strong) || ROAD_WEAK_RE.test(weak);
}

/** Known intercity brands that often hide under GTFS route_type 2 / REGIONAL_RAIL. */
const INTERCITY_CODE_RE = /\b(ICE|ICE ?\d+|IC|IC ?\d+|ICN|EC|ECE|EN|RJ|RJX|TGV|OUIGO|AVE|AVLO|KTX|THSR)\b/; // case-sensitive
const INTERCITY_WORD_RE =
  /\b(inoui|intercit[eé]s?|intercity|eurocity|euronight|euromed|thalys|eurostar|frecciarossa|frecciargento|frecciabianca|italo|alvia|iryo|avant|acela|northeast regional|amtrak|brightline|via rail|shinkansen|sapsan|pendolino|railjet|nightjet|westbahn|sn[aä]llt[aå]get|talgo|lyntog)\b/i;
const INTERCITY_AGENCY_RE =
  /\b(amtrak|via rail|brightline|eurostar|thalys|ouigo|italo|ntv|iryo|jr central|db fernverkehr|sncf voyageurs|indian railways)\b/i;

export function looksIntercity(names: string, agency?: string): boolean {
  return INTERCITY_CODE_RE.test(names) || INTERCITY_WORD_RE.test(names) || INTERCITY_AGENCY_RE.test(agency ?? "");
}

/**
 * Known feed-level data errors in Transitous sources (checked against `leg.source`).
 * Each entry rejects the given MOTIS modes from that feed outright.
 */
const FEED_RULES: { feed: RegExp; modes: string[]; why: string }[] = [
  // Seen Nov 2026: Seoul city buses 402/421/3422/9301 come back as TRAM with route_type 0.
  { feed: /^kr_korea\.gtfs/i, modes: ["TRAM"], why: "Korea (KTDB) feed types city buses as trams" },
];

export function feedRejects(feed: string | undefined, rawMode: string): string | null {
  if (!feed) return null;
  const m = rawMode.toUpperCase();
  for (const r of FEED_RULES) if (r.feed.test(feed) && r.modes.includes(m)) return r.why;
  return null;
}

/**
 * Map a MOTIS leg mode (plus GTFS route type) to an Only Trains RailMode.
 * Returns null when the leg is not rail (and therefore must be rejected).
 */
export function classifyMotisLeg(ctx: RailContext): LegMode | null {
  const m = (ctx.rawMode || "").toUpperCase();
  if (m === "WALK") return "WALK";
  if (MOTIS_FORBIDDEN.has(m)) return null;
  if (feedRejects(ctx.feed, m)) return null;

  let mode: RailMode | null;
  switch (m) {
    case "SUBWAY":
      mode = "SUBWAY";
      break;
    case "METRO": // <= v4 name for SUBURBAN
    case "SUBURBAN":
    case "REGIONAL_RAIL":
    case "REGIONAL_FAST_RAIL":
      mode = "COMMUTER";
      break;
    case "HIGHSPEED_RAIL":
    case "LONG_DISTANCE":
    case "NIGHT_RAIL":
      mode = "INTERCITY";
      break;
    case "TRAM":
      mode = "LIGHT_RAIL";
      break;
    case "FUNICULAR":
      mode = "OTHER_RAIL";
      break;
    case "RAIL":
      mode = railModeFromRouteType(ctx.routeType) ?? "COMMUTER";
      break;
    case "OTHER":
      // Only monorails are acceptable here (nigiri maps GTFS 12 / 405 to OTHER).
      mode = ctx.routeType === 12 || ctx.routeType === 405 ? "OTHER_RAIL" : null;
      if (!mode && /\b(monorail|schwebebahn)\b/i.test(`${ctx.shortName ?? ""} ${ctx.longName ?? ""} ${ctx.displayName ?? ""}`))
        mode = "OTHER_RAIL";
      break;
    default:
      mode = null; // unknown future mode: fail closed
  }
  if (!mode) return null;

  // If the GTFS route type positively says "not rail", trust it over the mode.
  if (ctx.routeType !== undefined && ctx.routeType !== null && railModeFromRouteType(ctx.routeType) === null) {
    // e.g. a feed that typed buses as 700 but MOTIS put them in an odd class
    return null;
  }
  if (looksLikeRoadVehicle(ctx)) return null;

  // Refine generic "regional" rail that is really intercity (GTFS route_type 2 Amtrak/VIA etc.).
  if (mode === "COMMUTER" && m !== "SUBURBAN" && m !== "METRO") {
    const names = `${ctx.shortName ?? ""} ${ctx.displayName ?? ""} ${ctx.longName ?? ""} ${ctx.category ?? ""}`;
    if (looksIntercity(names, ctx.agency)) mode = "INTERCITY";
  }
  return mode;
}

// ---------------------------------------------------------------------------
// Google Routes vehicle types
// ---------------------------------------------------------------------------

/** Google `TransitVehicle.TransitVehicleType` → RailMode, null = not rail. */
export function classifyGoogleVehicle(type: string | undefined, names: string): RailMode | null {
  let mode: RailMode | null;
  switch ((type || "").toUpperCase()) {
    case "SUBWAY":
    case "METRO_RAIL":
      mode = "SUBWAY";
      break;
    case "COMMUTER_TRAIN":
    case "HEAVY_RAIL":
    case "RAIL":
      mode = "COMMUTER";
      break;
    case "HIGH_SPEED_TRAIN":
    case "LONG_DISTANCE_TRAIN":
      mode = "INTERCITY";
      break;
    case "TRAM":
      mode = "LIGHT_RAIL";
      break;
    case "MONORAIL":
    case "FUNICULAR":
    case "CABLE_CAR": // Google: cable-hauled vehicle on the ground (e.g. SF cable car); aerial = GONDOLA_LIFT
      mode = "OTHER_RAIL";
      break;
    default:
      mode = null; // BUS, INTERCITY_BUS, TROLLEYBUS, SHARE_TAXI, FERRY, GONDOLA_LIFT, OTHER, unspecified
  }
  if (!mode) return null;
  if (ROAD_STRONG_RE.test(names) || ROAD_WEAK_RE.test(names)) return null;
  if (mode === "COMMUTER" && looksIntercity(names)) mode = "INTERCITY";
  return mode;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

export type LabelInput = {
  mode: RailMode;
  rawMode?: string;
  shortName?: string;
  longName?: string;
  displayName?: string;
  tripShortName?: string;
  agency?: string;
  category?: string;
};

/**
 * Pick the most recognizable label for a line, e.g.
 *   CTA            "" / "Blue Line"                → "Blue Line"
 *   Paris RER      "C" (agency "RER")              → "RER C"
 *   Paris Métro    "1" (agency "RATP")             → "Line 1"
 *   NYC Subway     "B" / "6 Avenue Express"        → "B"
 *   Tokyo          "G" / "Tokyo Metro Ginza Line"  → "Tokyo Metro Ginza Line"
 *   London         "Northern" (London Underground) → "Northern line"
 *   SNCF           "" / "" / "TGV INOUI 6621"      → "TGV INOUI 6621"
 *   Trenitalia     "FR" / "Frecciarossa" / "FR 9287" → "FR 9287"
 *   Amtrak         "" / "Acela" / "2148"           → "Acela"
 */
export function lineLabel(i: LabelInput): string {
  const sn = clean(i.shortName);
  const ln = clean(i.longName);
  const dn = clean(i.displayName);
  const tsn = clean(i.tripShortName);
  const agency = clean(i.agency);

  // Intercity trains are best known by product + number ("ICE 597", "TGV INOUI 6621").
  if (i.mode === "INTERCITY" && dn && /\d/.test(dn) && /[A-Za-zÀ-ɏ]/.test(dn)) return stripParenNumber(dn);

  // Train-number "short names" (Indian Railways "11078" / "JHELUM EXPRESS"): the name is the long name.
  if (/^\d{4,6}$/.test(sn) && ln) return ln;

  if (sn && ln) {
    const lnHasSn = new RegExp(`(^|[\\s(])${escapeRe(sn)}($|[\\s)])`, "i").test(ln);
    if (lnHasSn && ln.length <= 28) return ln; // "RER A", "Línea 1", "S1 Airport Line"
    if (sn.length <= 3 && /\b(line|linie|ligne|línea|linea|linha|lijn|線|号線|호선)\b|線$/i.test(ln) && ln.length <= 40) return ln;
    return decorateShort(sn, i.mode, agency);
  }
  if (sn) return decorateShort(sn, i.mode, agency);
  if (ln) return ln;
  if (dn) return stripParenNumber(dn);
  if (tsn) return tsn;
  if (i.category) return clean(i.category);
  if (agency) return agency;
  return MODE_WORD[i.mode];
}

const MODE_WORD: Record<RailMode, string> = {
  SUBWAY: "Metro",
  COMMUTER: "Train",
  INTERCITY: "Train",
  LIGHT_RAIL: "Tram",
  OTHER_RAIL: "Rail",
};

const BRAND_AGENCY_RE =
  /^(RER|Transilien|TER|MRT|LRT|MTR|BTS|KRL|S-Bahn|U-Bahn|Subte|Luas|DART|MAX|TRAX|Metrolink|Muni Metro|Tramway|Tram)$/i;

function decorateShort(sn: string, mode: RailMode, agency: string): string {
  if (/london underground/i.test(agency) && /^[A-Z][a-z]+( (&|and) [A-Z][a-z]+)?$/.test(sn)) return `${sn} line`;
  const tiny = sn.length <= 2 || /^\d{1,3}[a-z]?$/i.test(sn);
  if (!tiny) return sn; // "S7", "RE1", "U2", "Elizabeth line", "DLR"
  // Agencies that are really line brands read well as a prefix: "RER C", "Transilien L", "MRT 1".
  if (BRAND_AGENCY_RE.test(agency)) return `${agency} ${sn}`;
  if (/^\d{1,3}[a-z]?$/i.test(sn)) {
    if (mode === "LIGHT_RAIL") return `Tram ${sn}`;
    if (mode === "SUBWAY") return `Line ${sn}`;
  }
  return sn; // NYC "B", Tokyo "G" with no long name
}

/** Train number label, e.g. "Amtrak 351", "ICE 597", "LIRR 2869". Only when meaningful. */
export function tripLabel(i: LabelInput): string | undefined {
  const dn = clean(i.displayName);
  const sn = clean(i.shortName);
  const tsn = clean(i.tripShortName).replace(/^0+(?=\d)/, "");
  const raw = (i.rawMode || "").toUpperCase();
  const numbered = /^\d{1,6}$/.test(tsn);
  // Metro / tram / S-Bahn trip numbers are internal; skip them.
  if (i.mode === "SUBWAY" || i.mode === "LIGHT_RAIL" || i.mode === "OTHER_RAIL" || raw === "SUBURBAN") return undefined;
  if (i.mode === "INTERCITY" && dn && /\d/.test(dn) && /[A-Za-z]/.test(dn)) return stripParenNumber(dn);
  if (/^\d{4,6}$/.test(sn)) return `Train ${sn}`;
  if (!numbered) return undefined;
  if (i.mode === "COMMUTER" && sn) return undefined; // "RE1" trips: number is noise
  const agency = clean(i.agency);
  const prefix = sn || clean(i.category) || shortAgency(agency) || "Train";
  return `${prefix} ${tsn}`;
}

function shortAgency(a: string): string {
  if (!a) return "";
  if (/long island rail ?road/i.test(a)) return "LIRR";
  if (/metro-?north/i.test(a)) return "Metro-North";
  if (/new jersey transit|nj ?transit/i.test(a)) return "NJ Transit";
  if (a.length <= 14) return a;
  return "Train";
}

function stripParenNumber(s: string): string {
  // MOTIS formats some regional trips as "RE1 (73778)" – keep it readable.
  return s.replace(/\s*\((\d+)\)\s*$/, " $1").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** RER "mission codes" (VACK, KOHL...) are not destinations. */
export function cleanHeadsign(headsign: string | undefined, tripTo: string | undefined): string | undefined {
  const h = clean(headsign);
  const t = clean(tripTo);
  if (!h) return t || undefined;
  if (/^[A-Z]{4}$/.test(h) && t) return t;
  return h;
}
