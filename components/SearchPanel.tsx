"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpDown, Check, Clock, Footprints, TrainFront } from "lucide-react";
import type { PlanOptions, Place, RailMode } from "@/lib/types";
import { DEFAULT_MAX_WALK_MINUTES, MAX_WALK_CHOICES, RAIL_MODES } from "@/lib/modes";
import { formatClock } from "@/lib/format";
import PlaceInput, { type PlaceInputHandle } from "./PlaceInput";
import { PillPopover } from "./ui/Popover";
import { EndpointMarker, ModeIcon, UiKeyframes } from "./ui/icons";

export type SearchPanelProps = {
  from: Place | null;
  to: Place | null;
  onChange: (which: "from" | "to", place: Place | null) => void;
  onSwap: () => void;
  options: PlanOptions;
  onOptionsChange: (options: PlanOptions) => void;
  /** Map center, to bias geocoding results. */
  near?: { lat: number; lon: number } | null;
  loading: boolean;
};

export default function SearchPanel({ from, to, onChange, onSwap, options, onOptionsChange, near, loading }: SearchPanelProps) {
  const fromRef = useRef<PlaceInputHandle>(null);
  const toRef = useRef<PlaceInputHandle>(null);

  const hint = !from && !to ? "both" : !from ? "from" : !to ? "to" : null;

  return (
    <div className="sticky top-0 z-20 border-b border-line bg-panel px-4 pb-3 pt-1">
      <UiKeyframes />
      <div className="flex items-stretch gap-2.5">
        {/* A / B markers joined by a dotted connector, aligned to the two inputs */}
        <div className="flex w-[18px] shrink-0 flex-col items-center py-[11px]" aria-hidden>
          <EndpointMarker which="A" />
          <span
            className="my-1 w-[2px] flex-1"
            style={{
              background: "radial-gradient(circle at center, var(--faint) 1px, transparent 1.3px) center top / 2px 5px repeat-y",
            }}
          />
          <EndpointMarker which="B" />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <PlaceInput
            ref={fromRef}
            label="Start (A)"
            placeholder="Start: station, address or place"
            value={from}
            onChange={(p) => onChange("from", p)}
            near={near}
            onPicked={() => {
              if (!to) window.setTimeout(() => toRef.current?.focus(), 0);
            }}
          />
          <PlaceInput
            ref={toRef}
            label="Destination (B)"
            placeholder="Destination"
            value={to}
            onChange={(p) => onChange("to", p)}
            near={near}
            onPicked={() => {
              if (!from) window.setTimeout(() => fromRef.current?.focus(), 0);
            }}
          />
        </div>

        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={onSwap}
            disabled={!from && !to}
            aria-label="Swap start and destination"
            title="Swap A and B"
            className="flex size-8 items-center justify-center rounded-full border border-line bg-panel text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
          >
            <ArrowUpDown size={15} aria-hidden />
          </button>
        </div>
      </div>

      {hint && (
        <p className="mt-2 pl-[28px] text-[12px] leading-snug text-muted">
          {hint === "both" && (
            <>
              Search, or <TapOrClick /> the map to drop A and B.
            </>
          )}
          {hint === "from" && (
            <>
              Now choose a start: search, or <TapOrClick /> the map.
            </>
          )}
          {hint === "to" && (
            <>
              Now choose a destination: search, or <TapOrClick /> the map.
            </>
          )}
        </p>
      )}

      <div data-popover-boundary className="relative mt-2.5 flex flex-wrap items-center gap-1">
        <TimeOption options={options} onOptionsChange={onOptionsChange} />
        <WalkOption options={options} onOptionsChange={onOptionsChange} />
        <ModesOption options={options} onOptionsChange={onOptionsChange} />
      </div>

      {loading && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-[2px] overflow-hidden" role="progressbar" aria-label="Finding routes">
          <div className="ot-indeterminate h-full w-1/3 rounded-full bg-ink" />
        </div>
      )}
    </div>
  );
}

function TapOrClick() {
  return (
    <>
      <span className="md:hidden">tap</span>
      <span className="hidden md:inline">click</span>
    </>
  );
}

// ---------- time ----------

type TimeMode = "now" | "depart" | "arrive";

