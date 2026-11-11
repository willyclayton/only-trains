import type { LegMode, RailMode } from "./types";

export type RailModeInfo = {
  id: RailMode;
  label: string;
  short: string;
  description: string;
  defaultOn: boolean;
};

/** Order matters: this is the order toggles appear in the UI. */
export const RAIL_MODES: RailModeInfo[] = [
  {
    id: "SUBWAY",
    label: "Metro & subway",
    short: "Metro",
    description: "Rapid transit: the Chicago L, NYC Subway, London Underground, U-Bahn, Métro",
    defaultOn: true,
  },
  {
    id: "COMMUTER",
    label: "Commuter & regional rail",
    short: "Regional",
    description: "Metra, LIRR, S-Bahn, RER, regional trains",
    defaultOn: true,
  },
  {
    id: "INTERCITY",
    label: "Intercity & high-speed",
    short: "Intercity",
    description: "Amtrak, ICE, TGV, Shinkansen, night trains",
    defaultOn: true,
  },
  {
    id: "LIGHT_RAIL",
    label: "Light rail & tram",
    short: "Tram",
    description: "Light rail, trams and streetcars",
    defaultOn: true,
  },
  {
    id: "OTHER_RAIL",
    label: "Monorail & funicular",
    short: "Other rail",
    description: "Monorails, funiculars, cog railways",
    defaultOn: true,
  },
];

export const DEFAULT_MODES: RailMode[] = RAIL_MODES.filter((m) => m.defaultOn).map((m) => m.id);

export const ALL_RAIL_MODES: RailMode[] = RAIL_MODES.map((m) => m.id);

export function isRailMode(m: string): m is RailMode {
  return (ALL_RAIL_MODES as string[]).includes(m);
}

export function modeLabel(m: LegMode): string {
  if (m === "WALK") return "Walk";
  return RAIL_MODES.find((x) => x.id === m)?.short ?? m;
}

/** Neutral fallback colors when an operator publishes no line color. */
export const MODE_FALLBACK_COLOR: Record<LegMode, string> = {
  WALK: "#6b7280",
  SUBWAY: "#2563eb",
  COMMUTER: "#475569", // slate: purple read as the CTA Purple Line
  INTERCITY: "#dc2626",
  LIGHT_RAIL: "#059669",
  OTHER_RAIL: "#d97706",
};

export const DEFAULT_MAX_WALK_MINUTES = 20;
export const MAX_WALK_CHOICES = [10, 15, 20, 30, 45, 60];
