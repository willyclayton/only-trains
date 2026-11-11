"use client";

import React, { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowRightLeft,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  CornerUpLeft,
  CornerUpRight,
  ExternalLink,
  Footprints,
  Hourglass,
  MapPin,
  TrainFront,
  TriangleAlert,
} from "lucide-react";
import type { Journey, Leg, Place, StopTime, WalkStep } from "@/lib/types";
import {
  delayMinutes,
  formatClock,
  formatDay,
  formatDistance,
  formatDuration,
  formatTzName,
} from "@/lib/format";
import LineChip from "./LineChip";
import { EndpointMarker, UiKeyframes } from "./ui/icons";
import { StackedBar, Swatch } from "./ui/ProportionBar";
import {
  breakdown,
  browserTz,
  dayOffset,
  gapSeconds,
  isPlaceholderName,
  isRail,
  journeyTz,
  legColor,
  lineLabel,
  transfersLabel,
  WALK_DOTS_Y,
} from "./ui/journey";

export type JourneyDetailProps = {
  journey: Journey;
  from: Place | null;
  to: Place | null;
  onBack: () => void;
  onHoverLeg: (index: number | null) => void;
  onFocusLeg: (index: number) => void;
  hoveredLegIndex: number | null;
};

// ---------- timeline primitives ----------

type Seg = { kind: "rail"; color: string } | { kind: "walk" } | { kind: "wait" } | null;
type TrackNode = "A" | "B" | "station" | "stop" | "none";

const DOT_Y = 17; // px from the row top to the node center; matches the first text line

function segStyle(seg: Seg): { className: string; style?: CSSProperties } | null {
  if (!seg) return null;
  if (seg.kind === "rail") return { className: "w-[6px]", style: { backgroundColor: seg.color } };
  if (seg.kind === "walk") return { className: "w-[6px]", style: { background: WALK_DOTS_Y } };
  return { className: "w-[2px] bg-line-strong" };
}

function Track({ top, bottom, node, color }: { top: Seg; bottom: Seg; node: TrackNode; color?: string }) {
  const t = segStyle(top);
  const b = segStyle(bottom);
  return (
    <div className="relative" aria-hidden>
      {t && (
        <span
          className={`absolute left-1/2 top-0 -translate-x-1/2 ${t.className}`}
          style={{ ...t.style, height: node === "none" ? "100%" : DOT_Y }}
        />
      )}
      {b && node !== "none" && (
        <span className={`absolute bottom-0 left-1/2 -translate-x-1/2 ${b.className}`} style={{ ...b.style, top: DOT_Y }} />
      )}
      {node === "A" || node === "B" ? (
        <span className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2" style={{ top: DOT_Y }}>
          <EndpointMarker which={node} size={18} className="ring-[3px] ring-panel" />
        </span>
      ) : node === "station" ? (
        <span
          className="absolute left-1/2 size-[14px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3.5px] bg-panel"
          style={{ top: DOT_Y, borderColor: color }}
        />
      ) : node === "stop" ? (
        <span
          className="absolute left-1/2 size-[8px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-panel"
          style={{ top: DOT_Y - 6, borderColor: color }}
        />
      ) : null}
    </div>
  );
}

const GRID = "grid grid-cols-[3.75rem_1.5rem_minmax(0,1fr)] gap-x-2";

