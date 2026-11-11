/**
 * Custom sources and layers drawn on top of the OpenFreeMap basemap, and the
 * `transformStyle` hook that grafts them onto whichever basemap is loaded.
 *
 * Why transformStyle: when the theme flips, `map.setStyle(url)` diffs the new
 * basemap against the current style. The transform receives the new basemap
 * and returns it with our sources (carrying the current data) and layers
 * already in place, so routes never disappear or flash during a theme switch.
 */
import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
} from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import {
  BASEMAP_ATTRIBUTION,
  BASEMAP_SOURCE_ID,
  RAIL_ATTRIBUTION,
  RAIL_MAX_ZOOM,
  RAIL_TILE_SIZE,
  type RailPrefs,
  type RailView,
  type Theme,
  railTiles,
} from "./config";

export const SRC = {
  rail: "ot-rail-tiles",
  alt: "ot-alt",
  legs: "ot-legs",
  stops: "ot-stops",
} as const;

export const LYR = {
  rail: "ot-rail-overlay",
  altHalo: "ot-alt-halo",
  alt: "ot-alt",
  altHit: "ot-alt-hit",
  walkHalo: "ot-walk-halo",
  walk: "ot-walk",
  railCasing: "ot-leg-casing",
  railLine: "ot-leg-line",
  legHit: "ot-leg-hit",
  stopMinor: "ot-stop-minor",
  stopMajor: "ot-stop-major",
  stopMinorLabel: "ot-stop-minor-label",
  stopMajorLabel: "ot-stop-major-label",
} as const;

/** Layers that respond to the pointer, top-most first. */
export const STOP_LAYERS = [LYR.stopMajor, LYR.stopMinor];
export const ROUTE_HIT_LAYERS = [LYR.legHit, LYR.altHit];

/** Global-state key for the leg hovered in the detail panel (-1 = none). */
export const HOVER_LEG = "otHoverLeg";

const FONT_BOLD = ["Noto Sans Bold"];
const FONT_REGULAR = ["Noto Sans Regular"];

/** Map palette per theme. Mirrors the monochrome tokens in app/globals.css. */
export const PALETTE: Record<
  Theme,
  { ink: string; paper: string; muted: string; halo: string; alt: string; altHover: string; walk: string }
> = {
  light: {
    ink: "#141518",
    paper: "#ffffff",
    muted: "#55595f",
    halo: "#ffffff",
    alt: "#8d9199",
    altHover: "#3b3e45",
    walk: "#5d636e",
  },
  dark: {
    ink: "#f1f1ee",
    paper: "#15171a",
    muted: "#b4b7bd",
    halo: "#0d0e10",
    alt: "#7c8088",
    altHover: "#d6d7d3",
    walk: "#a4abb6",
  },
};

export type MapRuntime = {
  theme: Theme;
  rail: RailPrefs;
  railAvailable: boolean;
  hasRoute: boolean;
  hoverLeg: number;
  data: { alt: FeatureCollection; legs: FeatureCollection; stops: FeatureCollection };
};

// ---------------------------------------------------------------------------
// Railway overlay
// ---------------------------------------------------------------------------

/** Raster paint for the overlay: quieter under a route, desaturated in the "standard" view. */
export function railPaint(theme: Theme, view: RailView, hasRoute: boolean) {
  const base = theme === "dark" ? 0.62 : 0.72;
  const opacity = hasRoute ? base * 0.68 : base;
  return {
    "raster-opacity": opacity,
    // Standard view colors encode line type; tone them down so official line
    // colors stay the loudest thing on screen. Thematic views keep their keys.
    "raster-saturation": view === "standard" ? -0.45 : -0.1,
    "raster-contrast": theme === "dark" ? 0.1 : 0,
    "raster-brightness-min": 0,
    "raster-brightness-max": theme === "dark" ? 0.88 : 1,
  } as const;
}

function railSource(view: RailView): SourceSpecification {
  return {
    type: "raster",
    tiles: railTiles(view),
    tileSize: RAIL_TILE_SIZE,
    maxzoom: RAIL_MAX_ZOOM,
    attribution: RAIL_ATTRIBUTION,
  };
}

function railLayer(rt: MapRuntime): LayerSpecification {
  return {
    id: LYR.rail,
    type: "raster",
    source: SRC.rail,
    layout: { visibility: rt.rail.on ? "visible" : "none" },
    paint: { ...railPaint(rt.theme, rt.rail.view, rt.hasRoute), "raster-fade-duration": 200 },
  };
}

