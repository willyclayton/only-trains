"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

type PillPopoverProps = {
  /** Visible trigger content. */
  label: ReactNode;
  icon?: ReactNode;
  /** Accessible name for the trigger, e.g. "Departure time: Leave now". */
  ariaLabel: string;
  /** Preferred popover width; clamped to the row width. */
  width?: number;
  /** Highlight the pill when its setting differs from the default. */
  active?: boolean;
  /** Called whenever the popover closes (to commit drafts). */
  onClose?: () => void;
  onOpen?: () => void;
  children: (close: () => void) => ReactNode;
};

/**
 * A small pill button that opens a popover underneath it. The popover is
 * positioned against the nearest `[data-popover-boundary]` ancestor and
 * clamped so it never overflows it (no horizontal scroll at 390px).
 */
export function PillPopover({ label, icon, ariaLabel, width = 300, active, onClose, onOpen, children }: PillPopoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback(
    (refocus = true) => {
      setOpen(false);
      onClose?.();
      if (refocus) triggerRef.current?.focus();
    },
    [onClose],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerRef.current;
      const boundary = t?.closest("[data-popover-boundary]") as HTMLElement | null;
      const anchor = t?.offsetParent as HTMLElement | null;
      if (!t || !anchor) return;
      const tr = t.getBoundingClientRect();
      const ar = anchor.getBoundingClientRect();
      const br = (boundary ?? anchor).getBoundingClientRect();
      const w = Math.min(width, br.width);
      let leftInViewport = tr.left;
      leftInViewport = Math.min(leftInViewport, br.right - w);
      leftInViewport = Math.max(leftInViewport, br.left);
      setPos({ left: leftInViewport - ar.left, top: tr.bottom - ar.top + 6, width: w });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  // Move focus into the popover when it opens.
  useEffect(() => {
    if (!open || !pos) return;
    const el = popRef.current?.querySelector<HTMLElement>("[data-autofocus], button, input, [tabindex]");
    el?.focus({ preventScroll: true });
  }, [open, pos]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel}
        onClick={() => {
          if (open) close(false);
          else {
            onOpen?.();
            setOpen(true);
          }
        }}
        className={`inline-flex h-8 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border pl-2.5 pr-2 text-[12.5px] font-medium transition-colors ${
          open
            ? "border-ink bg-panel text-ink"
            : active
              ? "border-line-strong bg-panel-2 text-ink hover:border-ink/40"
              : "border-line bg-panel text-ink-2 hover:border-line-strong hover:text-ink"
        }`}
      >
        {icon}
        <span className="truncate">{label}</span>
        <ChevronDown size={13} aria-hidden className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          ref={popRef}
          id={id}
          role="dialog"
          aria-label={ariaLabel}
          className="ot-fade-in absolute z-40 rounded-xl border border-line bg-panel p-1.5 shadow-panel"
          style={pos ? { left: pos.left, top: pos.top, width: pos.width } : { visibility: "hidden" }}
        >
          {children(() => close(true))}
        </div>
      )}
    </>
  );
}
