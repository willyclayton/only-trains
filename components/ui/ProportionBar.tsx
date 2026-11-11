import type { Journey } from "@/lib/types";
import { gapSeconds, legColor, WALK_DOTS_X } from "./journey";

type Segment = { kind: "rail" | "walk" | "wait"; seconds: number; color?: string; key: string; title: string };

/** Leg-by-leg segments (with waits between legs) for a journey timeline bar. */
export function journeySegments(j: Journey): Segment[] {
  const segs: Segment[] = [];
  let cursor = j.startTime;
  j.legs.forEach((leg, i) => {
    const wait = gapSeconds(cursor, leg.startTime);
    if (wait >= 30) segs.push({ kind: "wait", seconds: wait, key: `w${i}`, title: "Waiting" });
    segs.push({
      kind: leg.mode === "WALK" ? "walk" : "rail",
      seconds: Math.max(leg.duration, 1),
      color: leg.mode === "WALK" ? undefined : legColor(leg),
      key: `l${i}`,
      title: leg.mode === "WALK" ? "Walking" : leg.line?.name ?? "Train",
    });
    cursor = leg.endTime;
  });
  const tail = gapSeconds(cursor, j.endTime);
  if (tail >= 30) segs.push({ kind: "wait", seconds: tail, key: "wend", title: "Waiting" });
  return segs;
}

/** Thin horizontal bar: segment widths ∝ time; rail in line colors, walking dotted, waiting faint. */
export function TimelineBar({ journey, className = "" }: { journey: Journey; className?: string }) {
  const segs = journeySegments(journey);
  const total = segs.reduce((s, x) => s + x.seconds, 0) || 1;
  return (
    <div className={`flex h-[6px] w-full items-center gap-[2px] ${className}`} aria-hidden>
      {segs.map((s) => (
        <span
          key={s.key}
          title={s.title}
          className={`h-full min-w-[3px] rounded-full ${s.kind === "wait" ? "bg-line" : ""}`}
          style={{
            flexGrow: s.seconds / total,
            flexBasis: 0,
            ...(s.kind === "rail" ? { backgroundColor: s.color } : {}),
            ...(s.kind === "walk" ? { background: WALK_DOTS_X, opacity: 0.9 } : {}),
          }}
        />
      ))}
    </div>
  );
}

/** Aggregate trains / walking / waiting bar for the detail summary (monochrome). */
export function StackedBar({ rail, walk, wait }: { rail: number; walk: number; wait: number }) {
  const total = rail + walk + wait || 1;
  const parts = [
    { k: "rail", v: rail, cls: "bg-ink" },
    { k: "walk", v: walk, style: { background: WALK_DOTS_X } },
    { k: "wait", v: wait, cls: "bg-line-strong" },
  ].filter((p) => p.v > 0);
  return (
    <div className="flex h-2 w-full items-center gap-[3px]" aria-hidden>
      {parts.map((p) => (
        <span
          key={p.k}
          className={`h-full min-w-[4px] rounded-full ${p.cls ?? ""}`}
          style={{ flexGrow: p.v / total, flexBasis: 0, ...(p.style ?? {}) }}
        />
      ))}
    </div>
  );
}

export function Swatch({ kind }: { kind: "rail" | "walk" | "wait" }) {
  if (kind === "walk")
    return <span aria-hidden className="inline-block h-2 w-3 rounded-full" style={{ background: WALK_DOTS_X }} />;
  return (
    <span aria-hidden className={`inline-block h-2 w-3 rounded-full ${kind === "rail" ? "bg-ink" : "bg-line-strong"}`} />
  );
}
