/**
 * Plain-DOM builders for things MapLibre positions itself (markers, popups).
 * Text always goes through textContent, never innerHTML.
 */
import { formatClock } from "@/lib/format";
import type { Badge, StopKind } from "@/lib/map/features";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// A / B endpoint markers
// ---------------------------------------------------------------------------

/**
 * MapLibre writes inline `transform` / `opacity` on a marker's root element,
 * so every marker is an untouched wrapper around the element we style.
 */
function wrap(child: HTMLElement): HTMLElement {
  const root = el("div");
  root.appendChild(child);
  return root;
}

export function endpointElement(which: "from" | "to"): HTMLElement {
  const pin = el("div", `ot-pin ${which === "from" ? "ot-pin--a" : "ot-pin--b"}`, which === "from" ? "A" : "B");
  pin.setAttribute("role", "img");
  pin.setAttribute("aria-label", which === "from" ? "Start point (drag to move)" : "End point (drag to move)");
  pin.title = which === "from" ? "Start · drag to move" : "End · drag to move";
  return wrap(pin);
}

// ---------------------------------------------------------------------------
// Line badges
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

/** Tiny front-of-train glyph (24px grid, stroke = currentColor). */
function trainGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ["M8 3h8a4 4 0 0 1 4 4v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a4 4 0 0 1 4-4Z", "M4 11h16", "M8 15h.01", "M16 15h.01", "m8 18-2 3", "m16 18 2 3"]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** Returns the marker root and the badge button inside it. */
export function badgeElement(b: Badge): { root: HTMLElement; button: HTMLButtonElement } {
  const btn = el("button", "ot-badge");
  btn.type = "button";
  btn.style.setProperty("--c", b.color);
  btn.style.setProperty("--t", b.textColor);
  btn.title = `${b.title} — click to zoom to this leg`;
  btn.setAttribute("aria-label", `${b.title}. Zoom to this leg`);
  btn.dataset.leg = String(b.legIndex);
  btn.appendChild(trainGlyph());
  btn.appendChild(el("span", "ot-badge__label", b.label));
  return { root: wrap(btn), button: btn };
}

// ---------------------------------------------------------------------------
// Station popup
// ---------------------------------------------------------------------------

export type StopInfo = {
  name: string;
  kind: StopKind;
  arr: string;
  dep: string;
  tz: string;
  track: string;
  color?: string;
};

export function stopPopupContent(s: StopInfo): HTMLElement {
  const root = el("div", "ot-stop-pop");
  const name = el("div", "ot-stop-pop__name");
  if (s.kind === "pass" && s.color) {
    const sw = el("span", "ot-stop-pop__swatch");
    sw.style.setProperty("--c", s.color);
    name.appendChild(sw);
  }
  name.appendChild(document.createTextNode(s.name));
  root.appendChild(name);

  const tz = s.tz || undefined;
  const row = (k: string, v: string) => {
    if (!v) return;
    const r = el("div", "ot-stop-pop__row");
    r.appendChild(el("span", "ot-stop-pop__k", k));
    r.appendChild(el("span", undefined, v));
    root.appendChild(r);
  };
  const arr = formatClock(s.arr || undefined, tz);
  const dep = formatClock(s.dep || undefined, tz);
  if (s.kind === "board") row("Depart", dep);
  else if (s.kind === "alight") row("Arrive", arr);
  else if (s.kind === "transfer") {
    row("Arrive", arr);
    row("Depart", dep);
  } else row(arr && dep && arr !== dep ? "Arr/dep" : "Time", arr && dep && arr !== dep ? `${arr} · ${dep}` : dep || arr);
  if (s.track) row("Track", s.track);
  return root;
}

// ---------------------------------------------------------------------------
// "Start here / End here" popup
// ---------------------------------------------------------------------------

export function pickPopupContent(lat: number, lon: number, onChoose: (which: "from" | "to") => void): HTMLElement {
  const root = el("div", "ot-pick");
  root.setAttribute("role", "menu");
  const item = (which: "from" | "to", label: string) => {
    const b = el("button", "ot-pick__btn");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.appendChild(el("span", `ot-pick__glyph ${which === "from" ? "ot-pick__glyph--a" : "ot-pick__glyph--b"}`, which === "from" ? "A" : "B"));
    b.appendChild(el("span", undefined, label));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onChoose(which);
    });
    root.appendChild(b);
  };
  item("from", "Start here");
  item("to", "End here");
  root.appendChild(el("div", "ot-pick__coords", `${lat.toFixed(5)}, ${lon.toFixed(5)}`));
  return root;
}
