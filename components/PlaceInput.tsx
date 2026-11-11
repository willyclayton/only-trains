"use client";

import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import { History, LoaderCircle, LocateFixed, SearchX, TriangleAlert, X } from "lucide-react";
import type { GeocodeResponse, Place, RailMode, ReverseResponse } from "@/lib/types";
import { RAIL_MODES } from "@/lib/modes";
import { placeIcon, MODE_ICON } from "./ui/icons";
import { spaceBelow } from "./ui/space";

/** A suggestion as returned by /api/geocode (Place plus optional station extras). */
type Suggestion = Place & { modes?: RailMode[] };

type Option =
  | { type: "geo"; key: string }
  | { type: "recent"; key: string; place: Suggestion }
  | { type: "place"; key: string; place: Suggestion };

export type PlaceInputHandle = { focus: () => void };

export type PlaceInputProps = {
  label: string;
  placeholder: string;
  value: Place | null;
  onChange: (place: Place | null) => void;
  near?: { lat: number; lon: number } | null;
  /** Called after the user picks a place (so the parent can move focus on). */
  onPicked?: () => void;
};

// ---------- small client-side caches ----------

const resultCache = new Map<string, Suggestion[]>();
const RECENT_KEY = "only-trains:recent-places";

function readRecent(): Suggestion[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as Suggestion[]) : [];
    return Array.isArray(list) ? list.filter((p) => p && typeof p.lat === "number" && p.name).slice(0, 5) : [];
  } catch {
    return [];
  }
}

function pushRecent(p: Place) {
  if (p.kind === "coordinate") return;
  try {
    const list = readRecent().filter((x) => x.id !== p.id && x.name !== p.name);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([p, ...list].slice(0, 5)));
  } catch {
    // storage unavailable: recents are a convenience only
  }
}

// ---------- highlighting ----------

function fold(ch: string) {
  return ch.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Bold the parts of `text` that match words of `query` (case- and accent-insensitive). */
function Highlight({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    const words = query
      .split(/[\s,/]+/)
      .map((w) => Array.from(w).map(fold).join(""))
      .filter((w) => w.length > 0);
    if (!words.length) return [{ s: text, m: false }];
    const chars = Array.from(text);
    const folded = chars.map(fold);
    const mask = new Array(chars.length).fill(false);
    const hay = folded.join("");
    // map folded string offsets back to char indices
    const starts: number[] = [];
    let off = 0;
    folded.forEach((f) => {
      starts.push(off);
      off += f.length;
    });
    for (const w of words) {
      let from = 0;
      while (from <= hay.length) {
        const at = hay.indexOf(w, from);
        if (at < 0) break;
        // only highlight at word starts, so "ark" doesn't light up "Clark"
        const ci = starts.findIndex((s, i) => s <= at && at < s + (folded[i].length || 1));
        const prev = ci > 0 ? chars[ci - 1] : " ";
        if (/[^\p{L}\p{N}]/u.test(prev) || ci === 0) {
          for (let i = ci; i < chars.length && starts[i] < at + w.length; i++) mask[i] = true;
        }
        from = at + 1;
      }
    }
    const out: { s: string; m: boolean }[] = [];
    chars.forEach((c, i) => {
      const last = out[out.length - 1];
      if (last && last.m === mask[i]) last.s += c;
      else out.push({ s: c, m: mask[i] });
    });
    return out;
  }, [text, query]);
  return (
    <>
      {parts.map((p, i) =>
        p.m ? (
          <span key={i} className="font-semibold text-ink">
            {p.s}
          </span>
        ) : (
          <span key={i}>{p.s}</span>
        ),
      )}
    </>
  );
}

function modesLabel(modes: RailMode[] | undefined): string {
  if (!modes?.length) return "";
  return modes.map((m) => RAIL_MODES.find((x) => x.id === m)?.short ?? m).join(" · ");
}