// ---------------------------------------------------------------------------
// Route layers
// ---------------------------------------------------------------------------

const hoverLeg: ExpressionSpecification = ["global-state", HOVER_LEG];
const noHover: ExpressionSpecification = ["==", ["to-number", hoverLeg, -1], -1];

/** True for features of the hovered leg (legs source: `legIndex` prop). */
const legIsHot: ExpressionSpecification = ["==", ["get", "legIndex"], ["to-number", hoverLeg, -1]];
/** True for stops that touch the hovered leg (stops source: `legs` = ",1,2,"). */
const stopIsHot: ExpressionSpecification = [
  "in",
  ["concat", ",", ["to-string", ["to-number", hoverLeg, -1]], ","],
  ["get", "legs"],
];

function dim(hot: ExpressionSpecification, low = 0.22): DataDrivenPropertyValueSpecification<number> {
  return ["case", noHover, 1, hot, 1, low];
}

/** Zoom-interpolated width with an emphasized variant for the hovered leg. */
function legWidth(stops: [number, number][], extra = 0): DataDrivenPropertyValueSpecification<number> {
  const out: unknown[] = ["interpolate", ["linear"], ["zoom"]];
  for (const [z, w] of stops) out.push(z, ["case", legIsHot, w * 1.35 + extra, w + extra]);
  return out as DataDrivenPropertyValueSpecification<number>;
}

const RAIL_W: [number, number][] = [
  [4, 2.5],
  [9, 3.5],
  [12, 5],
  [15, 7],
  [18, 10],
];

const isWalk: ExpressionSpecification = ["==", ["get", "walk"], true];
const isRail: ExpressionSpecification = ["!=", ["get", "walk"], true];

