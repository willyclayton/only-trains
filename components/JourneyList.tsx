"use client";
/** OWNER: ui agent. STUB — replace the body, keep the exported props type. */
import type { Journey } from "@/lib/types";

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
};

export default function JourneyList(_props: JourneyListProps) {
  return <div />;
}
