/**
 * Shared contracts for Only Trains.
 *
 * Every provider (Transitous/MOTIS, Google Routes, ...) normalizes into these
 * shapes, and every UI component consumes only these shapes. Keep this file
 * provider-agnostic.
 */

export type LatLon = { lat: number; lon: number };

/** A point the user picked: from search, a map click, or geolocation. */
export type Place = {
  id: string;
  /** Primary label, e.g. "Damen (Blue)" or "1600 W North Ave". */
  name: string;
  /** Secondary label, e.g. "Chicago, Illinois, United States". */
  detail?: string;
  lat: number;
  lon: number;
  kind?: "station" | "address" | "poi" | "city" | "coordinate" | "other";
};

/**
 * Normalized rail categories. Buses, coaches, ferries, planes and aerial
 * lifts are never allowed in Only Trains.
 *
 * - SUBWAY      metro / subway / elevated rapid transit (Chicago "L", NYC Subway, Tube, U-Bahn, Metro)
 * - COMMUTER    suburban / regional / commuter rail (Metra, LIRR, S-Bahn, RER, Regionalbahn)
 * - INTERCITY   long-distance, intercity, high-speed, night trains (Amtrak, ICE, TGV, Shinkansen)
 * - LIGHT_RAIL  light rail, trams, streetcars
 * - OTHER_RAIL  monorail, funicular, cog railway and other rail oddities
 */
export type RailMode = "SUBWAY" | "COMMUTER" | "INTERCITY" | "LIGHT_RAIL" | "OTHER_RAIL";

export type LegMode = "WALK" | RailMode;

export type StopTime = {
  name: string;
  lat: number;
  lon: number;
  stopId?: string;
  /** ISO-8601 UTC timestamps. */
  arrival?: string;
  departure?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  /** Platform / track if known. */
  track?: string;
  /** IANA timezone of the stop, e.g. "America/Chicago". */
  tz?: string;
};

export type WalkStep = {
  /** Human readable, e.g. "Turn left onto W North Ave". */
  instruction: string;
  distance: number; // meters
  streetName?: string;
};

export type LineInfo = {
  /** Best display label: "Blue Line", "L", "RE 1", "Yamanote Line", "ICE 597". */
  name: string;
  shortName?: string;
  longName?: string;
  /** "#rrggbb" — the operator's official color when published. */
  color?: string;
  textColor?: string;
  agency?: string;
  agencyUrl?: string;
  routeUrl?: string;
  /** Train number / trip name if published, e.g. "ICE 597", "Amtrak 351". */
  tripName?: string;
  /** Raw GTFS (extended) route_type if known. */
  routeType?: number;
};

export type Leg = {
  mode: LegMode;
  /** The provider's own mode string, e.g. "SUBWAY", "REGIONAL_RAIL", "HIGHSPEED_RAIL". */
  rawMode?: string;
  from: StopTime;
  to: StopTime;
  /** ISO-8601 UTC. */
  startTime: string;
  endTime: string;
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  duration: number; // seconds
  distance?: number; // meters (walks always; rail if known or estimated from geometry)
  /** Path as [lon, lat] pairs (GeoJSON order). */
  geometry: [number, number][];
  /** Rail legs only. */
  line?: LineInfo;
  headsign?: string;
  intermediateStops?: StopTime[];
  realTime?: boolean;
  cancelled?: boolean;
  /** Walk legs only. */
  steps?: WalkStep[];
  alerts?: { header?: string; description?: string; url?: string }[];
};

export type Journey = {
  id: string;
  provider: "transitous" | "google";
  startTime: string; // ISO UTC
  endTime: string; // ISO UTC
  /** Total door-to-door trip time, seconds (endTime − startTime). */
  duration: number;
  transfers: number;
  /** Time spent on trains, seconds (sum of rail legs). */
  railDuration: number;
  /** Time spent walking, seconds (sum of walk legs). */
  walkDuration: number;
  /** Time spent waiting on platforms / for transfers, seconds (duration − rail − walk, ≥ 0). */
  waitDuration: number;
  walkDistance: number; // meters
  railDistance: number; // meters (approximate)
  legs: Leg[];
};

export type PlanOptions = {
  /** ISO timestamp, or null for "now". */
  time: string | null;
  arriveBy: boolean;
  modes: RailMode[];
  /** Max walking at each end of the trip, minutes. */
  maxWalkMinutes: number;
};

/**
 * Returned when no journey was found: how far an endpoint is from the nearest
 * station of an enabled train type, so the UI can explain the gap and offer
 * to plan to that station instead.
 */
export type StationHint = {
  which: "from" | "to";
  /** Nearest station, or null when there is none within ~50 km. */
  station: Place | null;
  /** Straight-line distance to the station, meters. */
  distance?: number;
  /** Rough walking time to the station, minutes. */
  walkMinutes?: number;
  /**
   * true: trains from the other endpoint verifiably reach this station (it may
   * not be the nearest one: the nearest can sit on an unconnected network).
   * false: checked, and none of the nearby stations is reachable.
   * undefined: not checked.
   */
  reachable?: boolean;
  /** For a reachable station: fastest trip time there, seconds, and the lines used. */
  duration?: number;
  lines?: string[];
};

export type PlanResponse = {
  journeys: Journey[];
  /** Present only when `journeys` is empty and an endpoint is out of walking reach of any station. */
  stationHints?: StationHint[];
  /** Which provider(s) produced the results. */
  providers: string[];
  /** Attribution strings the UI must display. */
  attribution: string[];
  /** Non-fatal notes for the user, e.g. "Walking limit raised to 30 min to find a rail route." */
  warnings: string[];
  /** Opaque cursors for paging to earlier / later departures. */
  cursors?: { earlier?: string; later?: string };
  /** Timezone at the origin, for displaying times, if known. */
  originTz?: string;
  destinationTz?: string;
  /** Diagnostics, only when the request passes debug=1. */
  debug?: string[];
};

export type ApiError = { error: string; detail?: string };

export type GeocodeResponse = { places: Place[] };
export type ReverseResponse = { place: Place | null };
