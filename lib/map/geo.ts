/** Small geometry helpers for the map. Coordinates are [lon, lat]. */

export type Coord = [number, number];
export type Bounds = [[number, number], [number, number]]; // [[west, south], [east, north]]

export function extendBounds(b: Bounds | null, c: Coord): Bounds {
  if (!b) return [[c[0], c[1]], [c[0], c[1]]];
  return [
    [Math.min(b[0][0], c[0]), Math.min(b[0][1], c[1])],
    [Math.max(b[1][0], c[0]), Math.max(b[1][1], c[1])],
  ];
}

export function boundsOf(coords: Iterable<Coord>, start: Bounds | null = null): Bounds | null {
  let b = start;
  for (const c of coords) {
    if (Number.isFinite(c[0]) && Number.isFinite(c[1])) b = extendBounds(b, c);
  }
  return b;
}

/** Cheap planar distance in meters, good enough for interpolation along short segments. */
function segLength(a: Coord, b: Coord): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dx = (b[0] - a[0]) * k;
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy) * 111_320;
}

export function lineLength(line: Coord[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += segLength(line[i - 1], line[i]);
  return total;
}

/** Point at `fraction` (0..1) of the way along a polyline. */
export function pointAlong(line: Coord[], fraction: number): Coord | null {
  if (line.length === 0) return null;
  if (line.length === 1) return line[0];
  const target = lineLength(line) * Math.min(1, Math.max(0, fraction));
  let acc = 0;
  for (let i = 1; i < line.length; i++) {
    const d = segLength(line[i - 1], line[i]);
    if (acc + d >= target && d > 0) {
      const t = (target - acc) / d;
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
    }
    acc += d;
  }
  return line[line.length - 1];
}

export function metersBetween(a: Coord, b: Coord): number {
  return segLength(a, b);
}
