/**
 * Turn normalized journeys into the GeoJSON the map draws. Pure functions:
 * no MapLibre, no DOM, so they are cheap to memoize and easy to test.
 */
import type { Feature, FeatureCollection, LineString, MultiLineString, Point } from "geojson";
import type { Journey, Leg, StopTime } from "@/lib/types";
import { MODE_FALLBACK_COLOR } from "@/lib/modes";
import { formatClock, normalizeColor, readableTextColor } from "@/lib/format";
import { type Bounds, type Coord, boundsOf, lineLength, metersBetween, pointAlong } from "./geo";

export const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/** Perceived lightness 0..1 (same weighting as readableTextColor). */
function lightness(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function legColor(leg: Leg): string {
  return normalizeColor(leg.line?.color) ?? MODE_FALLBACK_COLOR[leg.mode];
}

/**
 * Casing that keeps a line visible on each basemap: pale lines (yellow, cyan)
 * get an ink outline on the light map; very dark lines (navy, brown) get a
 * pale outline on the dark map. Everything else gets a basemap-colored halo.
 */
export function casingFor(color: string): { light: string; dark: string } {
  const l = lightness(color);
  return {
    light: l > 0.62 ? "#26282d" : "#ffffff",
    dark: l < 0.3 ? "#d6d6d1" : "#0b0c0e",
  };
}

// ---------------------------------------------------------------------------
// Selected journey: legs
// ---------------------------------------------------------------------------

export type LegProps = {
  legIndex: number;
  walk: boolean;
  color: string;
  casingLight: string;
  casingDark: string;
};

function legLine(leg: Leg): Coord[] {
  const g = leg.geometry?.filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1])) ?? [];
  if (g.length >= 2) return g as Coord[];
  // No geometry from the provider: fall back to a straight segment.
  return [
    [leg.from.lon, leg.from.lat],
    [leg.to.lon, leg.to.lat],
  ];
}

export function buildLegs(journey: Journey | null): FeatureCollection<LineString, LegProps> {
  if (!journey) return EMPTY_FC as FeatureCollection<LineString, LegProps>;
  const features: Feature<LineString, LegProps>[] = journey.legs.map((leg, i) => {
    const color = leg.mode === "WALK" ? MODE_FALLBACK_COLOR.WALK : legColor(leg);
    const casing = casingFor(color);
    return {
      type: "Feature",
      id: i,
      geometry: { type: "LineString", coordinates: legLine(leg) },
      properties: { legIndex: i, walk: leg.mode === "WALK", color, casingLight: casing.light, casingDark: casing.dark },
    };
  });
  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------------------
// Selected journey: stations
// ---------------------------------------------------------------------------

export type StopRole = "major" | "minor";
export type StopKind = "board" | "alight" | "transfer" | "pass";

export type StopProps = {
  role: StopRole;
  kind: StopKind;
  name: string;
  /** Comma-wrapped leg indices, e.g. ",1,2,3," — matched with an `in` expression. */
  legs: string;
  color: string;
  /** Second label line, e.g. "9:47 PM" or "9:56 → 10:01 PM". */
  time: string;
  arr: string;
  dep: string;
  tz: string;
  track: string;
  /** Sort key: majors first. */
  rank: number;
};

type MajorStop = {
  coord: Coord;
  name: string;
  legs: Set<number>;
  arrival?: StopTime;
  departure?: StopTime;
};

const MERGE_SAME_NAME_M = 250;
const MERGE_ANY_NAME_M = 60;

function findMajor(list: MajorStop[], s: StopTime): MajorStop | undefined {
  const c: Coord = [s.lon, s.lat];
  return list.find((m) => {
    const d = metersBetween(m.coord, c);
    return d < MERGE_ANY_NAME_M || (d < MERGE_SAME_NAME_M && m.name === s.name);
  });
}

function clock(st: StopTime | undefined, which: "arrival" | "departure"): string {
  if (!st) return "";
  return formatClock(which === "arrival" ? st.arrival ?? st.departure : st.departure ?? st.arrival, st.tz);
}

export function buildStops(journey: Journey | null): FeatureCollection<Point, StopProps> {
  if (!journey) return EMPTY_FC as FeatureCollection<Point, StopProps>;
  const majors: MajorStop[] = [];
  const minors: Feature<Point, StopProps>[] = [];

  journey.legs.forEach((leg, i) => {
    if (leg.mode === "WALK") return;
    const color = legColor(leg);

    const board = findMajor(majors, leg.from);
    if (board) {
      board.legs.add(i);
      board.departure = leg.from;
    } else {
      majors.push({ coord: [leg.from.lon, leg.from.lat], name: leg.from.name, legs: new Set([i]), departure: leg.from });
    }
    const alight = findMajor(majors, leg.to);
    if (alight) {
      alight.legs.add(i);
      alight.arrival = leg.to;
    } else {
      majors.push({ coord: [leg.to.lon, leg.to.lat], name: leg.to.name, legs: new Set([i]), arrival: leg.to });
    }

    for (const s of leg.intermediateStops ?? []) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
      minors.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: {
          role: "minor",
          kind: "pass",
          name: s.name,
          legs: `,${i},`,
          color,
          time: clock(s, "departure"),
          arr: s.arrival ?? "",
          dep: s.departure ?? "",
          tz: s.tz ?? "",
          track: s.track ?? "",
          rank: 2,
        },
      });
    }
  });

  // Walks that start or end at a station belong to it too (for hover emphasis).
  journey.legs.forEach((leg, i) => {
    if (leg.mode !== "WALK") return;
    findMajor(majors, leg.from)?.legs.add(i);
    findMajor(majors, leg.to)?.legs.add(i);
  });

  const majorFeatures: Feature<Point, StopProps>[] = majors.map((m) => {
    const kind: StopKind = m.arrival && m.departure ? "transfer" : m.departure ? "board" : "alight";
    const arr = clock(m.arrival, "arrival");
    const dep = clock(m.departure, "departure");
    const time = kind === "transfer" ? (arr === dep ? dep : `${arr} → ${dep}`) : kind === "board" ? dep : arr;
    const ref = m.departure ?? m.arrival;
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: m.coord },
      properties: {
        role: "major",
        kind,
        name: m.name,
        legs: `,${[...m.legs].sort((a, b) => a - b).join(",")},`,
        color: "#000000",
        time,
        arr: m.arrival?.arrival ?? m.arrival?.departure ?? "",
        dep: m.departure?.departure ?? m.departure?.arrival ?? "",
        tz: ref?.tz ?? "",
        track: m.departure?.track ?? m.arrival?.track ?? "",
        rank: 1,
      },
    };
  });

  return { type: "FeatureCollection", features: [...minors, ...majorFeatures] };
}