function SuggestionIcon({ place }: { place: Suggestion }) {
  let Icon = placeIcon(place.kind);
  if (place.kind === "station" && place.modes?.length === 1) Icon = MODE_ICON[place.modes[0]];
  return (
    <span
      className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
        place.kind === "station" ? "bg-ink text-panel" : "bg-panel-2 text-ink-2"
      }`}
    >
      <Icon size={16} aria-hidden />
    </span>
  );
}

// ---------- component ----------

const PlaceInput = forwardRef<PlaceInputHandle, PlaceInputProps>(function PlaceInput(
  { label, placeholder, value, onChange, near, onPicked },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [text, setText] = useState(value?.name ?? "");
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Suggestion[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState<Suggestion[]>([]);
  const [geo, setGeo] = useState<{ state: "idle" | "locating" | "error"; message?: string }>({ state: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [menuMax, setMenuMax] = useState(372);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  // Reflect external changes (map clicks, swap, URL) while the user isn't typing.
  useEffect(() => {
    if (!focused) setText(value?.name ?? "");
  }, [value, focused]);

  const query = text.trim();
  const editing = focused && query !== (value?.name ?? "").trim();
  const minLen = /[^\u0000-ɏ]/.test(query) ? 1 : 2;

  // Round the bias point (~10 km) so the CDN can share cached answers.
  const biasLat = near ? Math.round(near.lat * 10) / 10 : null;
  const biasLon = near ? Math.round(near.lon * 10) / 10 : null;

  // Debounced, abortable geocoding.
  useEffect(() => {
    if (!editing || query.length < minLen) {
      abortRef.current?.abort();
      setStatus("idle");
      setResults([]);
      return;
    }
    const lang = (typeof navigator !== "undefined" ? navigator.language : "en").split("-")[0];
    const qs = new URLSearchParams({ q: query, lang });
    if (biasLat != null && biasLon != null) {
      qs.set("lat", String(biasLat));
      qs.set("lon", String(biasLon));
    }
    const key = qs.toString();
    const hit = resultCache.get(key);
    if (hit) {
      setResults(hit);
      setStatus("done");
      setActive(hit.length ? 0 : -1);
      return;
    }
    setStatus((s) => (s === "done" ? "done" : "loading"));
    const t = window.setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setStatus("loading");
      try {
        const res = await fetch(`/api/geocode?${key}`, { signal: ac.signal });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as GeocodeResponse;
        const places = (json.places ?? []) as Suggestion[];
        resultCache.set(key, places);
        if (resultCache.size > 200) resultCache.delete(resultCache.keys().next().value as string);
        setResults(places);
        setStatus("done");
        setActive(places.length ? 0 : -1);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setStatus("error");
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [editing, query, minLen, biasLat, biasLon]);

  const canGeolocate = typeof navigator !== "undefined" && "geolocation" in navigator;

  const options: Option[] = useMemo(() => {
    if (query.length === 0 || !editing) {
      const out: Option[] = [];
      if (canGeolocate) out.push({ type: "geo", key: "geo" });
      for (const p of recent) if (p.id !== value?.id) out.push({ type: "recent", key: `r-${p.id}`, place: p });
      return out;
    }
    return results.map((p) => ({ type: "place" as const, key: p.id, place: p }));
  }, [query, editing, results, recent, canGeolocate, value?.id]);

  const showEmptyMenu = query.length === 0 || !editing;
  const menuVisible =
    open &&
    focused &&
    (showEmptyMenu
      ? options.length > 0 || geo.state !== "idle"
      : query.length >= minLen && (status !== "idle" || results.length > 0));

  const pick = useCallback(
    (p: Place) => {
      // Strip UI-only extras before handing the place up.
      const clean: Place = { id: p.id, name: p.name, detail: p.detail, lat: p.lat, lon: p.lon, kind: p.kind };
      onChange(clean);
      pushRecent(clean);
      setText(clean.name);
      setOpen(false);
      setActive(-1);
      inputRef.current?.blur();
      onPicked?.();
    },
    [onChange, onPicked],
  );

  const locate = useCallback(() => {
    if (!canGeolocate) return;
    setGeo({ state: "locating" });
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        let detail: string | undefined;
        try {
          const ac = new AbortController();
          const timer = window.setTimeout(() => ac.abort(), 2500);
          const res = await fetch(`/api/reverse?lat=${lat}&lon=${lon}`, { signal: ac.signal });
          window.clearTimeout(timer);
          const json = (await res.json()) as ReverseResponse;
          if (json.place) detail = json.place.detail ? `${json.place.name}, ${json.place.detail}` : json.place.name;
        } catch {
          // a label is nice-to-have
        }
        setGeo({ state: "idle" });
        pick({
          id: `geo:${lat.toFixed(5)},${lon.toFixed(5)}`,
          name: "Current location",
          detail: detail ?? `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
          lat,
          lon,
          kind: "coordinate",
        });
      },
      (err) => {
        setGeo({
          state: "error",
          message:
            err.code === err.PERMISSION_DENIED
              ? "Location access is blocked. Allow it in your browser settings, or search instead."
              : "Couldn't find your location. Try again, or search instead.",
        });
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  }, [canGeolocate, pick]);

  const choose = (o: Option | undefined) => {
    if (!o) return;
    if (o.type === "geo") locate();
    else pick(o.place);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      if (!options.length) return;
      const dir = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i < 0 ? (dir > 0 ? 0 : options.length - 1) : (i + dir + options.length) % options.length));
    } else if (e.key === "Enter") {
      if (!menuVisible) return;
      e.preventDefault();
      const o = active >= 0 ? options[active] : options.find((x) => x.type !== "geo");
      choose(o);
    } else if (e.key === "Escape") {
      if (menuVisible) {
        e.preventDefault();
        setOpen(false);
      } else {
        setText(value?.name ?? "");
        inputRef.current?.blur();
      }
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  useEffect(() => {
    if (!menuVisible) return;
    const measure = () => {
      const r = boxRef.current?.getBoundingClientRect();
      if (r) setMenuMax(Math.min(372, spaceBelow(boxRef.current, r.bottom + 6) - 4));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [menuVisible]);

  const activeId = menuVisible && active >= 0 && options[active] ? `${listId}-${active}` : undefined;

  return (
    <div className="relative min-w-0">
      <div
        ref={boxRef}
        className={`flex h-10 items-center rounded-[10px] border bg-panel-2 transition-colors ${
          focused ? "border-ink bg-panel" : "border-line hover:border-line-strong"
        }`}
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={label}
          aria-expanded={menuVisible}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder={placeholder}
          value={text}
          title={value ? [value.name, value.detail].filter(Boolean).join(" — ") : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(-1);
            if (geo.state === "error") setGeo({ state: "idle" });
          }}
          onFocus={(e) => {
            setFocused(true);
            setOpen(true);
            setRecent(readRecent());
            setActive(-1);
            e.currentTarget.select();
          }}
          onBlur={() => {
            setFocused(false);
            setOpen(false);
            setText(value?.name ?? "");
            if (geo.state === "error") setGeo({ state: "idle" });
          }}
          onKeyDown={onKeyDown}
          // The wrapper shows focus (ink border); the global :focus-visible ring would draw a square inside it.
          style={{ outline: "none" }}
          className="h-full min-w-0 flex-1 bg-transparent pl-3 pr-1 text-[16px] text-ink placeholder:text-faint md:text-[14px]"
        />
        {status === "loading" && editing && (
          <LoaderCircle size={15} aria-hidden className="mr-1 shrink-0 animate-spin text-faint" />
        )}
        {(text.length > 0 || value) && (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setText("");
              setResults([]);
              onChange(null);
              inputRef.current?.focus();
            }}
            className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-line/60 hover:text-ink"
          >
            <X size={15} aria-hidden />
          </button>
        )}
      </div>

      {menuVisible && (
        <div
          className="ot-fade-in scroll-thin absolute left-0 right-0 top-full z-30 mt-1.5 overflow-y-auto overscroll-contain rounded-xl border border-line bg-panel shadow-panel"
          style={{ maxHeight: menuMax }}
          onMouseDown={(e) => e.preventDefault() /* keep focus in the input */}
        >
          <ul id={listId} role="listbox" aria-label={`${label} suggestions`} className="py-1">
            {options.map((o, i) => {
              const isActive = i === active;
              const base = `mx-1 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 ${isActive ? "bg-panel-2" : ""}`;
              if (o.type === "geo") {
                return (
                  <li
                    key={o.key}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={isActive}
                    className={base}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(o)}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-ink">
                      {geo.state === "locating" ? (
                        <LoaderCircle size={16} className="animate-spin" aria-hidden />
                      ) : (
                        <LocateFixed size={16} aria-hidden />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-ink">
                        {geo.state === "locating" ? "Finding your location…" : "Use my current location"}
                      </span>
                    </span>
                  </li>
                );
              }
              const p = o.place;
              const modes = modesLabel(p.modes);
              return (
                <li
                  key={o.key}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={isActive}
                  className={base}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o)}
                >
                  {o.type === "recent" ? (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-muted">
                      <History size={16} aria-hidden />
                    </span>
                  ) : (
                    <SuggestionIcon place={p} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] leading-5 text-ink-2">
                      {o.type === "place" ? <Highlight text={p.name} query={query} /> : <span className="text-ink">{p.name}</span>}
                    </span>
                    {(modes || p.detail) && (
                      <span className="block truncate text-[12px] leading-4 text-muted">
                        {modes && <span className="font-medium text-ink-2">{modes}</span>}
                        {modes && p.detail && <span aria-hidden> · </span>}
                        {p.detail}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {geo.state === "error" && showEmptyMenu && (
            <p className="flex items-start gap-2 border-t border-line px-3 py-2.5 text-[12.5px] leading-snug text-ink-2" role="status">
              <TriangleAlert size={14} className="mt-[1px] shrink-0 text-warn" aria-hidden />
              {geo.message}
            </p>
          )}
          {!showEmptyMenu && status === "done" && results.length === 0 && (
            <p className="flex items-center gap-2 px-3 py-3 text-[13px] text-muted" role="status">
              <SearchX size={15} aria-hidden className="shrink-0" />
              No matches for “{query}”. Try a station or street name.
            </p>
          )}
          {!showEmptyMenu && status === "error" && (
            <p className="flex items-center gap-2 px-3 py-3 text-[13px] text-muted" role="status">
              <TriangleAlert size={15} aria-hidden className="shrink-0 text-warn" />
              Search is unavailable right now. You can click the map instead.
            </p>
          )}
          {!showEmptyMenu && status === "loading" && results.length === 0 && (
            <div className="space-y-1 px-3 py-2.5" aria-hidden>
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 py-1">
                  <span className="size-8 rounded-lg bg-panel-2" />
                  <span className="flex-1 space-y-1.5">
                    <span className="block h-3 w-2/5 animate-pulse rounded bg-panel-2" />
                    <span className="block h-2.5 w-3/5 animate-pulse rounded bg-panel-2" />
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default PlaceInput;
