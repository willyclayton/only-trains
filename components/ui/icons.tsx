import type { LegMode, Place } from "@/lib/types";
import {
  Building2,
  CableCar,
  Crosshair,
  Footprints,
  House,
  MapPin,
  Train,
  TrainFront,
  TrainFrontTunnel,
  TramFront,
  type LucideIcon,
} from "lucide-react";

export const MODE_ICON: Record<LegMode, LucideIcon> = {
  WALK: Footprints,
  SUBWAY: TrainFrontTunnel,
  COMMUTER: TrainFront,
  INTERCITY: Train,
  LIGHT_RAIL: TramFront,
  OTHER_RAIL: CableCar,
};

export function ModeIcon({ mode, className, size = 14 }: { mode: LegMode; className?: string; size?: number }) {
  const Icon = MODE_ICON[mode] ?? TrainFront;
  return <Icon size={size} className={className} aria-hidden strokeWidth={2} />;
}

export function placeIcon(kind: Place["kind"]): LucideIcon {
  switch (kind) {
    case "station":
      return TrainFront;
    case "city":
      return Building2;
    case "address":
      return House;
    case "coordinate":
      return Crosshair;
    default:
      return MapPin;
  }
}

/**
 * Endpoint markers, matching the map: A is an ink circle, B an ink rounded square.
 */
export function EndpointMarker({
  which,
  size = 18,
  className = "",
}: {
  which: "A" | "B";
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center bg-ink font-bold leading-none text-panel ${
        which === "A" ? "rounded-full" : "rounded-[5px]"
      } ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.56) }}
    >
      {which}
    </span>
  );
}

/** Indeterminate keyframes, hoisted once into <head> by React 19. */
export function UiKeyframes() {
  return (
    <style href="only-trains-ui-keyframes" precedence="default">{`
@keyframes ot-indeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }
@keyframes ot-fade-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
.ot-indeterminate { animation: ot-indeterminate 1.1s cubic-bezier(.45,.05,.55,.95) infinite; }
.ot-fade-in { animation: ot-fade-in 120ms ease-out; }
@media (prefers-reduced-motion: reduce) { .ot-indeterminate, .ot-fade-in { animation: none; } }
`}</style>
  );
}
