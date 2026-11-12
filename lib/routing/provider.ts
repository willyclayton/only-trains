import type { Journey, LatLon, PlanOptions } from "../types";

/** What the orchestrator (lib/plan.ts) asks of a routing provider. */
export type ProviderQuery = {
  from: LatLon;
  to: LatLon;
  /** Effective options (maxWalkMinutes may already be escalated by the orchestrator). */
  options: PlanOptions;
  /** Provider-native paging cursor. */
  cursor?: string;
  /** BCP-47 / ISO-639-1 language for names, e.g. "en". */
  language?: string;
  timeoutMs: number;
  /** Look this many seconds past `time` for departures (rare long-distance trains). */
  searchWindowSec?: number;
};

export type ProviderResult = {
  journeys: Journey[];
  /** Itineraries the provider returned that we discarded because they used a non-rail / non-selected mode. */
  rejected: number;
  /** Provider-native cursors. */
  cursors: { earlier?: string; later?: string };
  originTz?: string;
  destinationTz?: string;
  /** Fastest walk-only alternative, if the provider computed one. */
  directWalk?: { duration: number; distance?: number };
  attribution: string[];
  warnings: string[];
};

/** FNV-1a 32-bit → base36, for stable journey ids. */
export function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
