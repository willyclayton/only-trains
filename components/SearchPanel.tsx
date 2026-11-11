"use client";
/** OWNER: ui agent. STUB — replace the body, keep the exported props type. */
import type { PlanOptions, Place } from "@/lib/types";

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

export default function SearchPanel(_props: SearchPanelProps) {
  return <div />;
}
