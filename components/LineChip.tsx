import type { LegMode, LineInfo } from "@/lib/types";
import { ModeIcon } from "./ui/icons";
import { legColor, legTextColor, lineLabel } from "./ui/journey";

export type LineChipProps = {
  line?: LineInfo;
  mode: LegMode;
  size?: "sm" | "md";
  /** Show the mode glyph (metro / train / tram) before the name. */
  icon?: boolean;
  /** Prefer the short name ("RE 1", "7") when there is one. */
  compact?: boolean;
  /** Always use the full display name (truncated if needed). */
  full?: boolean;
  className?: string;
};

/** A line's badge in its official color, with legible text. */
export default function LineChip({ line, mode, size = "md", icon = false, compact = false, full = false, className = "" }: LineChipProps) {
  const bg = legColor({ mode, line });
  const fg = legTextColor(line, bg);
  const label = lineLabel(line, mode, full ? "full" : compact ? "compact" : "medium");
  const tooltip = [line?.longName && line.longName !== label ? `${label} · ${line.longName}` : line?.name || label, line?.agency]
    .filter(Boolean)
    .join(" — ");
  const sizing =
    size === "sm"
      ? "h-[20px] gap-1 px-[7px] text-[11.5px] max-w-[9.5rem]"
      : "h-[24px] gap-1.5 px-[9px] text-[12.5px] max-w-full";
  return (
    <span
      className={`inline-flex min-w-0 shrink items-center rounded-full font-semibold leading-none tracking-[-0.005em] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)] ${sizing} ${className}`}
      style={{ backgroundColor: bg, color: fg }}
      title={tooltip}
    >
      {icon && <ModeIcon mode={mode} size={size === "sm" ? 12 : 13} className="shrink-0" />}
      <span className="truncate">{label}</span>
    </span>
  );
}
