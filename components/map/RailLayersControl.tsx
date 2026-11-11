"use client";
/**
 * Compact, monochrome layers control for the railway overlay. Rendered by
 * MapView through a portal into a MapLibre IControl container so it stacks
 * with the zoom / geolocate buttons.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Layers } from "lucide-react";
import type { IControl } from "maplibre-gl";
import { RAIL_VIEWS, type RailPrefs } from "@/lib/map/config";

/** An empty control container MapView renders React into. */
export class PortalControl implements IControl {
  private container: HTMLDivElement;
  constructor(
    className: string,
    private onMount: (el: HTMLElement | null) => void,
  ) {
    this.container = document.createElement("div");
    this.container.className = `maplibregl-ctrl maplibregl-ctrl-group ${className}`;
  }
  onAdd(): HTMLElement {
    this.onMount(this.container);
    return this.container;
  }
  onRemove(): void {
    this.container.remove();
    this.onMount(null);
  }
}

export default function RailLayersControl({
  prefs,
  onChange,
}: {
  prefs: RailPrefs;
  onChange: (next: RailPrefs) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="ot-layers" ref={rootRef}>
      <button
        type="button"
        className="ot-layers__btn"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Railway map layers"
        title="Railway map layers"
        onClick={() => setOpen((o) => !o)}
      >
        <Layers size={17} strokeWidth={1.9} aria-hidden />
        {prefs.on && <span className="ot-layers__dot" aria-hidden />}
      </button>

      {open && (
        <div className="ot-layers__panel" id={panelId} role="dialog" aria-labelledby={titleId}>
          <div className="ot-layers__head">
            <div>
              <div className="ot-layers__title" id={titleId}>
                Railway overlay
              </div>
              <div className="ot-layers__sub">Every track, from OpenRailwayMap</div>
            </div>
            <button
              type="button"
              role="switch"
              className="ot-switch"
              aria-checked={prefs.on}
              aria-label="Show railway overlay"
              onClick={() => onChange({ ...prefs, on: !prefs.on })}
            />
          </div>

          <div className="ot-layers__views" role="radiogroup" aria-label="Overlay style" aria-disabled={!prefs.on}>
            {RAIL_VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="radio"
                className="ot-view"
                aria-checked={prefs.view === v.id}
                onClick={() => onChange({ on: true, view: v.id })}
              >
                <span className="ot-view__radio" aria-hidden />
                <span>
                  <span className="ot-view__label">{v.label}</span>
                  <span className="ot-view__hint">{v.hint}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="ot-layers__foot">
            Key &amp; legend at{" "}
            <a href="https://www.openrailwaymap.org/" target="_blank" rel="noopener noreferrer">
              openrailwaymap.org
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