function toLocalInput(iso: string | null): string {
  const d = iso ? new Date(iso) : roundedNow();
  if (Number.isNaN(d.getTime())) return toLocalInput(null);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function roundedNow(): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5);
  return d;
}

function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v); // datetime-local is parsed as local time
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function timeLabel(o: PlanOptions): string {
  if (!o.time) return "Leave now";
  const d = new Date(o.time);
  if (Number.isNaN(d.getTime())) return "Leave now";
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const day = sameDay(d, today)
    ? ""
    : sameDay(d, tomorrow)
      ? "tomorrow "
      : `${new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(d)}, `;
  return `${o.arriveBy ? "Arrive by" : "Depart"} ${day}${formatClock(o.time)}`;
}

function TimeOption({ options, onOptionsChange }: { options: PlanOptions; onOptionsChange: (o: PlanOptions) => void }) {
  const current: TimeMode = !options.time ? "now" : options.arriveBy ? "arrive" : "depart";
  // Clock labels depend on the device time zone: render them only after mount (no SSR mismatch).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const label = mounted ? timeLabel(options) : current === "now" ? "Leave now" : current === "arrive" ? "Arrive by…" : "Depart at…";
  const [mode, setMode] = useState<TimeMode>(current);
  const [value, setValue] = useState<string>(toLocalInput(options.time));
  const draft = useRef({ mode, value });
  draft.current = { mode, value };

  const commit = useCallback(() => {
    const { mode: m, value: v } = draft.current;
    const next: PlanOptions =
      m === "now"
        ? { ...options, time: null, arriveBy: false }
        : { ...options, time: fromLocalInput(v) ?? new Date().toISOString(), arriveBy: m === "arrive" };
    if (next.time !== options.time || next.arriveBy !== options.arriveBy) onOptionsChange(next);
  }, [options, onOptionsChange]);

  return (
    <PillPopover
      label={label}
      ariaLabel={`When: ${label}`}
      icon={<Clock size={13} aria-hidden className="shrink-0 text-muted" />}
      active={current !== "now"}
      width={292}
      onOpen={() => {
        setMode(current);
        setValue(toLocalInput(options.time));
      }}
      onClose={commit}
    >
      {(close) => (
        <div className="p-1.5">
          <div role="radiogroup" aria-label="Time" className="grid grid-cols-3 gap-0.5 rounded-lg bg-panel-2 p-0.5">
            {(
              [
                ["now", "Leave now"],
                ["depart", "Depart at"],
                ["arrive", "Arrive by"],
              ] as [TimeMode, string][]
            ).map(([m, l]) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                data-autofocus={mode === m ? "" : undefined}
                onClick={() => {
                  setMode(m);
                  if (m === "now") {
                    draft.current = { mode: m, value };
                    close();
                  }
                }}
                className={`h-8 rounded-md text-[12.5px] font-medium transition-colors ${
                  mode === m ? "bg-panel text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted hover:text-ink"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          {mode !== "now" && (
            <form
              className="mt-2 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                close();
              }}
            >
              <label className="block">
                <span className="sr-only">{mode === "arrive" ? "Arrival time" : "Departure time"}</span>
                <input
                  type="datetime-local"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="h-9 w-full rounded-lg border border-line bg-panel-2 px-2.5 text-[16px] text-ink tabular focus:border-ink focus:outline-none md:text-[13.5px]"
                />
              </label>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11.5px] leading-snug text-muted">In your device&rsquo;s time zone.</p>
                <button
                  type="submit"
                  className="h-8 shrink-0 rounded-lg bg-ink px-3.5 text-[12.5px] font-semibold text-panel hover:opacity-90"
                >
                  Done
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </PillPopover>
  );
}

// ---------- walking ----------

function WalkOption({ options, onOptionsChange }: { options: PlanOptions; onOptionsChange: (o: PlanOptions) => void }) {
  const label = `Walk ≤ ${options.maxWalkMinutes} min`;
  return (
    <PillPopover
      label={label}
      ariaLabel={`Maximum walk: ${options.maxWalkMinutes} minutes`}
      icon={<Footprints size={13} aria-hidden className="shrink-0 text-muted" />}
      active={options.maxWalkMinutes !== DEFAULT_MAX_WALK_MINUTES}
      width={232}
    >
      {(close) => (
        <div>
          <p className="px-2.5 pb-1.5 pt-2 text-[11.5px] leading-snug text-muted">Longest walk at each end of the trip</p>
          <div role="radiogroup" aria-label="Maximum walk">
            {MAX_WALK_CHOICES.map((m) => {
              const on = m === options.maxWalkMinutes;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-autofocus={on ? "" : undefined}
                  onClick={() => {
                    if (!on) onOptionsChange({ ...options, maxWalkMinutes: m });
                    close();
                  }}
                  className={`flex h-9 w-full items-center justify-between rounded-lg px-2.5 text-left text-[13.5px] tabular hover:bg-panel-2 ${
                    on ? "font-semibold text-ink" : "text-ink-2"
                  }`}
                >
                  <span>
                    {m} min
                    {m === DEFAULT_MAX_WALK_MINUTES && <span className="ml-1.5 text-[11.5px] font-normal text-muted">default</span>}
                  </span>
                  {on && <Check size={15} aria-hidden />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </PillPopover>
  );
}

// ---------- train types ----------

function modesSummary(modes: RailMode[]): string {
  if (modes.length >= RAIL_MODES.length) return "All trains";
  if (modes.length <= 2) {
    return RAIL_MODES.filter((m) => modes.includes(m.id))
      .map((m) => m.short)
      .join(" + ");
  }
  return `${modes.length} train types`;
}

function ModesOption({ options, onOptionsChange }: { options: PlanOptions; onOptionsChange: (o: PlanOptions) => void }) {
  const [draft, setDraft] = useState<RailMode[]>(options.modes);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const commit = useCallback(() => {
    const next = RAIL_MODES.map((m) => m.id).filter((id) => draftRef.current.includes(id));
    if (next.length && next.join(",") !== options.modes.join(",")) onOptionsChange({ ...options, modes: next });
  }, [options, onOptionsChange]);

  const all = draft.length === RAIL_MODES.length;

  return (
    <PillPopover
      label={modesSummary(options.modes)}
      ariaLabel={`Train types: ${modesSummary(options.modes)}`}
      icon={<TrainFront size={13} aria-hidden className="shrink-0 text-muted" />}
      active={options.modes.length < RAIL_MODES.length}
      width={320}
      onOpen={() => setDraft(options.modes)}
      onClose={commit}
    >
      {(close) => (
        <div>
          <div className="flex items-baseline justify-between px-2.5 pb-1 pt-2">
            <p className="text-[11.5px] text-muted">Trains to use · buses are never included</p>
            {!all && (
              <button
                type="button"
                onClick={() => setDraft(RAIL_MODES.map((m) => m.id))}
                className="text-[11.5px] font-medium text-ink underline-offset-2 hover:underline"
              >
                All
              </button>
            )}
          </div>
          <div role="group" aria-label="Train types">
            {RAIL_MODES.map((m) => {
              const on = draft.includes(m.id);
              const last = on && draft.length === 1;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  aria-disabled={last}
                  title={last ? "Keep at least one type of train" : undefined}
                  onClick={() => {
                    if (last) return;
                    setDraft((d) => (on ? d.filter((x) => x !== m.id) : [...d, m.id]));
                  }}
                  className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-panel-2 ${
                    last ? "cursor-not-allowed" : ""
                  }`}
                >
                  <span
                    aria-hidden
                    className={`mt-[1px] flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
                      on ? "border-ink bg-ink text-panel" : "border-line-strong bg-panel"
                    } ${last ? "opacity-60" : ""}`}
                  >
                    {on && <Check size={12} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-ink">
                      <ModeIcon mode={m.id} size={14} className="text-muted" />
                      {m.label}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{m.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="sticky bottom-[-6px] -mx-1.5 -mb-1.5 flex items-center justify-between gap-2 border-t border-line bg-panel px-4 pb-3 pt-2.5">
            <p className="text-[11.5px] text-muted">{draft.length === 1 ? "At least one stays on." : " "}</p>
            <button
              type="button"
              onClick={close}
              className="h-8 shrink-0 rounded-lg bg-ink px-3.5 text-[12.5px] font-semibold text-panel hover:opacity-90"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </PillPopover>
  );
}
