/**
 * Google encoded-polyline decoding with arbitrary precision.
 *
 * - Google Routes API uses precision 5.
 * - MOTIS / Transitous /api/v2+ plan endpoints use precision 6
 *   (/api/v1 used 7, which overflows for |lon| > 107.37).
 *
 * Output is GeoJSON order: [lon, lat].
 */
export function decodePolyline(encoded: string | undefined | null, precision = 5): [number, number][] {
  if (!encoded) return [];
  const factor = Math.pow(10, precision);
  const out: [number, number][] = [];
  const len = encoded.length;
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < len) {
    // latitude delta
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      if (index >= len) return out; // truncated input: keep what we have
      b = encoded.charCodeAt(index++) - 63;
      result += (b & 0x1f) * Math.pow(2, shift); // avoid 32-bit overflow for precision 7
      shift += 5;
    } while (b >= 0x20);
    lat += result % 2 === 1 ? -(result + 1) / 2 : result / 2;

    // longitude delta
    result = 0;
    shift = 0;
    do {
      if (index >= len) return out;
      b = encoded.charCodeAt(index++) - 63;
      result += (b & 0x1f) * Math.pow(2, shift);
      shift += 5;
    } while (b >= 0x20);
    lon += result % 2 === 1 ? -(result + 1) / 2 : result / 2;

    out.push([round6(lon / factor), round6(lat / factor)]);
  }
  return out;
}

/** Encode [lon, lat] pairs (handy for tests). */
export function encodePolyline(coords: [number, number][], precision = 5): string {
  const factor = Math.pow(10, precision);
  let out = "";
  let pLat = 0;
  let pLon = 0;
  for (const [lon, lat] of coords) {
    const iLat = Math.round(lat * factor);
    const iLon = Math.round(lon * factor);
    out += encodeValue(iLat - pLat) + encodeValue(iLon - pLon);
    pLat = iLat;
    pLon = iLon;
  }
  return out;
}

function encodeValue(v: number): string {
  let n = v < 0 ? -2 * v - 1 : 2 * v;
  let s = "";
  while (n >= 0x20) {
    s += String.fromCharCode((0x20 | (n % 32)) + 63);
    n = Math.floor(n / 32);
  }
  return s + String.fromCharCode(n + 63);
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Length of a [lon, lat] path in meters (haversine). */
export function pathLength(coords: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineLonLat(coords[i - 1], coords[i]);
  return total;
}

export function haversineLonLat(a: [number, number], b: [number, number]): number {
  const R = 6371008.8;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b in degrees [0, 360). */
export function bearing(a: [number, number], b: [number, number]): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const Δλ = toRad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
