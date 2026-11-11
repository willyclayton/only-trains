"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ApiError, Journey, PlanOptions, PlanResponse, Place, RailMode } from "@/lib/types";
import { DEFAULT_MAX_WALK_MINUTES, DEFAULT_MODES, isRailMode } from "@/lib/modes";
import SearchPanel from "./SearchPanel";
import JourneyList from "./JourneyList";
import JourneyDetail from "./JourneyDetail";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-panel-2" />,
});

// ---------- URL state ----------

function parsePlace(v: string | null, name: string | null, id: string): Place | null {
  if (!v) return null;
  const [a, b] = v.split(",").map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { id, lat: a, lon: b, name: name || `${a.toFixed(5)}, ${b.toFixed(5)}`, kind: "coordinate" };
}

function readUrlState(sp: URLSearchParams): { from: Place | null; to: Place | null; options: PlanOptions } {
  const modes = (sp.get("modes") ?? "")
    .split(",")
    .filter(Boolean)
    .filter(isRailMode) as RailMode[];
  const walk = Number(sp.get("walk"));
  return {
    from: parsePlace(sp.get("from"), sp.get("fromName"), "url-from"),
    to: parsePlace(sp.get("to"), sp.get("toName"), "url-to"),
    options: {
      time: sp.get("t") || null,
      arriveBy: sp.get("arr") === "1",
      modes: modes.length ? modes : DEFAULT_MODES,
      maxWalkMinutes: Number.isFinite(walk) && walk > 0 ? walk : DEFAULT_MAX_WALK_MINUTES,
    },
  };
}

