/** Formatting helpers shared by the UI and map popups. */

/** "1 h 23 min", "12 min", "45 s" */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const totalMin = Math.round(s / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/** "350 m", "1.2 km", "48 km" (metric) or "0.2 mi" (imperial) */
export function formatDistance(meters: number, units: "metric" | "imperial" = "metric"): string {
  if (!Number.isFinite(meters)) return "";
  if (units === "imperial") {
    const mi = meters / 1609.344;
    if (mi < 0.1) return `${Math.round(meters * 3.28084)} ft`;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (meters < 1000) return `${Math.round(meters / 10) * 10 || Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** Local clock time at a stop, e.g. "9:47 PM" / "21:47". Uses the stop's IANA tz when given. */
export function formatClock(iso: string | undefined, tz?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(d);
  }
}

/** "Wed, Nov 11" in the given tz. */
export function formatDay(iso: string | undefined, tz?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: tz,
    }).format(d);
  } catch {
    return d.toDateString();
  }
}

/** Short tz label, e.g. "CST", "GMT+9". */
export function formatTzName(iso: string | undefined, tz?: string): string {
  if (!iso || !tz) return "";
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: "short" }).formatToParts(
      new Date(iso),
    );
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** Delay in whole minutes between scheduled and actual (positive = late). */
export function delayMinutes(actual?: string, scheduled?: string): number {
  if (!actual || !scheduled) return 0;
  const diff = (new Date(actual).getTime() - new Date(scheduled).getTime()) / 60000;
  return Number.isFinite(diff) ? Math.round(diff) : 0;
}

/** Pick black or white text for a background color. */
export function readableTextColor(hex: string | undefined): string {
  if (!hex) return "#ffffff";
  const h = hex.replace("#", "");
  if (h.length !== 6) return "#ffffff";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? "#111111" : "#ffffff";
}

/** Normalize "00a1de" / "#00A1DE" / "" to "#00a1de" or undefined. */
export function normalizeColor(c: string | undefined | null): string | undefined {
  if (!c) return undefined;
  const h = c.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(h)) return `#${h}`;
  if (/^[0-9a-f]{3}$/.test(h)) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  return undefined;
}

/** Great-circle distance in meters. */
export function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371008.8;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