function routeLayers(theme: Theme): LayerSpecification[] {
  const p = PALETTE[theme];
  const casingKey = theme === "dark" ? "casingDark" : "casingLight";
  const round = { "line-join": "round", "line-cap": "round" } as const;

  return [
    // --- Other journeys: thin, muted, clickable --------------------------
    {
      id: LYR.altHalo,
      type: "line",
      source: SRC.alt,
      layout: round,
      paint: {
        "line-color": p.halo,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 3.5, 12, 6, 16, 8],
        "line-opacity": 0.7,
      },
    },
    {
      id: LYR.alt,
      type: "line",
      source: SRC.alt,
      layout: round,
      paint: {
        "line-color": ["case", ["boolean", ["feature-state", "hover"], false], p.altHover, p.alt],
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,
          ["case", ["boolean", ["feature-state", "hover"], false], 2.5, 1.5],
          12,
          ["case", ["boolean", ["feature-state", "hover"], false], 4, 3],
          16,
          ["case", ["boolean", ["feature-state", "hover"], false], 5.5, 4],
        ],
        "line-opacity": 0.9,
      },
    },
    {
      id: LYR.altHit,
      type: "line",
      source: SRC.alt,
      layout: round,
      paint: { "line-color": "#000000", "line-opacity": 0, "line-width": 18 },
    },

    // --- Selected journey: walking (dotted) -------------------------------
    {
      id: LYR.walkHalo,
      type: "line",
      source: SRC.legs,
      filter: isWalk,
      layout: round,
      paint: {
        "line-color": p.halo,
        "line-width": legWidth(RAIL_W, 1.5),
        "line-opacity": ["case", noHover, 0.75, legIsHot, 0.9, 0.2],
      },
    },
    {
      id: LYR.walk,
      type: "line",
      source: SRC.legs,
      filter: isWalk,
      layout: round,
      paint: {
        "line-color": p.walk,
        "line-width": legWidth([
          [4, 2.5],
          [12, 3.5],
          [16, 5],
          [18, 6.5],
        ]),
        // 0-length dashes with round caps render as dots.
        "line-dasharray": [0, 1.9],
        "line-opacity": dim(legIsHot, 0.3),
      },
    },

    // --- Selected journey: rail legs in their line colors -----------------
    {
      id: LYR.railCasing,
      type: "line",
      source: SRC.legs,
      filter: isRail,
      layout: round,
      paint: {
        "line-color": ["get", casingKey],
        "line-width": legWidth(RAIL_W, 3.5),
        "line-opacity": dim(legIsHot, 0.25),
      },
    },
    {
      id: LYR.railLine,
      type: "line",
      source: SRC.legs,
      filter: isRail,
      layout: round,
      paint: {
        "line-color": ["get", "color"],
        "line-width": legWidth(RAIL_W),
        "line-opacity": dim(legIsHot, 0.3),
      },
    },
    {
      id: LYR.legHit,
      type: "line",
      source: SRC.legs,
      layout: round,
      paint: { "line-color": "#000000", "line-opacity": 0, "line-width": 16 },
    },

    // --- Stations ------------------------------------------------------------
    {
      id: LYR.stopMinor,
      type: "circle",
      source: SRC.stops,
      minzoom: 9,
      filter: ["==", ["get", "role"], "minor"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2, 12, 3.2, 15, 4.5, 18, 6],
        "circle-color": p.paper,
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 1.2, 12, 2, 16, 2.75],
        "circle-opacity": dim(stopIsHot, 0.3),
        "circle-stroke-opacity": dim(stopIsHot, 0.3),
      },
    },
    {
      id: LYR.stopMajor,
      type: "circle",
      source: SRC.stops,
      filter: ["==", ["get", "role"], "major"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3.5, 10, 5.5, 14, 7, 18, 9],
        "circle-color": p.paper,
        "circle-stroke-color": p.ink,
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 4, 2, 12, 2.75, 16, 3.25],
        "circle-opacity": dim(stopIsHot, 0.35),
        "circle-stroke-opacity": dim(stopIsHot, 0.35),
      },
    },
    {
      id: LYR.stopMinorLabel,
      type: "symbol",
      source: SRC.stops,
      minzoom: 13,
      filter: ["==", ["get", "role"], "minor"],
      layout: {
        "text-field": ["get", "name"],
        "text-font": FONT_REGULAR,
        "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10.5, 17, 12.5],
        "text-variable-anchor": ["left", "right", "top", "bottom"],
        "text-radial-offset": 0.75,
        "text-justify": "auto",
        "text-max-width": 9,
        "text-padding": 3,
      },
      paint: {
        "text-color": p.muted,
        "text-halo-color": p.halo,
        "text-halo-width": 1.6,
        "text-halo-blur": 0.3,
        "text-opacity": dim(stopIsHot, 0.25),
      },
    },
    {
      id: LYR.stopMajorLabel,
      type: "symbol",
      source: SRC.stops,
      filter: ["==", ["get", "role"], "major"],
      layout: {
        "text-field": [
          "format",
          ["get", "name"],
          {},
          "\n",
          {},
          ["get", "time"],
          { "font-scale": 0.86, "text-font": ["literal", FONT_REGULAR] },
        ],
        "text-font": FONT_BOLD,
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 11, 12, 12.5, 16, 14],
        "text-variable-anchor": ["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"],
        "text-radial-offset": 0.95,
        "text-justify": "auto",
        "text-max-width": 12,
        "text-line-height": 1.15,
        "text-padding": 4,
        "symbol-sort-key": ["get", "rank"],
      },
      paint: {
        "text-color": p.ink,
        "text-halo-color": p.halo,
        "text-halo-width": 2,
        "text-halo-blur": 0.25,
        "text-opacity": dim(stopIsHot, 0.3),
      },
    },
  ];
}

function geojson(data: FeatureCollection): SourceSpecification {
  return { type: "geojson", data, tolerance: 0.3 };
}

// ---------------------------------------------------------------------------
// transformStyle
// ---------------------------------------------------------------------------

export function makeTransformStyle(get: () => MapRuntime) {
  return (_previous: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification => {
    const rt = get();
    const sources: StyleSpecification["sources"] = { ...next.sources };

    const base = sources[BASEMAP_SOURCE_ID];
    if (base && (base.type === "vector" || base.type === "raster")) {
      sources[BASEMAP_SOURCE_ID] = { ...base, attribution: BASEMAP_ATTRIBUTION };
    }

    sources[SRC.alt] = geojson(rt.data.alt);
    sources[SRC.legs] = geojson(rt.data.legs);
    sources[SRC.stops] = geojson(rt.data.stops);

    const layers = next.layers.filter((l) => !l.id.startsWith("ot-"));

    if (rt.railAvailable) {
      sources[SRC.rail] = railSource(rt.rail.view);
      // Under the basemap's labels so place names stay readable.
      const firstSymbol = layers.findIndex((l) => l.type === "symbol");
      layers.splice(firstSymbol >= 0 ? firstSymbol : layers.length, 0, railLayer(rt));
    }

    layers.push(...routeLayers(rt.theme));

    return {
      ...next,
      sources,
      layers,
      state: { ...(next.state ?? {}), [HOVER_LEG]: { default: rt.hoverLeg } },
    };
  };
}