function writeUrlState(from: Place | null, to: Place | null, o: PlanOptions) {
  const sp = new URLSearchParams();
  if (from) {
    sp.set("from", `${from.lat.toFixed(6)},${from.lon.toFixed(6)}`);
    sp.set("fromName", from.name);
  }
  if (to) {
    sp.set("to", `${to.lat.toFixed(6)},${to.lon.toFixed(6)}`);
    sp.set("toName", to.name);
  }
  if (o.time) sp.set("t", o.time);
  if (o.arriveBy) sp.set("arr", "1");
  if (o.modes.join(",") !== DEFAULT_MODES.join(",")) sp.set("modes", o.modes.join(","));
  if (o.maxWalkMinutes !== DEFAULT_MAX_WALK_MINUTES) sp.set("walk", String(o.maxWalkMinutes));
  const qs = sp.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

// ---------- layout ----------

function useIsDesktop() {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return desktop;
}

const PANEL_WIDTH = 408;

/** Always visible, even before a search: Transitous requires a visible link to its sources. */
const BASE_ATTRIBUTION = [
  "Routing by Transitous, timetable sources: https://transitous.org/sources/",
  "© OpenStreetMap contributors https://www.openstreetmap.org/copyright",
];

export default function Planner() {
  const sp = useSearchParams();
  const initial = useMemo(() => readUrlState(new URLSearchParams(sp.toString())), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [from, setFrom] = useState<Place | null>(initial.from);
  const [to, setTo] = useState<Place | null>(initial.to);
  const [options, setOptions] = useState<PlanOptions>(initial.options);

  const [result, setResult] = useState<PlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "detail">("list");
  const [hoveredLegIndex, setHoveredLegIndex] = useState<number | null>(null);
  const [focusLegIndex, setFocusLegIndex] = useState<number | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(true);

  const isDesktop = useIsDesktop();
  const abortRef = useRef<AbortController | null>(null);

  // Measure the mobile bottom sheet so the map never fits a route underneath it.
  const sheetRef = useRef<HTMLElement | null>(null);
  const [sheetHeight, setSheetHeight] = useState(0);
  useEffect(() => {
    const el = sheetRef.current;
    if (isDesktop || !el) return;
    const update = () => setSheetHeight(Math.round(el.getBoundingClientRect().height));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isDesktop]);

  // Keep the URL shareable.
  useEffect(() => {
    writeUrlState(from, to, options);
  }, [from, to, options]);

  const runPlan = useCallback(
    async (cursor?: string, direction?: "earlier" | "later") => {
      if (!from || !to) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({
        from: `${from.lat},${from.lon}`,
        to: `${to.lat},${to.lon}`,
        modes: options.modes.join(","),
        maxWalk: String(options.maxWalkMinutes),
        arriveBy: options.arriveBy ? "1" : "0",
      });
      if (options.time) qs.set("time", options.time);
      if (cursor) qs.set("cursor", cursor);
      try {
        const res = await fetch(`/api/plan?${qs}`, { signal: ac.signal });
        const json = (await res.json()) as PlanResponse | ApiError;
        if (!res.ok || "error" in json) {
          const e = json as ApiError;
          throw new Error(e.detail ? `${e.error}: ${e.detail}` : e.error || `Request failed (${res.status})`);
        }
        setResult((prev) => {
          if (!direction || !prev) return json;
          const seen = new Set(prev.journeys.map((j) => j.id));
          const fresh = json.journeys.filter((j) => !seen.has(j.id));
          const journeys = direction === "later" ? [...prev.journeys, ...fresh] : [...fresh, ...prev.journeys];
          return {
            ...prev,
            journeys,
            warnings: Array.from(new Set([...prev.warnings, ...json.warnings])),
            cursors: {
              earlier: direction === "earlier" ? json.cursors?.earlier : prev.cursors?.earlier,
              later: direction === "later" ? json.cursors?.later : prev.cursors?.later,
            },
          };
        });
        if (!direction) {
          setSelectedId(json.journeys[0]?.id ?? null);
          setView("list");
          setHoveredLegIndex(null);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError((e as Error).message || "Something went wrong");
        if (!direction) setResult(null);
      } finally {
        if (abortRef.current === ac) setLoading(false);
      }
    },
    [from, to, options],
  );

  // Re-plan whenever both endpoints or options change.
  useEffect(() => {
    if (from && to) {
      runPlan();
    } else {
      abortRef.current?.abort();
      setResult(null);
      setSelectedId(null);
      setView("list");
      setLoading(false);
      setError(null);
    }
  }, [from, to, options, runPlan]);

  const setPlace = useCallback((which: "from" | "to", place: Place | null) => {
    (which === "from" ? setFrom : setTo)(place);
  }, []);

  // Map picks arrive as raw coordinates; refine the label with a reverse geocode.
  const onPick = useCallback((which: "from" | "to", place: Place) => {
    setPlace(which, place);
    setSheetOpen(true);
    fetch(`/api/reverse?lat=${place.lat}&lon=${place.lon}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { place: Place | null } | null) => {
        const named = json?.place;
        if (!named) return;
        const setter = which === "from" ? setFrom : setTo;
        // Keep the exact clicked coordinates; only adopt the better name.
        setter((cur) =>
          cur && cur.id === place.id ? { ...cur, name: named.name, detail: named.detail, kind: named.kind ?? cur.kind } : cur,
        );
      })
      .catch(() => {});
  }, [setPlace]);

  const onSwap = useCallback(() => {
    setFrom(to);
    setTo(from);
  }, [from, to]);

  const journeys: Journey[] = result?.journeys ?? [];
  const selected = journeys.find((j) => j.id === selectedId) ?? null;

  const onOpen = useCallback((id: string) => {
    setSelectedId(id);
    setView("detail");
    setHoveredLegIndex(null);
  }, []);

  const onFocusLeg = useCallback((i: number) => {
    setFocusLegIndex(i);
    setFocusNonce((n) => n + 1);
  }, []);

  const mapPadding = isDesktop
    ? { top: 48, right: 48, bottom: 48, left: PANEL_WIDTH + 48 }
    : { top: 32, right: 24, bottom: (sheetHeight || Math.round(window.innerHeight * 0.62)) + 16, left: 24 };

  const panelBody =
    view === "detail" && selected ? (
      <JourneyDetail
        journey={selected}
        from={from}
        to={to}
        onBack={() => {
          setView("list");
          setHoveredLegIndex(null);
        }}
        onHoverLeg={setHoveredLegIndex}
        onFocusLeg={onFocusLeg}
        hoveredLegIndex={hoveredLegIndex}
      />
    ) : (
      <>
        <SearchPanel
          from={from}
          to={to}
          onChange={setPlace}
          onSwap={onSwap}
          options={options}
          onOptionsChange={setOptions}
          near={from ?? to}
          loading={loading}
        />
        <JourneyList
          journeys={journeys}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onOpen={onOpen}
          loading={loading}
          error={error}
          warnings={result?.warnings ?? []}
          attribution={result?.attribution?.length ? result.attribution : BASE_ATTRIBUTION}
          originTz={result?.originTz}
          onEarlier={result?.cursors?.earlier ? () => runPlan(result.cursors!.earlier, "earlier") : undefined}
          onLater={result?.cursors?.later ? () => runPlan(result.cursors!.later, "later") : undefined}
          ready={!!from && !!to}
        />
      </>
    );

  return (
    <main className="fixed inset-0 overflow-hidden bg-bg">
      <div className="absolute inset-0">
        <MapView
          from={from}
          to={to}
          journeys={journeys}
          selectedId={selectedId}
          hoveredLegIndex={view === "detail" ? hoveredLegIndex : null}
          focusLegIndex={view === "detail" ? focusLegIndex : null}
          focusNonce={focusNonce}
          onPick={onPick}
          onSelectJourney={(id) => {
            setSelectedId(id);
            setSheetOpen(true);
          }}
          padding={mapPadding}
        />
      </div>

      {isDesktop ? (
        <aside
          className="absolute left-3 top-3 bottom-3 z-10 flex flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-panel"
          style={{ width: PANEL_WIDTH }}
        >
          <Header />
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{panelBody}</div>
        </aside>
      ) : (
        <aside
          ref={sheetRef}
          className="absolute inset-x-0 bottom-0 z-10 flex flex-col overflow-hidden rounded-t-2xl border-t border-line bg-panel shadow-panel transition-[height] duration-300"
          style={{ height: sheetOpen ? "62dvh" : "auto", paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <button
            type="button"
            onClick={() => setSheetOpen((o) => !o)}
            className="flex w-full flex-col items-center gap-2 pt-2"
            aria-label={sheetOpen ? "Collapse panel" : "Expand panel"}
            aria-expanded={sheetOpen}
          >
            <span className="h-1 w-10 rounded-full bg-line-strong" />
          </button>
          <Header compact />
          {sheetOpen && <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{panelBody}</div>}
        </aside>
      )}
    </main>
  );
}

function Header({ compact = false }: { compact?: boolean }) {
  return (
    <header className={`flex items-baseline justify-between px-4 ${compact ? "pb-2 pt-1" : "pb-2 pt-4"}`}>
      <div className="flex items-baseline gap-2">
        <span aria-hidden className="inline-block h-2.5 w-2.5 translate-y-[-1px] rounded-full bg-ink" />
        <h1 className="text-[15px] font-semibold tracking-tight">Only Trains</h1>
      </div>
      <p className="text-xs text-muted">Rail + walking, anywhere</p>
    </header>
  );
}
