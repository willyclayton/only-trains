/**
 * Map configuration: basemap styles, the railway overlay, attribution and
 * persisted user preferences. Owned by the map; nothing here touches React.
 */

export type Theme = "light" | "dark";

/** OpenFreeMap: free, no key, no registration. https://openfreemap.org */
export const BASEMAP_STYLE_URL: Record<Theme, string> = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};

/** Name of the vector source in the OpenFreeMap styles. */
export const BASEMAP_SOURCE_ID = "openmaptiles";

/**
 * Overrides the TileJSON attribution ("Data from OpenStreetMap") with the
 * wording the OSMF attribution guidelines recommend. A style-level
 * `attribution` wins over the TileJSON one in MapLibre.
 */
export const BASEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';

/** Transitous requires a visible link to its data-sources page. */
export const ROUTING_ATTRIBUTION =
  'Routes <a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous</a>';

// ---------------------------------------------------------------------------
// Railway overlay (OpenRailwayMap raster tiles)
// ---------------------------------------------------------------------------

export type RailView = "standard" | "maxspeed" | "electrification";

export const RAIL_VIEWS: { id: RailView; label: string; hint: string }[] = [
  { id: "standard", label: "Standard", hint: "Tracks, lines and stations" },
  { id: "maxspeed", label: "Max speed", hint: "Colored by permitted line speed" },
  { id: "electrification", label: "Electrification", hint: "Colored by power system" },
];

/**
 * Kill switch / provider swap without code changes:
 *  - NEXT_PUBLIC_RAIL_OVERLAY=off        hides the overlay and its control entirely
 *  - NEXT_PUBLIC_RAIL_TILES=https://my-tiles.example/{view}/{z}/{x}/{y}.png
 *                                        points at a self-hosted / commercial mirror
 */
export const RAIL_OVERLAY_AVAILABLE = process.env.NEXT_PUBLIC_RAIL_OVERLAY !== "off";

const RAIL_TILE_TEMPLATE =
  process.env.NEXT_PUBLIC_RAIL_TILES || "https://tiles.openrailwaymap.org/{view}/{z}/{x}/{y}.png";

export function railTiles(view: RailView): string[] {
  return [RAIL_TILE_TEMPLATE.replace("{view}", view)];
}

export const RAIL_ATTRIBUTION =
  'Rail overlay <a href="https://www.openrailwaymap.org/" target="_blank" rel="noopener">OpenRailwayMap</a> ' +
  '(<a href="https://creativecommons.org/licenses/by-sa/2.0/" target="_blank" rel="noopener">CC BY-SA</a>)';

/**
 * ORM serves 512 px "retina" tiles (no @2x variant) up to z19. Declaring them
 * as 256 px tiles gives crisp lines on HiDPI screens and the same label size
 * as openrailwaymap.org.
 */
export const RAIL_TILE_SIZE = 256;
export const RAIL_MAX_ZOOM = 19;

// ---------------------------------------------------------------------------
// Preferences (localStorage, best effort)
// ---------------------------------------------------------------------------

export type RailPrefs = { on: boolean; view: RailView };

const PREFS_KEY = "only-trains:map:rail";
export const DEFAULT_RAIL_PREFS: RailPrefs = { on: true, view: "standard" };

export function loadRailPrefs(): RailPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_RAIL_PREFS;
    const p = JSON.parse(raw) as Partial<RailPrefs>;
    const view = RAIL_VIEWS.some((v) => v.id === p.view) ? (p.view as RailView) : DEFAULT_RAIL_PREFS.view;
    return { on: typeof p.on === "boolean" ? p.on : DEFAULT_RAIL_PREFS.on, view };
  } catch {
    return DEFAULT_RAIL_PREFS;
  }
}

export function saveRailPrefs(p: RailPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode / blocked storage: keep the in-memory choice */
  }
}