/** One timeline row: time | track | content. */
function Row({
  time,
  top = null,
  bottom = null,
  node = "none",
  color,
  children,
  className = "",
}: {
  time?: ReactNode;
  top?: Seg;
  bottom?: Seg;
  node?: TrackNode;
  color?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${GRID} ${className}`}>
      <div className="pt-[7px] text-right">{time}</div>
      <Track top={top} bottom={bottom ?? (node === "none" ? null : null)} node={node} color={color} />
      <div className="min-w-0 py-1.5">{children}</div>
    </div>
  );
}

/** A row whose track is one continuous segment (no node). */
function BodyRow({ seg, children, className = "" }: { seg: Seg; children?: ReactNode; className?: string }) {
  return (
    <div className={`${GRID} ${className}`}>
      <div />
      <Track top={seg} bottom={null} node="none" />
      <div className="min-w-0 py-1">{children}</div>
    </div>
  );
}

// ---------- time cells ----------

function TimeCell({
  actual,
  scheduled,
  tz,
  realTime,
  showTz,
  muted = false,
}: {
  actual?: string;
  scheduled?: string;
  tz?: string;
  realTime?: boolean;
  showTz: boolean;
  muted?: boolean;
}) {
  if (!actual) return null;
  const delay = delayMinutes(actual, scheduled);
  const tone = delay > 0 ? "text-warn" : realTime ? "text-ok" : muted ? "text-muted" : "text-ink";
  return (
    <div className="leading-tight tabular">
      <span className={`block whitespace-nowrap ${muted ? "text-[12px]" : "text-[13.5px] font-semibold"} ${tone}`}>
        {formatClock(actual, tz)}
      </span>
      {delay !== 0 && scheduled && (
        <span className="block whitespace-nowrap text-[11px] text-faint line-through" title="Scheduled">
          {formatClock(scheduled, tz)}
        </span>
      )}
      {showTz && tz && <span className="block text-[10px] font-medium text-faint">{formatTzName(actual, tz)}</span>}
    </div>
  );
}

function DelayBadge({ actual, scheduled }: { actual?: string; scheduled?: string }) {
  const d = delayMinutes(actual, scheduled);
  if (!d) return null;
  return (
    <span className={`font-semibold tabular ${d > 0 ? "text-warn" : "text-ok"}`}>
      {d > 0 ? `${d} min late` : `${-d} min early`}
    </span>
  );
}

/** "Platform 1 · 2 min late · Wait 2 min", skipping empty parts. */
function MetaLine({ items }: { items: (React.ReactElement<{ actual?: string; scheduled?: string }> | null)[] }) {
  const shown = items.filter(
    (el): el is React.ReactElement<{ actual?: string; scheduled?: string }> =>
      !!el && (el.type !== DelayBadge || delayMinutes(el.props.actual, el.props.scheduled) !== 0),
  );
  if (!shown.length) return null;
  return (
    <p className="text-[12px] leading-4 text-muted">
      {shown.map((el, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden> · </span>}
          {el}
        </span>
      ))}
    </p>
  );
}

// ---------- main ----------

export default function JourneyDetail({ journey: j, from, to, onBack, onHoverLeg, onFocusLeg, hoveredLegIndex }: JourneyDetailProps) {
  const tz = journeyTz(j);
  const myTz = useMemo(() => browserTz(), []);
  const showTz = (stopTz?: string) => !!stopTz && !!myTz && stopTz !== myTz;
  const b = breakdown(j);
  const plusDays = dayOffset(j.startTime, j.endTime, tz);
  const live = j.legs.some((l) => isRail(l) && l.realTime);
  const legs = j.legs;

  const originName = (stop: StopTime) => (from?.name && (isPlaceholderName(stop.name) || legs[0]?.mode === "WALK") ? from.name : stop.name);
  const destName = (stop: StopTime) =>
    to?.name && (isPlaceholderName(stop.name) || legs[legs.length - 1]?.mode === "WALK") ? to.name : stop.name;

  return (
    <div className="pb-6">
      <UiKeyframes />
      {/* sticky top bar */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-panel px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-8 items-center gap-0.5 rounded-lg pl-1 pr-2.5 text-[13px] font-medium text-ink-2 hover:bg-panel-2 hover:text-ink"
        >
          <ChevronLeft size={17} aria-hidden />
          All routes
        </button>
        <p className="ml-auto truncate pr-2 text-[12px] text-muted tabular">
          {formatClock(j.startTime, tz)} – {formatClock(j.endTime, tz)}
        </p>
      </div>

      {/* summary */}
      <header className="px-4 pt-4">
        <p className="text-[24px] font-semibold leading-tight tracking-[-0.015em] text-ink tabular">
          {formatClock(j.startTime, tz)}
          <span className="mx-1.5 font-normal text-faint">→</span>
          {formatClock(j.endTime, tz)}
          {plusDays > 0 && <sup className="ml-0.5 text-[12px] font-semibold text-muted">+{plusDays}</sup>}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted">
          <span>{formatDay(j.startTime, tz)}</span>
          <span aria-hidden>·</span>
          <span>{transfersLabel(j.transfers)}</span>
          {showTz(tz) && (
            <>
              <span aria-hidden>·</span>
              <span>Times in {formatTzName(j.startTime, tz)}</span>
            </>
          )}
          {live && (
            <span className="ml-1 inline-flex items-center gap-1 text-[12px] font-semibold text-ok">
              <span className="size-1.5 rounded-full bg-ok" aria-hidden />
              Live
            </span>
          )}
        </p>

        {/* trip time breakdown */}
        <section aria-label="Trip time breakdown" className="mt-3.5 rounded-xl border border-line bg-panel-2 px-3.5 pb-3 pt-2.5">
          <div className="flex items-baseline justify-between">
            <span className="text-[12px] font-medium text-muted">Total trip</span>
            <span className="text-[18px] font-semibold text-ink tabular">{formatDuration(b.duration)}</span>
          </div>
          <div className="mt-2">
            <StackedBar rail={b.railDuration} walk={b.walkDuration} wait={b.waitDuration} />
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2">
            <Stat kind="rail" label="On trains" value={b.railDuration > 0 ? formatDuration(b.railDuration) : "None"} sub={b.railDistance > 0 ? formatDistance(b.railDistance) : undefined} />
            <Stat kind="walk" label="Walking" value={formatDuration(b.walkDuration)} sub={b.walkDistance > 0 ? formatDistance(b.walkDistance) : undefined} />
            <Stat
              kind="wait"
              label="Waiting"
              value={b.waitDuration >= 30 ? formatDuration(b.waitDuration) : "None"}
              sub={j.transfers > 0 ? transfersLabel(j.transfers) : "at stations"}
            />
          </dl>
        </section>
      </header>

      {/* step-by-step timeline */}
      <ol className="mt-4 px-2" aria-label="Step by step">
        {legs.map((leg, i) => {
          const prev = legs[i - 1];
          const next = legs[i + 1];
          const hovered = hoveredLegIndex === i;
          const common = {
            index: i,
            hovered,
            onHoverLeg,
            onFocusLeg,
          };
          if (leg.mode === "WALK") {
            const prevRail = prev && isRail(prev) ? prev : undefined;
            const nextRail = next && isRail(next) ? next : undefined;
            return (
              <LegBlock key={i} {...common} label={`Walk ${formatDuration(leg.duration)}`}>
                {i === 0 && (
                  <Row
                    node="A"
                    bottom={{ kind: "walk" }}
                    time={<TimeCell actual={leg.startTime} tz={leg.from.tz ?? tz} showTz={showTz(leg.from.tz ?? tz)} />}
                  >
                    <StationTitle name={originName(leg.from)} detail={from?.detail} />
                  </Row>
                )}
                {prevRail && nextRail && (
                  <BodyRow seg={{ kind: "walk" }}>
                    <TransferCallout
                      text={
                        prevRail.to.name === nextRail.from.name
                          ? `Transfer at ${nextRail.from.name}`
                          : `Transfer to ${nextRail.from.name}`
                      }
                      seconds={gapSeconds(prevRail.endTime, nextRail.startTime)}
                    />
                  </BodyRow>
                )}
                <WalkBody leg={leg} />
                {!next && (
                  <Row
                    node="B"
                    top={{ kind: "walk" }}
                    time={<TimeCell actual={leg.endTime} tz={leg.to.tz ?? tz} showTz={showTz(leg.to.tz ?? tz)} />}
                  >
                    <StationTitle name={destName(leg.to)} detail={to?.detail} />
                  </Row>
                )}
              </LegBlock>
            );
          }

          // rail leg
          const color = legColor(leg);
          const topSeg: Seg = !prev ? null : prev.mode === "WALK" ? { kind: "walk" } : { kind: "wait" };
          const bottomSeg: Seg = !next ? null : next.mode === "WALK" ? { kind: "walk" } : { kind: "wait" };
          const waitBefore = prev?.mode === "WALK" ? gapSeconds(prev.endTime, leg.startTime) : 0;
          return (
            <LegBlock
              key={i}
              {...common}
              label={`${lineLabel(leg.line, leg.mode)} from ${leg.from.name} to ${leg.to.name}`}
            >
              {prev && isRail(prev) && (
                <BodyRow seg={{ kind: "wait" }}>
                  <TransferCallout
                    text={prev.to.name === leg.from.name ? `Transfer at ${leg.from.name}` : `Transfer to ${leg.from.name}`}
                    seconds={gapSeconds(prev.endTime, leg.startTime)}
                  />
                </BodyRow>
              )}
              <RailLeg
                leg={leg}
                color={color}
                topSeg={topSeg}
                bottomSeg={bottomSeg}
                first={!prev}
                last={!next}
                waitBefore={waitBefore}
                tz={tz}
                showTz={showTz}
                boardName={!prev ? originName(leg.from) : leg.from.name}
                alightName={!next ? destName(leg.to) : leg.to.name}
              />
            </LegBlock>
          );
        })}
      </ol>
    </div>
  );
}

function Stat({ kind, label, value, sub }: { kind: "rail" | "walk" | "wait"; label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-[11.5px] text-muted">
        <Swatch kind={kind} />
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-[14px] font-semibold text-ink tabular">{value}</dd>
      {sub && <dd className="truncate text-[11.5px] text-muted tabular">{sub}</dd>}
    </div>
  );
}

/** Wraps one leg's rows: hover → highlight on map; click / Enter → zoom to it. */
function LegBlock({
  index,
  hovered,
  onHoverLeg,
  onFocusLeg,
  label,
  children,
}: {
  index: number;
  hovered: boolean;
  onHoverLeg: (i: number | null) => void;
  onFocusLeg: (i: number) => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <li
      tabIndex={0}
      aria-label={`${label}. Press Enter to show on the map.`}
      onMouseEnter={() => onHoverLeg(index)}
      onMouseLeave={() => onHoverLeg(null)}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onHoverLeg(index);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHoverLeg(null);
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button")) return;
        onFocusLeg(index);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFocusLeg(index);
        }
      }}
      className={`cursor-pointer rounded-xl outline-offset-[-2px] transition-colors ${hovered ? "bg-panel-2" : ""}`}
    >
      {children}
    </li>
  );
}

function StationTitle({ name, detail, sub }: { name: string; detail?: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[14.5px] font-semibold leading-5 text-ink [overflow-wrap:anywhere]">{name}</p>
      {detail && <p className="truncate text-[12px] leading-4 text-muted">{detail}</p>}
      {sub}
    </div>
  );
}

function TransferCallout({ text, seconds }: { text: string; seconds: number }) {
  return (
    <p className="my-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[12px] font-medium text-ink-2">
      <ArrowRightLeft size={12} aria-hidden className="shrink-0 text-muted" />
      <span className="truncate">{text}</span>
      {seconds >= 30 && <span className="shrink-0 text-muted tabular">· {formatDuration(seconds)}</span>}
    </p>
  );
}

// ---------- walk ----------

function stepIcon(s: WalkStep) {
  const t = s.instruction.toLowerCase();
  if (/\barrive|destination|\bat the\b/.test(t) && s.distance === 0) return MapPin;
  if (/\bleft\b/.test(t)) return CornerUpLeft;
  if (/\bright\b/.test(t)) return CornerUpRight;
  return ArrowUp;
}

function WalkBody({ leg }: { leg: Leg }) {
  const [open, setOpen] = useState(false);
  const steps = leg.steps ?? [];
  return (
    <BodyRow seg={{ kind: "walk" }}>
      <div className="py-1.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[13.5px] text-ink-2">
            <Footprints size={15} aria-hidden className="text-muted" />
            <span>
              Walk <span className="font-semibold text-ink tabular">{formatDuration(leg.duration)}</span>
              {leg.distance != null && leg.distance > 0 && <span className="text-muted tabular"> · {formatDistance(leg.distance)}</span>}
            </span>
          </span>
          {steps.length > 0 && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="ml-auto inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-[12px] font-medium text-muted hover:bg-panel hover:text-ink"
            >
              {open ? "Hide" : "Directions"}
              <ChevronDown size={14} aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
          )}
        </div>
        {open && steps.length > 0 && (
          <ol className="ot-fade-in mt-1.5 space-y-0.5 border-l border-line pl-3">
            {steps.map((s, k) => {
              const Icon = stepIcon(s);
              return (
                <li key={k} className="flex items-start gap-2 py-0.5 text-[12.5px] leading-[18px] text-ink-2">
                  <Icon size={13} aria-hidden className="mt-[2px] shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{s.instruction}</span>
                  {s.distance > 0 && <span className="shrink-0 text-muted tabular">{formatDistance(s.distance)}</span>}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </BodyRow>
  );
}

// ---------- rail ----------

function RailLeg({
  leg,
  color,
  topSeg,
  bottomSeg,
  first,
  last,
  waitBefore,
  tz,
  showTz,
  boardName,
  alightName,
}: {
  leg: Leg;
  color: string;
  topSeg: Seg;
  bottomSeg: Seg;
  first: boolean;
  last: boolean;
  waitBefore: number;
  tz?: string;
  showTz: (tz?: string) => boolean;
  boardName: string;
  alightName: string;
}) {
  const [stopsOpen, setStopsOpen] = useState(false);
  const rail: Seg = { kind: "rail", color };
  const stops = leg.intermediateStops ?? [];
  const line = leg.line;
  const label = lineLabel(line, leg.mode, "full");
  const trip = line?.tripName && line.tripName !== label ? line.tripName : undefined;
  const fromTz = leg.from.tz ?? tz;
  const toTz = leg.to.tz ?? tz;

  return (
    <>
      {/* boarding */}
      <Row
        node={first ? "A" : "station"}
        color={color}
        top={topSeg}
        bottom={rail}
        time={
          <TimeCell
            actual={leg.startTime}
            scheduled={leg.scheduledStartTime}
            realTime={leg.realTime}
            tz={fromTz}
            showTz={showTz(fromTz)}
          />
        }
      >
        <StationTitle
          name={boardName}
          sub={
            <MetaLine
              items={[
                leg.from.track ? <span key="t">Platform {leg.from.track}</span> : null,
                <DelayBadge key="d" actual={leg.startTime} scheduled={leg.scheduledStartTime} />,
                waitBefore >= 60 ? (
                  <span key="w" className="inline-flex items-center gap-1">
                    <Hourglass size={11} aria-hidden />
                    Wait {formatDuration(waitBefore)}
                  </span>
                ) : null,
              ]}
            />
          }
        />
      </Row>

      {/* line + direction */}
      <BodyRow seg={rail}>
        <div className="pb-0.5 pt-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <LineChip line={line} mode={leg.mode} icon full />
            {leg.headsign && (
              <span className="min-w-0 text-[13px] leading-5 text-ink-2">
                <span className="text-muted">towards</span> {leg.headsign}
              </span>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-4 text-muted">
            {trip && (
              <span className="inline-flex items-center gap-1 font-medium text-ink-2">
                <TrainFront size={12} aria-hidden />
                {trip}
              </span>
            )}
            {trip && line?.agency && <span aria-hidden>·</span>}
            {line?.agency &&
              (line.agencyUrl ? (
                <a
                  href={line.agencyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-w-0 items-center gap-0.5 underline decoration-line-strong underline-offset-2 hover:text-ink"
                >
                  <span className="truncate">{line.agency}</span>
                  <ExternalLink size={11} aria-hidden className="shrink-0" />
                </a>
              ) : (
                <span className="truncate">{line.agency}</span>
              ))}
            {leg.realTime ? (
              <span className="inline-flex items-center gap-1 font-semibold text-ok">
                <span className="size-1.5 rounded-full bg-ok" aria-hidden />
                Live
              </span>
            ) : (
              <span className="text-faint">Scheduled</span>
            )}
            {leg.cancelled && <span className="font-semibold text-danger">Cancelled</span>}
          </p>
          {leg.alerts?.length ? <Alerts alerts={leg.alerts} /> : null}
        </div>
      </BodyRow>

      {/* intermediate stops */}
      <BodyRow seg={rail}>
        {stops.length > 0 ? (
          <button
            type="button"
            aria-expanded={stopsOpen}
            onClick={() => setStopsOpen((o) => !o)}
            className="-ml-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-ink-2 hover:bg-panel hover:text-ink"
          >
            <ChevronDown size={14} aria-hidden className={`text-muted transition-transform ${stopsOpen ? "" : "-rotate-90"}`} />
            <span>
              {stops.length} {stops.length === 1 ? "stop" : "stops"}
              <span className="text-muted tabular"> · {formatDuration(leg.duration)}</span>
              {leg.distance ? <span className="text-muted tabular"> · {formatDistance(leg.distance)}</span> : null}
            </span>
          </button>
        ) : (
          <p className="py-1 text-[12.5px] text-ink-2">
            Non-stop <span className="text-muted tabular">· {formatDuration(leg.duration)}</span>
          </p>
        )}
      </BodyRow>
      {stopsOpen &&
        stops.map((s, k) => (
          <div key={k} className={`${GRID} ot-fade-in`}>
            <div className="pt-[3px] text-right">
              <TimeCell actual={s.departure ?? s.arrival} scheduled={s.scheduledDeparture ?? s.scheduledArrival} tz={s.tz ?? fromTz} showTz={false} muted />
            </div>
            <Track top={rail} bottom={rail} node="stop" color={color} />
            <p className="min-w-0 truncate py-[3px] text-[12.5px] leading-[18px] text-ink-2">{s.name}</p>
          </div>
        ))}

      {/* alighting */}
      <Row
        node={last ? "B" : "station"}
        color={color}
        top={rail}
        bottom={bottomSeg}
        time={
          <TimeCell actual={leg.endTime} scheduled={leg.scheduledEndTime} realTime={leg.realTime} tz={toTz} showTz={showTz(toTz)} />
        }
      >
        <StationTitle
          name={alightName}
          sub={
            <MetaLine
              items={[
                leg.to.track ? <span key="t">Platform {leg.to.track}</span> : null,
                <DelayBadge key="d" actual={leg.endTime} scheduled={leg.scheduledEndTime} />,
              ]}
            />
          }
        />
      </Row>
    </>
  );
}

function Alerts({ alerts }: { alerts: NonNullable<Leg["alerts"]> }) {
  const [open, setOpen] = useState(false);
  const first = alerts[0];
  return (
    <div className="mt-2 rounded-lg border border-line bg-panel px-2.5 py-2 text-[12px] leading-snug">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-1.5 text-left">
        <TriangleAlert size={13} aria-hidden className="mt-[1px] shrink-0 text-warn" />
        <span className="min-w-0 flex-1 font-medium text-ink-2">
          {first.header || "Service alert"}
          {alerts.length > 1 && <span className="font-normal text-muted"> · +{alerts.length - 1} more</span>}
        </span>
        <ChevronDown size={13} aria-hidden className={`mt-[1px] shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-1.5 space-y-2 pl-[19px]">
          {alerts.map((a, k) => (
            <div key={k}>
              {k > 0 && a.header && <p className="font-medium text-ink-2">{a.header}</p>}
              {a.description && <p className="whitespace-pre-line text-muted [overflow-wrap:anywhere]">{a.description}</p>}
              {a.url && (
                <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-ink-2 underline underline-offset-2">
                  More info <ExternalLink size={11} aria-hidden />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