// ---------------------------------------------------------------------------
// Other journeys (muted, clickable)
// ---------------------------------------------------------------------------

export type AltProps = { journeyId: string; fid: number };

export function buildAlternatives(journeys: Journey[], selectedId: string | null): FeatureCollection<MultiLineString, AltProps> {
  const features: Feature<MultiLineString, AltProps>[] = [];
  journeys.forEach((j, idx) => {
    if (j.id === selectedId) return;
    features.push({
      type: "Feature",
      id: idx + 1,
      geometry: { type: "MultiLineString", coordinates: j.legs.map(legLine) },
      properties: { journeyId: j.id, fid: idx + 1 },
    });
  });
  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------------------
// Line badges
// ---------------------------------------------------------------------------

export type Badge = {
  key: string;
  legIndex: number;
  coord: Coord;
  label: string;
  title: string;
  color: string;
  textColor: string;
};

export function buildBadges(journey: Journey | null): Badge[] {
  if (!journey) return [];
  const out: Badge[] = [];
  journey.legs.forEach((leg, i) => {
    if (leg.mode === "WALK") return;
    const line = legLine(leg);
    const at = pointAlong(line, 0.5);
    if (!at) return;
    const color = legColor(leg);
    const label = leg.line?.name || leg.line?.shortName || leg.line?.tripName || "Train";
    const title = [label, leg.headsign ? `towards ${leg.headsign}` : "", leg.line?.agency ? `· ${leg.line.agency}` : ""]
      .filter(Boolean)
      .join(" ");
    out.push({
      key: `${journey.id}:${i}`,
      legIndex: i,
      coord: at,
      label,
      title,
      color,
      textColor: readableTextColor(color),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Camera helpers
// ---------------------------------------------------------------------------

export function journeyBounds(j: Journey): Bounds | null {
  let b: Bounds | null = null;
  for (const leg of j.legs) b = boundsOf(legLine(leg), b);
  return b;
}

export function legBounds(leg: Leg): Bounds | null {
  return boundsOf(legLine(leg));
}

/** A stable key that changes when a journey's shape changes (ids alone may be reused). */
export function journeyShapeKey(j: Journey): string {
  const first = j.legs[0];
  const last = j.legs[j.legs.length - 1];
  const len = j.legs.reduce((s, l) => s + lineLength(legLine(l)), 0);
  return [j.id, j.startTime, first?.from.lat, first?.from.lon, last?.to.lat, last?.to.lon, Math.round(len)].join("|");
}
