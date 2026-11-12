"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Footprints,
  Hourglass,
  Info,
  LoaderCircle,
  RouteOff,
  TrainFront,
} from "lucide-react";
import type { Journey, Leg, Place, StationHint } from "@/lib/types";
import { delayMinutes, formatClock, formatDistance, formatDuration } from "@/lib/format";
import LineChip from "./LineChip";
import { TimelineBar } from "./ui/ProportionBar";
import { breakdown, dayOffset, isRail, journeyTz, lineLabel, roundMinutes, transfersLabel } from "./ui/journey";

export type JourneyListProps = {
  journeys: Journey[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Open the full step-by-step view for a journey. */
  onOpen: (id: string) => void;
  loading: boolean;
  error: string | null;
  warnings: string[];
  attribution: string[];
  originTz?: string;
  /** Present when paging is possible. */
  onEarlier?: () => void;
  onLater?: () => void;
  /** True when both endpoints are set (otherwise show an empty-state hint). */
  ready: boolean;
  /** No-route explanation: endpoints too far from any station. */
  stationHints?: StationHint[];
  fromName?: string;
  toName?: string;
  /** Re-plan with an endpoint moved to the suggested station. */
  onUseStation?: (which: "from" | "to", place: Place) => void;
  /** Straight-line distance between A and B, meters. */
  apart?: number;
  onRetry?: () => void;
  /** Fill A and B with an example trip. */
  onExample?: (from: Place, to: Place) => void;
};

const GEOCODE_ATTRIBUTION = "Search: Transitous & Photon by komoot · © OpenStreetMap contributors";

function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function JourneyList({
  journeys,
  selectedId,
  onSelect,
  onOpen,
  loading,
  error,
  warnings,
  attribution,
  originTz,
  onEarlier,
  onLater,
  ready,
  stationHints,
  fromName,
  toName,
  onUseStation,
  apart,
  onRetry,
  onExample,
}: JourneyListProps) {
  const now = useNow();
  const [paging, setPaging] = useState<"earlier" | "later" | null>(null);
  useEffect(() => {
    if (!loading) setPaging(null);
  }, [loading]);

  if (!ready) {
    return (
      <div className="px-4 pb-4 pt-4">
        <EmptyState onExample={onExample} />
        <Footer attribution={attribution} />
      </div>
    );
  }

  const hasJourneys = journeys.length > 0;
  const replanning = loading && !paging && hasJourneys;

  return (
    <div className="px-3 pb-4 pt-3">
      {warnings.length > 0 && (
        <div className="mb-2.5 space-y-1.5 px-0.5">
          {warnings.map((w) => (
            <p
              key={w}
              className="flex items-start gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[12.5px] leading-snug text-ink-2 [overflow-wrap:anywhere]"
            >
              <Info size={14} aria-hidden className="mt-[1px] shrink-0 text-muted" />
              <span>{w}</span>
            </p>
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="mx-0.5 mb-3 rounded-xl border border-line px-3.5 py-3" role="alert">
          <p className="flex items-center gap-2 text-[14px] font-semibold text-ink">
            <CircleAlert size={16} aria-hidden className="shrink-0 text-danger" />
            Couldn&rsquo;t plan this trip
          </p>
          <p className="mt-1 break-words pl-6 text-[12.5px] leading-snug text-muted">{error}</p>
          <p className="mt-1.5 pl-6 text-[12.5px] leading-snug text-ink-2">Try again in a moment.</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="ml-6 mt-2 inline-flex items-center rounded-full border border-ink px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-panel-2"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {loading && !hasJourneys && <Skeletons />}

      {!loading && !error && !hasJourneys && (
        <NoResults hints={stationHints} fromName={fromName} toName={toName} onUseStation={onUseStation} />
      )}

      {hasJourneys && (
        <>
          <div className="mb-1.5 flex items-center justify-between px-1">
            <p className="text-[12px] font-medium text-muted" aria-live="polite">
              {replanning
                ? "Updating routes…"
                : `${journeys.length} ${journeys.length === 1 ? "route" : "routes"}${journeys.some((j) => j.legs.some(isRail)) ? "" : " on foot"}${apart ? ` · ${formatDistance(apart)} apart` : ""}`}
            </p>
            {onEarlier && (
              <PageButton
                dir="earlier"
                busy={loading && paging === "earlier"}
                onClick={() => {
                  setPaging("earlier");
                  onEarlier();
                }}
              />
            )}
          </div>

          <ul
            className={`space-y-2 transition-opacity ${replanning ? "pointer-events-none opacity-50" : ""}`}
            aria-label="Routes"
            aria-busy={loading}
          >
            {journeys.map((j) => (
              <li key={j.id}>
                <JourneyCard
                  journey={j}
                  selected={j.id === selectedId}
                  onSelect={() => onSelect(j.id)}
                  onOpen={() => onOpen(j.id)}
                  originTz={originTz}
                  now={now}
                />
              </li>
            ))}
          </ul>

          {onLater && (
            <div className="mt-2 flex justify-center">
              <PageButton
                dir="later"
                busy={loading && paging === "later"}
                onClick={() => {
                  setPaging("later");
                  onLater();
                }}
              />
            </div>
          )}
        </>
      )}

      <Footer attribution={attribution} />
    </div>
  );
}

// ---------- card ----------

function JourneyCard({
  journey: j,
  selected,
  onSelect,
  onOpen,
  originTz,
  now,
}: {
  journey: Journey;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  originTz?: string;
  now: number;
}) {
  const tz = journeyTz(j, originTz);
  const plusDays = dayOffset(j.startTime, j.endTime, tz);
  const b = breakdown(j);
  const firstRail = j.legs.find(isRail);
  const cancelled = j.legs.some((l) => isRail(l) && l.cancelled);
  const live = j.legs.some((l) => isRail(l) && l.realTime);

  const boardIn = firstRail ? Math.round((Date.parse(firstRail.startTime) - now) / 60000) : null;
  const delay = firstRail ? delayMinutes(firstRail.startTime, firstRail.scheduledStartTime) : 0;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${formatClock(j.startTime, tz)} to ${formatClock(j.endTime, tz)}, ${formatDuration(b.duration)}, ${transfersLabel(j.transfers)}. Press Enter for details.`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") {
          e.preventDefault();
          onOpen();
        } else if (e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group relative cursor-pointer rounded-xl border bg-panel px-3.5 pb-2.5 pt-3 outline-offset-2 transition-[border-color,box-shadow] ${
        selected
          ? "border-ink shadow-[0_0_0_1px_var(--ink)]"
          : "border-line hover:border-line-strong"
      } ${cancelled ? "opacity-70" : ""}`}
    >
      {/* times + total */}
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 pt-1 text-[17px] font-semibold leading-6 tracking-[-0.01em] text-ink tabular">
          {formatClock(j.startTime, tz)}
          <span className="mx-1 font-normal text-faint">–</span>
          {formatClock(j.endTime, tz)}
          {plusDays > 0 && (
            <sup className="ml-0.5 align-super text-[10.5px] font-semibold text-muted" title={`Arrives ${plusDays} day${plusDays > 1 ? "s" : ""} later`}>
              +{plusDays}
            </sup>
          )}
        </p>
        <p className="shrink-0 text-[16px] font-semibold leading-6 text-ink tabular">{formatDuration(b.duration)}</p>
      </div>

      {/* leg sequence */}
      <LegSequence legs={j.legs} />

      <TimelineBar journey={j} className="mt-2.5" />

      {/* trains / walking / waiting breakdown */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] leading-5 text-ink-2 tabular">
        {b.railDuration > 0 && (
          <span className="inline-flex items-center gap-1" title="Time on trains">
            <TrainFront size={13} aria-hidden className="text-muted" />
            <span className="sr-only">On trains</span>
            {formatDuration(b.railDuration)}
          </span>
        )}
        <span className="inline-flex items-center gap-1" title={`Walking, ${formatDistance(b.walkDistance)}`}>
          <Footprints size={13} aria-hidden className="text-muted" />
          <span className="sr-only">Walking</span>
          {formatDuration(b.walkDuration)}
          {b.walkDistance > 0 && <span className="text-muted">· {formatDistance(b.walkDistance)}</span>}
        </span>
        {b.waitDuration >= 60 && (
          <span className="inline-flex items-center gap-1" title="Waiting at stations">
            <Hourglass size={12} aria-hidden className="text-muted" />
            <span className="sr-only">Waiting</span>
            {formatDuration(b.waitDuration)}
          </span>
        )}
        <span className="ml-auto text-muted">{transfersLabel(j.transfers)}</span>
      </div>

      {/* boarding meta + details */}
      <div className="mt-1.5 flex items-center gap-1 border-t border-line pt-2 text-[12px] leading-4 text-muted">
        {cancelled ? (
          <p className="min-w-0 flex-1 font-semibold text-danger">Cancelled</p>
        ) : firstRail ? (
          <p className="flex min-w-0 flex-1 items-baseline">
            <span className="min-w-0 truncate">
              Board <span className="text-ink-2">{lineLabel(firstRail.line, firstRail.mode)}</span> at{" "}
              <span className="text-ink-2">{firstRail.from.name}</span>
            </span>
            <span className="shrink-0 whitespace-nowrap pl-1">
              <span className={`tabular ${delay > 0 ? "font-medium text-warn" : firstRail.realTime ? "text-ok" : "text-ink-2"}`}>
                {formatClock(firstRail.startTime, firstRail.from.tz ?? tz)}
              </span>
              {delay > 0 && <span className="text-warn"> +{delay}</span>}
              {boardIn != null && boardIn >= 0 && boardIn <= 60 && <span> · {boardIn === 0 ? "now" : `in ${boardIn} min`}</span>}
            </span>
          </p>
        ) : (
          <p className="min-w-0 flex-1">Walk the whole way</p>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className={`-mr-1.5 inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md pl-2 pr-1 text-[12px] font-semibold transition-colors ${
            selected ? "text-ink hover:bg-panel-2" : "text-muted hover:bg-panel-2 hover:text-ink"
          }`}
        >
          Details
          <ChevronRight size={14} aria-hidden />
        </button>
      </div>
      {live && !cancelled && (
        <span className="absolute right-3.5 top-[-7px] inline-flex items-center gap-1 rounded-full border border-line bg-panel px-1.5 text-[10px] font-semibold uppercase leading-[14px] tracking-wide text-ok">
          <span className="size-1.5 rounded-full bg-ok" aria-hidden />
          Live
        </span>
      )}
    </div>
  );
}

/** walk 2 › [Blue Line] › walk 12 — very short transfer walks are left out. */
function LegSequence({ legs }: { legs: Leg[] }) {
  const shown = legs.filter((l, i) => isRail(l) || l.duration >= 60 || legs.length === 1 || (i > 0 && i < legs.length - 1 && l.duration >= 60));
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1.5">
      {shown.map((l, i) => (
        <span key={i} className="inline-flex min-w-0 items-center gap-1">
          {i > 0 && <ChevronRight size={12} aria-hidden className="shrink-0 text-faint" />}
          {l.mode === "WALK" ? (
            <span className="inline-flex items-center gap-0.5 text-[12px] font-medium text-muted tabular" title={`Walk ${formatDuration(l.duration)}`}>
              <Footprints size={13} aria-hidden />
              {l.duration >= 3600 ? formatDuration(l.duration).replace(" min", "") : roundMinutes(l.duration)}
            </span>
          ) : (
            <LineChip line={l.line} mode={l.mode} size="sm" icon compact />
          )}
        </span>
      ))}
    </div>
  );
}

// ---------- states ----------

function PageButton({ dir, busy, onClick }: { dir: "earlier" | "later"; busy: boolean; onClick: () => void }) {
  const Icon = busy ? LoaderCircle : dir === "earlier" ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-60"
    >
      <Icon size={14} aria-hidden className={busy ? "animate-spin" : ""} />
      {dir === "earlier" ? "Earlier" : "Later departures"}
    </button>
  );
}

function Skeletons() {
  return (
    <div className="space-y-2" aria-label="Finding routes" role="status">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-xl border border-line px-3.5 pb-3 pt-3.5" style={{ opacity: 1 - i * 0.22 }}>
          <div className="flex justify-between">
            <span className="h-4 w-40 animate-pulse rounded bg-panel-2" />
            <span className="h-4 w-12 animate-pulse rounded bg-panel-2" />
          </div>
          <div className="mt-3 flex gap-1.5">
            <span className="h-5 w-8 animate-pulse rounded-full bg-panel-2" />
            <span className="h-5 w-20 animate-pulse rounded-full bg-panel-2" />
            <span className="h-5 w-8 animate-pulse rounded-full bg-panel-2" />
          </div>
          <span className="mt-3 block h-1.5 w-full animate-pulse rounded-full bg-panel-2" />
          <span className="mt-3 block h-3 w-3/5 animate-pulse rounded bg-panel-2" />
        </div>
      ))}
      <span className="sr-only">Finding routes…</span>
    </div>
  );
}

function NoResults({
  hints,
  fromName,
  toName,
  onUseStation,
}: {
  hints?: StationHint[];
  fromName?: string;
  toName?: string;
  onUseStation?: (which: "from" | "to", place: Place) => void;
}) {
  if (hints?.length) {
    return (
      <div className="mx-0.5 rounded-xl border border-dashed border-line-strong px-4 py-4">
        <p className="flex items-center gap-2 text-[14px] font-semibold text-ink">
          <RouteOff size={18} aria-hidden className="shrink-0 text-muted" />
          No train-only route found
        </p>
        <ul className="mt-3 space-y-3">
          {hints.map((h, _i, all) => {
            // Moving one end to a station can't help if the other end has none.
            const otherHopeless = all.some((x) => x.which !== h.which && !x.station);
            // "Near X" labels read badly mid-sentence ("50 km of Near X"): drop the prefix.
            const bare = (n?: string) => n?.replace(/^Near\s+/, "");
            const name = bare(h.which === "from" ? fromName : toName) || (h.which === "from" ? "Your start" : "Your destination");
            const other = bare(h.which === "from" ? toName : fromName) || (h.which === "from" ? "your destination" : "your start");
            const st = h.station;
            const em = (t: string) => <span className="font-semibold text-ink">{t}</span>;
            return (
              <li key={h.which} className="text-[13px] leading-snug text-ink-2">
                {!st ? (
                  <p>
                    There are no train timetables within about 280 km of {em(name)}. Tracks may still run there (see the
                    railway overlay), but this region&rsquo;s schedules aren&rsquo;t in the open data Only Trains uses yet.
                  </p>
                ) : h.reachable ? (
                  <p>
                    Trains don&rsquo;t run near {em(name)}. The closest station they connect to{" "}
                    {h.which === "to" ? <>from {em(other)}</> : <>for {em(other)}</>} is {em(st.name)},{" "}
                    {formatDistance(h.distance ?? 0)} away.
                  </p>
                ) : h.reachable === false ? (
                  <p>
                    {em(name)} is {formatDistance(h.distance ?? 0)} from the nearest train station, {em(st.name)}, and
                    no train from {em(other)} reaches a station near it.
                  </p>
                ) : (
                  <p>
                    {em(name)} is {formatDistance(h.distance ?? 0)} from the nearest train station, {em(st.name)}
                    {h.walkMinutes ? <> (about {formatDuration(h.walkMinutes * 60)} on foot)</> : null}.
                  </p>
                )}
                {st && h.reachable && (h.duration || h.lines?.length) ? (
                  <p className="mt-1 flex items-center gap-1.5 text-[12px] text-muted">
                    <TrainFront size={13} aria-hidden className="shrink-0" />
                    <span className="min-w-0 truncate">
                      {h.duration ? formatDuration(h.duration) : null}
                      {h.duration && h.lines?.length ? " · " : null}
                      {h.lines?.join(" › ")}
                    </span>
                  </p>
                ) : null}
                {st && h.reachable !== false && !otherHopeless && onUseStation && (
                  <button
                    type="button"
                    onClick={() => onUseStation(h.which, st)}
                    className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full border border-ink px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-panel-2"
                  >
                    <TrainFront size={14} aria-hidden className="shrink-0" />
                    <span className="truncate">
                      {h.which === "from" ? "Start" : "End"} at {st.name} instead
                    </span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[12px] leading-snug text-muted">Only Trains never uses buses to close the gap.</p>
      </div>
    );
  }
  return (
    <div className="mx-0.5 rounded-xl border border-dashed border-line-strong px-4 py-5 text-center">
      <RouteOff size={22} aria-hidden className="mx-auto text-muted" />
      <p className="mt-2 text-[14px] font-semibold text-ink">No train-only route found</p>
      <p className="mx-auto mt-1 max-w-[19rem] text-[12.5px] leading-snug text-muted">
        Try a longer walk limit, turn on more train types, or pick a different time. Points far from any station may need
        a bus, which Only Trains never uses.
      </p>
    </div>
  );
}

const EXAMPLES: [Place, Place, string][] = [
  [
    { id: "ex-wp", name: "Wicker Park", lat: 41.9088, lon: -87.6776, kind: "city" },
    { id: "ex-loop", name: "The Loop", lat: 41.8826, lon: -87.6233, kind: "city" },
    "Chicago",
  ],
  [
    { id: "ex-shibuya", name: "Shibuya", lat: 35.658, lon: 139.7016, kind: "station" },
    { id: "ex-asakusa", name: "Asakusa", lat: 35.7148, lon: 139.7967, kind: "station" },
    "Tokyo",
  ],
  [
    { id: "ex-gdn", name: "Gare du Nord", lat: 48.8809, lon: 2.3553, kind: "station" },
    { id: "ex-ld", name: "La Défense", lat: 48.8919, lon: 2.238, kind: "station" },
    "Paris",
  ],
];

function EmptyState({ onExample }: { onExample?: (a: Place, b: Place) => void }) {
  return (
    <div className="px-0.5">
      <h2 className="text-[15px] font-semibold tracking-tight text-ink">Where to?</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
        Pick a start and a destination anywhere in the world. You&rsquo;ll get every way there by metro, commuter rail,
        intercity and tram, with walking only at the ends and between platforms. Never a bus.
      </p>
      <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Try</p>
      <ul className="mt-1.5 divide-y divide-line rounded-xl border border-line">
        {EXAMPLES.map(([a, b, city]) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => onExample?.(a, b)}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] text-ink-2 hover:bg-panel-2"
            >
              <span className="truncate font-medium text-ink">{a.name}</span>
              <ChevronRight size={13} aria-hidden className="shrink-0 text-faint" />
              <span className="truncate font-medium text-ink">{b.name}</span>
              <span className="ml-auto shrink-0 text-[12px] text-muted">{city}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Footer({ attribution }: { attribution: string[] }) {
  const items = Array.from(new Set([...attribution, GEOCODE_ATTRIBUTION]));
  return (
    <footer className="mt-5 px-1 text-[10.5px] leading-relaxed text-faint">
      {items.map((a, i) => (
        <span key={a}>
          {i > 0 && <span aria-hidden> · </span>}
          {a.split(/(https?:\/\/[^\s,;)]+)/g).map((part, k) =>
            /^https?:\/\//.test(part) ? (
              <a key={k} href={part} target="_blank" rel="noopener noreferrer" className="underline decoration-line-strong underline-offset-2 hover:text-muted">
                {part.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
              </a>
            ) : (
              part
            ),
          )}
        </span>
      ))}
    </footer>
  );
}
