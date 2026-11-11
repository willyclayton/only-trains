"use client";
/**
 * The map: OpenFreeMap basemap (light/dark), OpenRailwayMap overlay, every
 * journey from the latest search, and the A/B endpoints.
 *
 * Loaded by Planner via next/dynamic({ ssr: false }), so window is available.
 *
 * Architecture
 *  - One MapLibre map per mount. Custom sources/layers are injected through
 *    `transformStyle` (lib/map/style.ts), so they survive basemap switches.
 *  - Data changes go through GeoJSONSource.setData; layers are never rebuilt.
 *  - Panel hover → global-state expression (no data reload).
 *  - Endpoints, line badges and popups are plain DOM positioned by MapLibre.
 */
import "./map/map.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AttributionControl,
  GeolocateControl,
  type GeoJSONSource,
  type IControl,
  type LngLat,
  Map as MLMap,
  type MapGeoJSONFeature,
  type MapMouseEvent,
  Marker,
  NavigationControl,
  type PointLike,
  Popup,
  type RasterTileSource,
  ScaleControl,
} from "maplibre-gl";
import type { Journey, Place } from "@/lib/types";
import {
  BASEMAP_STYLE_URL,
  RAIL_OVERLAY_AVAILABLE,
  ROUTING_ATTRIBUTION,
  type RailPrefs,
  type Theme,
  DEFAULT_RAIL_PREFS,
  loadRailPrefs,
  railTiles,
  saveRailPrefs,
} from "@/lib/map/config";
import {
  type Badge,
  type StopKind,
  buildAlternatives,
  buildBadges,
  buildEnds,
  buildLegs,
  buildStops,
  journeyBounds,
  journeyShapeKey,
  legBounds,
} from "@/lib/map/features";
import { type Bounds, extendBounds } from "@/lib/map/geo";
import {
  BADGE_AVOID_LAYERS,
  HOVER_LEG,
  LYR,
  type MapRuntime,
  ROUTE_HIT_LAYERS,
  SRC,
  STOP_LAYERS,
  makeTransformStyle,
  railPaint,
} from "@/lib/map/style";
import { configureMapWorker } from "@/lib/map/worker";
import { badgeElement, endpointElement, pickPopupContent, stopPopupContent } from "./map/dom";
import RailLayersControl, { PortalControl } from "./map/RailLayersControl";

export type MapViewProps = {
  from: Place | null;
  to: Place | null;
  /** All journeys from the latest search. Non-selected ones may be drawn faintly. */
  journeys: Journey[];
  selectedId: string | null;
  /** Leg index (in the selected journey) hovered in the detail panel, to highlight. */
  hoveredLegIndex: number | null;
  /** Leg index the user clicked in the detail panel: fly/fit to that leg. Bumps `focusNonce` each click. */
  focusLegIndex: number | null;
  focusNonce: number;
  /** User set a point by clicking / long-pressing / dragging a marker on the map. */
  onPick: (which: "from" | "to", place: Place) => void;
  /** User clicked a (non-selected) route line on the map. */
  onSelectJourney: (id: string) => void;
  /** Pixels covered by the floating panel, so fitBounds keeps routes visible. */
  padding: { top: number; right: number; bottom: number; left: number };
};

type Padding = MapViewProps["padding"];

/** Roughly "the inhabited world", used when nothing is set yet. */
const WORLD: Bounds = [
  [-135, -40],
  [150, 62],
];
const LONG_PRESS_MS = 550;
const POINT_ZOOM = 13.5;

// ---------------------------------------------------------------------------
// Hooks & helpers
// ---------------------------------------------------------------------------

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatch(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return match;
}

