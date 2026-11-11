/** UI-side helpers for journeys and legs (formatting decisions that are presentation, not data). */
import type { Journey, Leg, LegMode, LineInfo, RailMode } from "@/lib/types";
import { MODE_FALLBACK_COLOR } from "@/lib/modes";
import { normalizeColor, readableTextColor } from "@/lib/format";
import { journeyTotals } from "@/lib/journey";

export function browserTz(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** YYYY-MM-DD of an instant in a tz. */
function ymd(iso: string, tz?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(iso),
    );
  } catch {
    return new Date(iso).toISOString().slice(0, 10);
  }
}

/** Calendar-day difference between two instants in a tz (e.g. 1 for an after-midnight arrival). */
export function dayOffset(fromIso: string, toIso: string, tz?: string): number {
  const a = Date.parse(ymd(fromIso, tz));
  const b = Date.parse(ymd(toIso, tz));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** The timezone to show a journey's headline times in: the first stop's, else the plan's origin tz. */
export function journeyTz(j: Journey, originTz?: string): string | undefined {
  return j.legs[0]?.from.tz ?? j.legs.find((l) => l.from.tz)?.from.tz ?? originTz;
}

export const isRail = (l: Leg) => l.mode !== "WALK";

/** Names providers use for the synthetic start / end vertices. */
export function isPlaceholderName(name: string | undefined): boolean {
  return !name || /^(start|end|origin|destination)$/i.test(name.trim());
}

export function legColor(leg: { mode: LegMode; line?: LineInfo }): string {
  return normalizeColor(leg.line?.color) ?? MODE_FALLBACK_COLOR[leg.mode];
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Text color on a line color: the operator's own when it is legible, else black/white. */
export function legTextColor(line: LineInfo | undefined, bg: string): string {
  const own = normalizeColor(line?.textColor);
  if (own && own !== bg && contrastRatio(own, bg) >= 3) return own;
  return readableTextColor(bg);
}

/** Best compact label for a chip. */
export function lineLabel(line: LineInfo | undefined, mode: LegMode, compact = false): string {
  const name = line?.name?.trim();
  const short = line?.shortName?.trim();
  if (compact && short && short.length <= 6) return short;
  if (name) return name.length > 18 && short ? short : name;
  if (short) return short;
  return line?.longName?.trim() || (mode === "WALK" ? "Walk" : "Train");
}

/** Whole minutes for compact display: "4" (never 0 for a non-zero walk). */
export function roundMinutes(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(1, Math.round(seconds / 60));
}

export type Breakdown = {
  duration: number;
  railDuration: number;
  walkDuration: number;
  waitDuration: number;
  walkDistance: number;
  railDistance: number;
};

/** Trip-time breakdown, trusting provider totals but filling gaps from the legs. */
export function breakdown(j: Journey): Breakdown {
  const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if (ok(j.railDuration) && ok(j.walkDuration) && ok(j.waitDuration)) {
    return {
      duration: j.duration,
      railDuration: j.railDuration,
      walkDuration: j.walkDuration,
      waitDuration: j.waitDuration,
      walkDistance: j.walkDistance,
      railDistance: j.railDistance,
    };
  }
  const t = journeyTotals(j.legs, j.startTime, j.endTime);
  return {
    duration: t.duration,
    railDuration: t.railDuration,
    walkDuration: t.walkDuration,
    waitDuration: t.waitDuration,
    walkDistance: j.walkDistance || t.walkDistance,
    railDistance: j.railDistance || t.railDistance,
  };
}

export function transfersLabel(n: number): string {
  if (n <= 0) return "Direct";
  return n === 1 ? "1 transfer" : `${n} transfers`;
}

/** Ordered unique rail modes of a journey. */
export function journeyModes(j: Journey): RailMode[] {
  const out: RailMode[] = [];
  for (const l of j.legs) if (l.mode !== "WALK" && !out.includes(l.mode)) out.push(l.mode);
  return out;
}

/** Seconds between two ISO instants (≥ 0). */
export function gapSeconds(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const d = (Date.parse(b) - Date.parse(a)) / 1000;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** CSS background for "walking" — a row of small dots in the walk color. */
export const WALK_DOTS_X =
  "radial-gradient(circle at center, var(--walk) 1.25px, transparent 1.6px) left center / 5px 100% repeat-x";
export const WALK_DOTS_Y =
  "radial-gradient(circle at center, var(--walk) 1.6px, transparent 1.9px) center top / 100% 7px repeat-y";
