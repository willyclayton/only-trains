/**
 * Turn raw street-routing steps into a short list of readable walking
 * instructions ("Head north on Dircksenstraße", "Turn left onto W North Ave").
 *
 * MOTIS emits one step per OSM way segment and usually reports
 * relativeDirection=CONTINUE even at real turns, so turns are derived from the
 * step geometry (bearing change between consecutive named segments).
 */
import type { WalkStep } from "../types";
import { bearing, haversineLonLat } from "../polyline";

export type RawStep = {
  distance: number;
  streetName?: string;
  /** MOTIS Direction enum (DEPART, LEFT, CONTINUE, STAIRS, ELEVATOR, ...). */
  direction?: string;
  fromLevel?: number;
  toLevel?: number;
  /** [lon, lat] path of this step. */
  geometry: [number, number][];
};

type Group = {
  name: string;
  kind: "street" | "stairs" | "elevator";
  distance: number;
  geometry: [number, number][];
  levelDelta: number;
  direction?: string;
};

const CARDINALS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

function cleanStreet(name: string | undefined): string {
  // OSM multi-values ("田原町駅;2番出入口") read better with a separator.
  const n = (name ?? "").replace(/\s*;\s*/g, ", ").replace(/\s+/g, " ").trim();
  // OSM refs like "4" (platform numbers) or "1;2" are not street names.
  if (!n || /^[\d;,\s-]{1,6}[a-z]?$/i.test(n)) return "";
  return n;
}

function startBearing(g: [number, number][]): number | null {
  if (g.length < 2) return null;
  const a = g[0];
  // look ~15 m ahead for a stable bearing
  for (let i = 1; i < g.length; i++) {
    if (haversineLonLat(a, g[i]) >= 15 || i === g.length - 1) return bearing(a, g[i]);
  }
  return null;
}

function endBearing(g: [number, number][]): number | null {
  if (g.length < 2) return null;
  const b = g[g.length - 1];
  for (let i = g.length - 2; i >= 0; i--) {
    if (haversineLonLat(g[i], b) >= 15 || i === 0) return bearing(g[i], b);
  }
  return null;
}

function turnPhrase(delta: number): string {
  // delta in (-180, 180], positive = right
  const a = Math.abs(delta);
  const side = delta > 0 ? "right" : "left";
  if (a < 25) return "Continue";
  if (a < 60) return `Bear ${side}`;
  if (a < 135) return `Turn ${side}`;
  if (a < 165) return `Turn sharp ${side}`;
  return "Make a U-turn";
}

function directionPhrase(dir: string | undefined): string | null {
  switch ((dir ?? "").toUpperCase()) {
    case "LEFT":
      return "Turn left";
    case "RIGHT":
      return "Turn right";
    case "SLIGHTLY_LEFT":
      return "Bear left";
    case "SLIGHTLY_RIGHT":
      return "Bear right";
    case "HARD_LEFT":
      return "Turn sharp left";
    case "HARD_RIGHT":
      return "Turn sharp right";
    case "UTURN_LEFT":
    case "UTURN_RIGHT":
      return "Make a U-turn";
    case "CIRCLE_CLOCKWISE":
    case "CIRCLE_COUNTERCLOCKWISE":
      return "At the roundabout, continue";
    default:
      return null;
  }
}

/**
 * @param steps raw provider steps
 * @param destinationName name of where this walk ends (station or "Destination")
 */
