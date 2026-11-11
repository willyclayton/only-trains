"use client";
/**
 * OWNER: map agent. STUB — replace the body, keep the exported props type.
 * Loaded by Planner via next/dynamic({ ssr: false }), so window is available.
 */
import type { Journey, Place } from "@/lib/types";

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

export default function MapView(_props: MapViewProps) {
  return <div className="absolute inset-0 bg-panel-2" />;
}