function droppedPin(ll: LngLat, name = "Dropped pin", prefix = "pin"): Place {
  const w = ll.wrap();
  return {
    id: `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    kind: "coordinate",
    lat: Math.round(w.lat * 1e6) / 1e6,
    lon: Math.round(w.lng * 1e6) / 1e6,
  };
}

/** Keep padding inside the canvas so fitBounds never refuses to fit. */
function safePadding(map: MLMap, p: Padding): Padding {
  const c = map.getContainer();
  const w = c.clientWidth;
  const h = c.clientHeight;
  const out = { ...p };
  const maxX = Math.max(0, w - 80);
  const maxY = Math.max(0, h - 80);
  if (out.left + out.right > maxX) {
    const k = maxX / (out.left + out.right || 1);
    out.left *= k;
    out.right *= k;
  }
  if (out.top + out.bottom > maxY) {
    const k = maxY / (out.top + out.bottom || 1);
    out.top *= k;
    out.bottom *= k;
  }
  return out;
}

function placeBounds(...places: (Place | null)[]): Bounds | null {
  let b: Bounds | null = null;
  for (const p of places) if (p) b = extendBounds(b, [p.lon, p.lat]);
  return b;
}

function withPlaces(b: Bounds | null, ...places: (Place | null)[]): Bounds | null {
  let out = b;
  for (const p of places) if (p) out = extendBounds(out, [p.lon, p.lat]);
  return out;
}

function isPoint(b: Bounds): boolean {
  return Math.abs(b[0][0] - b[1][0]) < 1e-6 && Math.abs(b[0][1] - b[1][1]) < 1e-6;
}

/** Extra room around fitted routes so station labels at the edges are not clipped. */
function labelRoom(map: MLMap, p: Padding): Padding {
  const wide = map.getContainer().clientWidth >= 768;
  const x = wide ? 48 : 20;
  const y = wide ? 28 : 16;
  return { top: p.top + y, right: p.right + x, bottom: p.bottom + y, left: p.left + x };
}

/** Is the point inside the part of the viewport not covered by the panel? */
function inOpenView(map: MLMap, p: Place, pad: Padding): boolean {
  const pt = map.project([p.lon, p.lat]);
  const c = map.getContainer();
  return pt.x > pad.left && pt.x < c.clientWidth - pad.right && pt.y > pad.top && pt.y < c.clientHeight - pad.bottom;
}

function setPaint(map: MLMap, layer: string, paint: Record<string, unknown>) {
  if (!map.getLayer(layer)) return;
  for (const [k, v] of Object.entries(paint)) {
    try {
      map.setPaintProperty(layer, k as Parameters<MLMap["setPaintProperty"]>[1], v as Parameters<MLMap["setPaintProperty"]>[2]);
    } catch {
      /* style mid-swap: transformStyle re-applies on load */
    }
  }
}

type BadgeEntry = { badge: Badge; marker: Marker; el: HTMLElement; bounds: Bounds | null };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MapView(props: MapViewProps) {
  const { from, to, journeys, selectedId, hoveredLegIndex, focusLegIndex, focusNonce, padding } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [map, setMap] = useState<MLMap | null>(null);
  const [layersEl, setLayersEl] = useState<HTMLElement | null>(null);
  const [railBroken, setRailBroken] = useState(false);

  const isDark = useMedia("(prefers-color-scheme: dark)");
  const isDesktop = useMedia("(min-width: 768px)");
  const theme: Theme = isDark ? "dark" : "light";
  const [rail, setRail] = useState<RailPrefs>(() =>
    RAIL_OVERLAY_AVAILABLE ? loadRailPrefs() : { ...DEFAULT_RAIL_PREFS, on: false },
  );
  const railOn = rail.on && !railBroken;

  // ----- derived data ------------------------------------------------------
  const selected = useMemo(() => journeys.find((j) => j.id === selectedId) ?? null, [journeys, selectedId]);
  const altFC = useMemo(() => buildAlternatives(journeys, selected?.id ?? null), [journeys, selected]);
  const legsFC = useMemo(() => buildLegs(selected), [selected]);
  const fromName = from?.name;
  const toName = to?.name;
  const stopsFC = useMemo(() => buildStops(selected, { fromName, toName }), [selected, fromName, toName]);
  const badges = useMemo(() => buildBadges(selected), [selected]);
  const endsFC = useMemo(
    () => buildEnds(from, to),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [from?.lat, from?.lon, to?.lat, to?.lon],
  );
  const hasRoute = !!selected;
  const hoverLeg = hoveredLegIndex ?? -1;

  // Latest props / runtime for long-lived MapLibre handlers.
  const latest = useRef({ props, selected, padding });
  const runtime = useRef<MapRuntime>({
    theme,
    rail: { ...rail, on: railOn },
    railAvailable: RAIL_OVERLAY_AVAILABLE,
    hasRoute,
    hoverLeg,
    data: { alt: altFC, legs: legsFC, stops: stopsFC, ends: endsFC },
  });
  useLayoutEffect(() => {
    latest.current = { props, selected, padding };
    runtime.current = {
      theme,
      rail: { ...rail, on: railOn },
      railAvailable: RAIL_OVERLAY_AVAILABLE,
      hasRoute,
      hoverLeg,
      data: { alt: altFC, legs: legsFC, stops: stopsFC, ends: endsFC },
    };
  });

  const lastFitKey = useRef("");
  const lastNonce = useRef(focusNonce);
  const appliedTheme = useRef(theme);
  const endpoints = useRef<{ from?: Marker; to?: Marker }>({});
  const badgeEntries = useRef<BadgeEntry[]>([]);

  const fitTo = useCallback((b: Bounds | null, maxZoom: number, animate = true) => {
    const m = mapRef.current;
    if (!m || !b) return;
    const pad = safePadding(m, labelRoom(m, latest.current.padding));
    if (isPoint(b)) {
      m.easeTo({ center: b[0], zoom: Math.max(m.getZoom(), Math.min(maxZoom, POINT_ZOOM)), padding: pad, duration: animate ? 700 : 0 });
      return;
    }
    m.fitBounds(b, { padding: pad, maxZoom, maxDuration: 1600, animate });
  }, []);

  // ----- create the map once ------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const init = latest.current.props;
    const rt = runtime.current;

    // Initial camera: start where the user is going, not at the world.
    const startBounds = placeBounds(init.from, init.to) ?? WORLD;
    const single = !!(init.from || init.to) && isPoint(startBounds);
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const pad = { ...init.padding };
    if (pad.left + pad.right > w - 80) pad.left = pad.right = 20;
    if (pad.top + pad.bottom > h - 80) pad.top = pad.bottom = 20;

    configureMapWorker();
    const m = new MLMap({
      container,
      style: BASEMAP_STYLE_URL[rt.theme],
      transformStyle: makeTransformStyle(() => runtime.current),
      attributionControl: false,
      maplibreLogo: false,
      ...(single
        ? { center: startBounds[0], zoom: POINT_ZOOM }
        : { bounds: startBounds, fitBoundsOptions: { padding: pad, maxZoom: 15 } }),
      maxPitch: 0,
      pitchWithRotate: false,
      touchPitch: false,
      fadeDuration: 180,
      // Full-screen app map: plain scroll/one-finger gestures should move it.
      cooperativeGestures: false,
    });
    mapRef.current = m;
    lastFitKey.current = init.from && init.to ? abKey(init.from, init.to) : init.from || init.to ? pKey((init.from ?? init.to)!) : "";

    // ---------------- popups ----------------
    const hoverPopup = new Popup({
      closeButton: false,
      closeOnClick: false,
      className: "ot-popup ot-popup--hover",
      offset: 12,
      maxWidth: "260px",
      focusAfterOpen: false,
    });
    let hoverKey = "";
    let pinnedStop: Popup | null = null;
    let pickPopup: Popup | null = null;
    let pickOpenedAt = 0;

    const stopInfo = (f: MapGeoJSONFeature) => {
      const p = f.properties as Record<string, string>;
      return {
        name: p.name,
        kind: p.kind as StopKind,
        arr: p.arr,
        dep: p.dep,
        tz: p.tz,
        track: p.track,
        color: p.color,
      };
    };
    const stopLngLat = (f: MapGeoJSONFeature): [number, number] => {
      const g = f.geometry;
      return g.type === "Point" ? (g.coordinates as [number, number]) : [0, 0];
    };

    const hideHover = () => {
      hoverKey = "";
      hoverPopup.remove();
    };

    const openPick = (ll: LngLat) => {
      const now = Date.now();
      if (now - pickOpenedAt < 700) return; // contextmenu + long-press on Android
      pickOpenedAt = now;
      hideHover();
      pinnedStop?.remove();
      pickPopup?.remove();
      const w = ll.wrap();
      const popup = new Popup({ closeButton: false, closeOnClick: true, className: "ot-popup", offset: 6, maxWidth: "240px" });
      popup
        .setLngLat(w)
        .setDOMContent(
          pickPopupContent(w.lat, w.lng, (which) => {
            popup.remove();
            latest.current.props.onPick(which, droppedPin(w));
          }),
        )
        .addTo(m);
      pickPopup = popup;
    };

    // ---------------- hit testing ----------------
    const hitTest = (pt: { x: number; y: number }, r: number) => {
      const layers = [...STOP_LAYERS, ...ROUTE_HIT_LAYERS].filter((id) => m.getLayer(id));
      if (!layers.length) return { stop: undefined, alt: undefined, leg: undefined };
      const box: [PointLike, PointLike] = [
        [pt.x - r, pt.y - r],
        [pt.x + r, pt.y + r],
      ];
      const feats = m.queryRenderedFeatures(box, { layers });
      const stop =
        feats.find((f) => f.layer.id === LYR.stopMajor) ?? feats.find((f) => f.layer.id === LYR.stopMinor);
      const leg = feats.find((f) => f.layer.id === LYR.legHit);
      const alt = feats.find((f) => f.layer.id === LYR.altHit);
      return { stop, alt, leg };
    };

    let hoveredAlt: number | string | undefined;
    const setAltHover = (id: number | string | undefined) => {
      if (id === hoveredAlt) return;
      try {
        if (hoveredAlt !== undefined) m.setFeatureState({ source: SRC.alt, id: hoveredAlt }, { hover: false });
        if (id !== undefined) m.setFeatureState({ source: SRC.alt, id }, { hover: true });
      } catch {
        /* source not ready */
      }
      hoveredAlt = id;
    };

    // ---------------- pointer handlers ----------------
    let lastLongPress = 0;

    const onMove = (e: MapMouseEvent) => {
      if (e.originalEvent.buttons) return;
      const { stop, alt, leg } = hitTest(e.point, 5);
      m.getCanvas().style.cursor = stop || (alt && !leg) ? "pointer" : "";
      setAltHover(!leg && alt ? alt.id : undefined);
      if (stop) {
        const info = stopInfo(stop);
        const key = `${info.name}|${info.kind}|${stopLngLat(stop).join(",")}`;
        if (key !== hoverKey) {
          hoverKey = key;
          hoverPopup.setLngLat(stopLngLat(stop)).setDOMContent(stopPopupContent(info));
          if (!hoverPopup.isOpen()) hoverPopup.addTo(m);
        }
      } else if (hoverKey) hideHover();
    };

    const onOut = () => {
      m.getCanvas().style.cursor = "";
      setAltHover(undefined);
      hideHover();
    };

    const onClick = (e: MapMouseEvent) => {
      if (Date.now() - lastLongPress < 800) return;
      const target = e.originalEvent?.target as HTMLElement | null;
      if (target?.closest?.(".maplibregl-marker, .maplibregl-popup")) return;
      const touch = (e.originalEvent as PointerEvent).pointerType === "touch";
      const { stop, alt, leg } = hitTest(e.point, touch ? 12 : 5);
      if (stop) {
        hideHover();
        pinnedStop?.remove();
        pinnedStop = new Popup({ closeButton: false, closeOnClick: true, className: "ot-popup", offset: 12, maxWidth: "260px" })
          .setLngLat(stopLngLat(stop))
          .setDOMContent(stopPopupContent(stopInfo(stop)))
          .addTo(m);
        return;
      }
      if (leg) return; // the selected route: never drop a pin on it
      if (alt) {
        const id = (alt.properties as { journeyId?: string }).journeyId;
        if (id) latest.current.props.onSelectJourney(id);
        return;
      }
      const { from: f, to: t, onPick } = latest.current.props;
      if (!f) onPick("from", droppedPin(e.lngLat));
      else if (!t) onPick("to", droppedPin(e.lngLat));
      else openPick(e.lngLat);
    };

    const onContext = (e: MapMouseEvent) => {
      e.preventDefault();
      e.originalEvent?.preventDefault?.();
      openPick(e.lngLat);
    };

    m.on("mousemove", onMove);
    m.on("mouseout", onOut);
    m.on("dragstart", hideHover);
    m.on("click", onClick);
    m.on("contextmenu", onContext);

    // Long-press (iOS Safari never fires contextmenu for touch).
    const canvasContainer = m.getCanvasContainer();
    let lp: { timer: number; x: number; y: number } | null = null;
    const cancelLp = () => {
      if (lp) window.clearTimeout(lp.timer);
      lp = null;
    };
    const onTouchStart = (ev: TouchEvent) => {
      cancelLp();
      if (ev.touches.length !== 1) return;
      const t = ev.touches[0];
      const rect = canvasContainer.getBoundingClientRect();
      const x = t.clientX - rect.left;
      const y = t.clientY - rect.top;
      lp = {
        x,
        y,
        timer: window.setTimeout(() => {
          lp = null;
          lastLongPress = Date.now();
          openPick(m.unproject([x, y]));
        }, LONG_PRESS_MS),
      };
    };
    const onTouchMove = (ev: TouchEvent) => {
      if (!lp) return;
      const t = ev.touches[0];
      const rect = canvasContainer.getBoundingClientRect();
      if (ev.touches.length !== 1 || Math.hypot(t.clientX - rect.left - lp.x, t.clientY - rect.top - lp.y) > 10) cancelLp();
    };
    canvasContainer.addEventListener("touchstart", onTouchStart, { passive: true });
    canvasContainer.addEventListener("touchmove", onTouchMove, { passive: true });
    canvasContainer.addEventListener("touchend", cancelLp, { passive: true });
    canvasContainer.addEventListener("touchcancel", cancelLp, { passive: true });

    // ---------------- style lifecycle ----------------
    const onStyleLoad = () => {
      hoveredAlt = undefined;
      try {
        m.setGlobalStateProperty(HOVER_LEG, runtime.current.hoverLeg);
      } catch {
        /* ignore */
      }
    };
    m.on("style.load", onStyleLoad);

    // Railway overlay health: if every tile fails (blocked / policy change),
    // switch it off quietly instead of spamming errors.
    let railOk = 0;
    let railFail = 0;
    m.on("data", (e) => {
      if ("sourceId" in e && e.sourceId === SRC.rail && e.dataType === "source" && "tile" in e && e.tile) railOk++;
    });
    m.on("error", (e) => {
      const sourceId = (e as unknown as { sourceId?: string }).sourceId;
      if (sourceId === SRC.rail) {
        railFail++;
        if (railFail >= 8 && railOk === 0) setRailBroken(true);
        return;
      }
      console.warn("[map]", e.error?.message ?? e);
    });

    setMap(m);

    return () => {
      cancelLp();
      canvasContainer.removeEventListener("touchstart", onTouchStart);
      canvasContainer.removeEventListener("touchmove", onTouchMove);
      canvasContainer.removeEventListener("touchend", cancelLp);
      canvasContainer.removeEventListener("touchcancel", cancelLp);
      hoverPopup.remove();
      pinnedStop?.remove();
      pickPopup?.remove();
      endpoints.current.from?.remove();
      endpoints.current.to?.remove();
      endpoints.current = {};
      for (const b of badgeEntries.current) b.marker.remove();
      badgeEntries.current = [];
      m.remove();
      mapRef.current = null;
      setMap(null);
    };
  }, []);

  // ----- controls (positions depend on the layout) ---------------------------
  useEffect(() => {
    if (!map) return;
    const controls: { c: IControl; pos: "top-right" | "top-left" | "bottom-right" }[] = [];
    const add = (c: IControl, pos: "top-right" | "top-left" | "bottom-right") => {
      map.addControl(c, pos);
      controls.push({ c, pos });
    };

    add(new NavigationControl({ showZoom: isDesktop, showCompass: true, visualizePitch: false }), "top-right");
    const geo = new GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 10000 },
      trackUserLocation: false,
      showAccuracyCircle: true,
      fitBoundsOptions: { maxZoom: 15 },
    });
    geo.on("geolocate", (pos) => {
      const { props: p } = latest.current;
      if (!p.from) {
        p.onPick("from", {
          id: `geo-${Date.now().toString(36)}`,
          name: "Current location",
          kind: "coordinate",
          lat: Math.round(pos.coords.latitude * 1e6) / 1e6,
          lon: Math.round(pos.coords.longitude * 1e6) / 1e6,
        });
      }
    });
    add(geo, "top-right");
    if (RAIL_OVERLAY_AVAILABLE) add(new PortalControl("ot-layers-ctrl", setLayersEl), "top-right");

    // Bottom corners are covered by the sheet on phones: use the top-left there.
    const attrib = new AttributionControl({ compact: true, customAttribution: ROUTING_ATTRIBUTION });
    const metric = new ScaleControl({ unit: "metric", maxWidth: 90 });
    const imperial = new ScaleControl({ unit: "imperial", maxWidth: 90 });
    if (isDesktop) {
      // bottom-* containers prepend: add bottom-most first.
      add(attrib, "bottom-right");
      add(imperial, "bottom-right");
      add(metric, "bottom-right");
    } else {
      add(attrib, "top-left");
      add(metric, "top-left");
      add(imperial, "top-left");
    }

    return () => {
      for (const { c } of controls) {
        try {
          map.removeControl(c);
        } catch {
          /* map already removed */
        }
      }
    };
  }, [map, isDesktop]);

  // ----- theme: swap the basemap (custom layers ride along via transformStyle) -
  useEffect(() => {
    if (!map || appliedTheme.current === theme) return;
    appliedTheme.current = theme;
    map.setStyle(BASEMAP_STYLE_URL[theme]);
  }, [map, theme]);

  // ----- railway overlay ------------------------------------------------------
  useEffect(() => {
    if (RAIL_OVERLAY_AVAILABLE) saveRailPrefs(rail);
  }, [rail]);

  useEffect(() => {
    if (!map || !map.getLayer(LYR.rail)) return;
    try {
      map.setLayoutProperty(LYR.rail, "visibility", railOn ? "visible" : "none");
      const src = map.getSource<RasterTileSource>(SRC.rail);
      const tiles = railTiles(rail.view);
      if (src && src.tiles?.[0] !== tiles[0]) src.setTiles(tiles);
    } catch {
      /* style mid-swap: transformStyle applies the current prefs */
    }
    setPaint(map, LYR.rail, railPaint(theme, rail.view, hasRoute));
  }, [map, railOn, rail.view, theme, hasRoute]);

  // ----- data -------------------------------------------------------------------
  useEffect(() => {
    if (!map) return;
    map.getSource<GeoJSONSource>(SRC.alt)?.setData(altFC);
    try {
      map.removeFeatureState({ source: SRC.alt });
    } catch {
      /* not loaded yet */
    }
  }, [map, altFC]);

  useEffect(() => {
    map?.getSource<GeoJSONSource>(SRC.legs)?.setData(legsFC);
  }, [map, legsFC]);

  useEffect(() => {
    map?.getSource<GeoJSONSource>(SRC.stops)?.setData(stopsFC);
  }, [map, stopsFC]);

  useEffect(() => {
    map?.getSource<GeoJSONSource>(SRC.ends)?.setData(endsFC);
  }, [map, endsFC]);

  // ----- hover emphasis from the detail panel ------------------------------------
  useEffect(() => {
    if (!map) return;
    try {
      map.setGlobalStateProperty(HOVER_LEG, hoverLeg);
    } catch {
      /* applied on style.load */
    }
    for (const b of badgeEntries.current) {
      b.el.classList.toggle("is-hot", hoverLeg === b.badge.legIndex);
      b.el.classList.toggle("is-dim", hoverLeg !== -1 && hoverLeg !== b.badge.legIndex);
    }
  }, [map, hoverLeg, badges]);

  // ----- A / B markers -----------------------------------------------------------
  useEffect(() => {
    if (!map) return;
    for (const which of ["from", "to"] as const) {
      const place = which === "from" ? from : to;
      let marker = endpoints.current[which];
      if (!place) {
        marker?.remove();
        endpoints.current[which] = undefined;
        continue;
      }
      if (!marker) {
        const m = new Marker({ element: endpointElement(which), draggable: true, anchor: "center", className: "ot-pin-marker" });
        m.on("dragend", () => latest.current.props.onPick(which, droppedPin(m.getLngLat())));
        m.setLngLat([place.lon, place.lat]).addTo(map);
        endpoints.current[which] = marker = m;
      } else {
        marker.setLngLat([place.lon, place.lat]);
      }
      const el = marker.getElement().querySelector(".ot-pin") as HTMLElement | null;
      if (el) el.title = `${which === "from" ? "Start" : "End"}: ${place.name} · drag to move`;
    }
  }, [map, from, to]);

  // ----- line badges ---------------------------------------------------------------
  const layoutBadges = useCallback(() => {
    const m = mapRef.current;
    if (!m || !badgeEntries.current.length) return;
    const c = m.getContainer();
    const W = c.clientWidth;
    const H = c.clientHeight;
    const pad = latest.current.padding;
    const avoid = BADGE_AVOID_LAYERS.filter((id) => m.getLayer(id));

    // The A/B pins are DOM too: keep badges off them.
    const placed: DOMRect[] = [];
    const { from: f, to: t } = latest.current.props;
    for (const p of [f, t]) {
      if (!p) continue;
      const q = m.project([p.lon, p.lat]);
      placed.push(new DOMRect(q.x - 19, q.y - 19, 38, 38));
    }
    const pins = placed.length;

    const overlaps = (r: DOMRect, q: DOMRect) => r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top;
    const onPin = (r: DOMRect) => placed.slice(0, pins).some((q) => overlaps(r, q));
    const onBadge = (r: DOMRect) => placed.slice(pins).some((q) => overlaps(r, q));

    // Longest legs choose first. Each badge tries points along its leg (on the
    // line, then just beside it) and takes the one that covers the fewest
    // station labels / dots. It never covers a major station or its label:
    // rather than that it hides until the user zooms in.
    const entries = [...badgeEntries.current].sort((a, b) => screenSize(m, b.bounds) - screenSize(m, a.bounds));
    for (const e of entries) {
      const w = e.el.offsetWidth || 90;
      const h = e.el.offsetHeight || 22;
      const tooShort = screenSize(m, e.bounds) < Math.min(48, w * 0.55);
      let best: { score: number; coord: [number, number]; offset: [number, number]; rect: DOMRect } | null = null;
      if (!tooShort) {
        outer: for (const cand of e.badge.candidates) {
          const p = m.project(cand.coord);
          const q = m.project(cand.ahead);
          const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
          // Unit normal to the line; push far enough to clear the line + casing.
          const nx = -(q.y - p.y) / len;
          const ny = (q.x - p.x) / len;
          const push = Math.abs(nx) * (w / 2 + 8) + Math.abs(ny) * (h / 2 + 8);
          const offsets: [number, number, number][] = [
            [0, 0, 0],
            [nx * push, ny * push, 2.5],
            [-nx * push, -ny * push, 2.5],
          ];
          for (const [dx, dy, penalty] of offsets) {
            const cx = p.x + dx;
            const cy = p.y + dy;
            const rect = new DOMRect(cx - w / 2 - 3, cy - h / 2 - 3, w + 6, h + 6);
            if (onBadge(rect)) continue; // never on another badge
            let score = cand.offCenter * 4 + penalty;
            if (onPin(rect)) score += 40;
            const inOpen = cx > pad.left && cx < W - pad.right && cy > pad.top && cy < H - pad.bottom;
            if (!inOpen) score += 20;
            if (avoid.length) {
              const feats = m.queryRenderedFeatures(
                [
                  [rect.left, rect.top],
                  [rect.right, rect.bottom],
                ],
                { layers: avoid },
              );
              for (const ft of feats) {
                const id = ft.layer.id;
                score += id === LYR.stopMajorLabel || id === LYR.stopMajor ? 40 : id === LYR.stopMinorLabel ? 3 : 1.5;
              }
            }
            if (!best || score < best.score) best = { score, coord: cand.coord, offset: [dx, dy], rect };
            if (score < 0.5) break outer; // the middle of the line is free
          }
        }
      }
      const hide = !best || best.score >= 40;
      e.el.classList.toggle("is-hidden", hide);
      e.el.tabIndex = hide ? -1 : 0;
      if (best && !hide) {
        e.marker.setLngLat(best.coord).setOffset(best.offset);
        placed.push(best.rect);
      }
    }
  }, []);

  useEffect(() => {
    if (!map) return;
    for (const b of badgeEntries.current) b.marker.remove();
    const sel = latest.current.selected;
    badgeEntries.current = badges.map((badge) => {
      const el = badgeElement(badge);
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const leg = latest.current.selected?.legs[badge.legIndex];
        if (leg) fitTo(legBounds(leg), 16);
      });
      const marker = new Marker({ element: el, anchor: "center", className: "ot-badge-marker", subpixelPositioning: true })
        .setLngLat(badge.coord)
        .addTo(map);
      const leg = sel?.legs[badge.legIndex];
      return { badge, marker, el, bounds: leg ? legBounds(leg) : null };
    });
    const raf = requestAnimationFrame(layoutBadges);
    return () => cancelAnimationFrame(raf);
  }, [map, badges, fitTo, layoutBadges]);

  useEffect(() => {
    if (!map) return;
    map.on("moveend", layoutBadges);
    return () => {
      map.off("moveend", layoutBadges);
    };
  }, [map, layoutBadges]);

  // ----- camera ------------------------------------------------------------------------
  useEffect(() => {
    const m = map;
    if (!m) return;
    let key = "";
    if (selected) key = `j:${journeyShapeKey(selected)}`;
    else if (from && to) key = abKey(from, to);
    else if (from || to) key = pKey((from ?? to)!);
    if (!key || key === lastFitKey.current) {
      lastFitKey.current = key || lastFitKey.current;
      return;
    }
    lastFitKey.current = key;

    if (selected) {
      fitTo(withPlaces(journeyBounds(selected), from, to), 16);
    } else if (from && to) {
      fitTo(placeBounds(from, to), 15);
    } else {
      const p = (from ?? to)!;
      const pad = safePadding(m, latest.current.padding);
      if (m.getZoom() >= 11 && inOpenView(m, p, pad)) return; // already in sight
      m.easeTo({ center: [p.lon, p.lat], zoom: Math.max(m.getZoom(), POINT_ZOOM), padding: pad, duration: 800 });
    }
  }, [map, selected, from, to, fitTo]);

  useEffect(() => {
    if (focusNonce === lastNonce.current) return;
    lastNonce.current = focusNonce;
    if (focusLegIndex == null || !selected) return;
    const leg = selected.legs[focusLegIndex];
    if (leg) fitTo(legBounds(leg), leg.mode === "WALK" ? 17 : 16);
  }, [focusNonce, focusLegIndex, selected, fitTo]);

  return (
    <>
      <div ref={containerRef} className="ot-map" />
      {layersEl &&
        createPortal(
          <RailLayersControl prefs={{ ...rail, on: railOn }} onChange={(p) => { setRailBroken(false); setRail(p); }} />,
          layersEl,
        )}
    </>
  );
}

function abKey(a: Place, b: Place): string {
  return `ab:${a.lat},${a.lon}|${b.lat},${b.lon}`;
}
function pKey(p: Place): string {
  return `p:${p.lat},${p.lon}`;
}

/** Larger side of the projected bounds, in px. */
function screenSize(m: MLMap, b: Bounds | null): number {
  if (!b) return 0;
  const a = m.project(b[0]);
  const c = m.project(b[1]);
  return Math.max(Math.abs(a.x - c.x), Math.abs(a.y - c.y));
}