export function buildWalkSteps(steps: RawStep[], destinationName?: string): WalkStep[] {
  if (!steps.length) return [];

  // 1) group consecutive steps by street name / vertical movement
  const groups: Group[] = [];
  for (const s of steps) {
    const dist = Math.max(0, s.distance || 0);
    const dirU = (s.direction ?? "").toUpperCase();
    const levelDelta = (s.toLevel ?? 0) - (s.fromLevel ?? 0);
    const kind: Group["kind"] = dirU === "ELEVATOR" ? "elevator" : dirU === "STAIRS" ? "stairs" : "street";
    const name = kind === "street" ? cleanStreet(s.streetName) : "";
    const last = groups[groups.length - 1];
    if (last && last.kind === kind && (kind !== "street" || last.name === name)) {
      last.distance += dist;
      last.levelDelta += levelDelta;
      appendGeom(last.geometry, s.geometry);
      continue;
    }
    groups.push({ name, kind, distance: dist, geometry: [...s.geometry], levelDelta, direction: s.direction });
  }

  // 2) absorb tiny unnamed street fragments into a neighbour (keeps the list short)
  const merged: Group[] = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    if (prev && g.kind === "street" && !g.name && g.distance < 25 && prev.kind === "street") {
      prev.distance += g.distance;
      appendGeom(prev.geometry, g.geometry);
      continue;
    }
    if (prev && prev.kind === "street" && !prev.name && prev.distance < 25 && g.kind === "street" && merged.length > 1) {
      // a tiny unnamed piece before a named street: fold it forward
      merged.pop();
      const before = merged[merged.length - 1];
      before.distance += prev.distance;
      appendGeom(before.geometry, prev.geometry);
    }
    if (prev && prev.kind === "street" && g.kind === "street" && prev.name === g.name) {
      prev.distance += g.distance;
      appendGeom(prev.geometry, g.geometry);
      continue;
    }
    merged.push({ ...g, geometry: [...g.geometry] });
  }

  // 3) phrase
  const out: WalkStep[] = [];
  merged.forEach((g, i) => {
    const distance = Math.round(g.distance);
    if (g.kind === "stairs") {
      const updown = g.levelDelta > 0 ? " up" : g.levelDelta < 0 ? " down" : "";
      out.push({ instruction: `Take the stairs${updown}`, distance });
      return;
    }
    if (g.kind === "elevator") {
      const updown = g.levelDelta > 0 ? " up" : g.levelDelta < 0 ? " down" : "";
      out.push({ instruction: `Take the elevator${updown}`, distance });
      return;
    }
    if (distance < 3 && i > 0) return; // noise
    const onto = g.name ? ` onto ${g.name}` : "";
    if (i === 0) {
      const b = startBearing(g.geometry);
      const card = b === null ? "" : ` ${CARDINALS[Math.round(b / 45) % 8]}`;
      out.push({
        instruction: g.name ? `Head${card} on ${g.name}` : `Head${card}`,
        distance,
        streetName: g.name || undefined,
      });
      return;
    }
    const prev = merged[i - 1];
    let phrase = directionPhrase(g.direction);
    if (!phrase) {
      const b1 = prev ? endBearing(prev.geometry) : null;
      const b2 = startBearing(g.geometry);
      if (b1 !== null && b2 !== null) {
        let d = b2 - b1;
        while (d > 180) d -= 360;
        while (d <= -180) d += 360;
        phrase = turnPhrase(d);
      } else phrase = "Continue";
    }
    if (prev && (prev.kind === "stairs" || prev.kind === "elevator") && phrase === "Continue") {
      out.push({ instruction: g.name ? `Continue on ${g.name}` : "Continue", distance, streetName: g.name || undefined });
      return;
    }
    if (phrase === "Continue" && !g.name) {
      // unnamed continuation: fold into the previous instruction
      const last = out[out.length - 1];
      if (last && !/stairs|elevator/.test(last.instruction)) {
        last.distance += distance;
        return;
      }
      out.push({ instruction: "Continue", distance });
      return;
    }
    out.push({
      instruction: phrase === "Continue" ? `Continue${onto}` : `${phrase}${onto}`,
      distance,
      streetName: g.name || undefined,
    });
  });

  if (destinationName) out.push({ instruction: `Arrive at ${destinationName}`, distance: 0 });
  return out;
}

function appendGeom(target: [number, number][], add: [number, number][]) {
  for (const p of add) {
    const last = target[target.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    target.push(p);
  }
}
