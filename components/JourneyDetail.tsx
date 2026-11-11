"use client";
/** OWNER: ui agent. STUB — replace the body, keep the exported props type. */
import type { Journey, Place } from "@/lib/types";

export type JourneyDetailProps = {
  journey: Journey;
  from: Place | null;
  to: Place | null;
  onBack: () => void;
  onHoverLeg: (index: number | null) => void;
  onFocusLeg: (index: number) => void;
  hoveredLegIndex: number | null;
};

export default function JourneyDetail(_props: JourneyDetailProps) {
  return <div />;
}
