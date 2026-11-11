import type { Journey, Leg } from "./types";

export type JourneyTotals = Pick<
  Journey,
  "duration" | "railDuration" | "walkDuration" | "waitDuration" | "walkDistance" | "railDistance" | "transfers"
>;

/**
 * Single source of truth for a journey's time/distance breakdown.
 * Providers call this when normalizing so every Journey carries consistent totals:
 *   duration = railDuration + walkDuration + waitDuration
 */
export function journeyTotals(legs: Leg[], startTime: string, endTime: string): JourneyTotals {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const legSum = legs.reduce((s, l) => s + Math.max(0, l.duration || 0), 0);
  const duration = Number.isFinite(end - start) && end > start ? Math.round((end - start) / 1000) : legSum;

  let railDuration = 0;
  let walkDuration = 0;
  let walkDistance = 0;
  let railDistance = 0;
  let railLegs = 0;
  for (const l of legs) {
    const d = Math.max(0, l.duration || 0);
    if (l.mode === "WALK") {
      walkDuration += d;
      walkDistance += l.distance ?? 0;
    } else {
      railDuration += d;
      railDistance += l.distance ?? 0;
      railLegs += 1;
    }
  }
  const waitDuration = Math.max(0, duration - railDuration - walkDuration);

  return {
    duration,
    railDuration,
    walkDuration,
    waitDuration,
    walkDistance: Math.round(walkDistance),
    railDistance: Math.round(railDistance),
    transfers: Math.max(0, railLegs - 1),
  };
}
