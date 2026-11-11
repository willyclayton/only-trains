/**
 * Worldwide smoke test for the routing pipeline (calls lib/plan.ts directly).
 *
 *   npx tsx scripts/test-plan.ts            # all cases
 *   npx tsx scripts/test-plan.ts chicago    # cases whose name contains "chicago"
 *
 * (In the sandbox, prefix with NODE_USE_ENV_PROXY=1 so Node's fetch uses the proxy.)
 *
 * Be polite to Transitous: requests are spaced out and the case list is small.
 */
import { plan } from "../lib/plan";
import { ALL_RAIL_MODES } from "../lib/modes";
import type { Journey, PlanResponse, RailMode } from "../lib/types";

type Case = {
  name: string;
  from: [number, number];
  to: [number, number];
  /** Local departure time incl. offset (Thursday 12 Nov 2026, daytime). */
  time: string;
  modes?: RailMode[];
  maxWalk?: number;
  expectRail?: boolean;
  /** Line names we expect to see in at least one journey (regex). */
  expectLines?: RegExp;
};

const D = "2026-11-12";
const CASES: Case[] = [
  { name: "Chicago Wicker Park → Loop", from: [41.9088, -87.6776], to: [41.8826, -87.6233], time: `${D}T09:00:00-06:00`, expectLines: /Blue Line/ },
  { name: "Chicago O'Hare → Union Station", from: [41.9786, -87.9048], to: [41.8787, -87.6403], time: `${D}T09:00:00-06:00`, expectLines: /Blue Line|Metra|North Central/ },
  { name: "NYC Crown Heights → Midtown", from: [40.6782, -73.9442], to: [40.7549, -73.984], time: `${D}T08:30:00-05:00` },
  { name: "London King's Cross → Canary Wharf", from: [51.5309, -0.1233], to: [51.5054, -0.0235], time: `${D}T09:00:00+00:00`, expectLines: /line|DLR/ },
  { name: "Paris Châtelet → Versailles (RER C)", from: [48.8584, 2.347], to: [48.8049, 2.1204], time: `${D}T10:00:00+01:00`, expectLines: /RER C|Line|Transilien/ },
  { name: "Berlin Alexanderplatz → Potsdam", from: [52.5219, 13.4132], to: [52.3906, 13.0645], time: `${D}T10:00:00+01:00`, expectLines: /S7|RE1/ },
  { name: "Paris Gare de Lyon → Lyon (TGV)", from: [48.8443, 2.3744], to: [45.7605, 4.8597], time: `${D}T09:00:00+01:00`, expectLines: /TGV|FR \d|OUIGO/ },
  { name: "NYC Penn → Boston South (Amtrak)", from: [40.7506, -73.9935], to: [42.3523, -71.0552], time: `${D}T09:00:00-05:00`, expectLines: /Acela|Northeast Regional/ },
  { name: "Amsterdam Centraal → Berlin Hbf", from: [52.3791, 4.9003], to: [52.5251, 13.3694], time: `${D}T08:00:00+01:00` },
  { name: "Tokyo Shibuya → Asakusa", from: [35.658, 139.7016], to: [35.7114, 139.7966], time: `${D}T10:00:00+09:00`, expectLines: /Ginza|Line/ },
  { name: "Seoul Gangnam → Seoul Station", from: [37.4979, 127.0276], to: [37.5547, 126.9707], time: `${D}T10:00:00+09:00` },
  { name: "Sydney Central → Bondi Junction", from: [-33.8832, 151.2063], to: [-33.8915, 151.2477], time: `${D}T10:00:00+11:00` },
  { name: "Delhi → Agra (Indian Railways)", from: [28.643, 77.2195], to: [27.1593, 78.001], time: `${D}T07:00:00+05:30` },
  { name: "Hong Kong Central → Tsim Sha Tsui", from: [22.2819, 114.1582], to: [22.2976, 114.1722], time: `${D}T10:00:00+08:00` },
  // Transitous lists a CDMX feed but (Nov 2026) has no Metro stops loaded: expected empty.
  { name: "Mexico City Zócalo → Chapultepec", from: [19.4326, -99.1332], to: [19.4204, -99.1819], time: `${D}T10:00:00-06:00`, expectRail: false },
  { name: "São Paulo Sé → Paulista", from: [-23.5503, -46.6339], to: [-23.5614, -46.6559], time: `${D}T10:00:00-03:00` },
  { name: "Melbourne Flinders St → St Kilda (tram)", from: [-37.8183, 144.9671], to: [-37.8678, 144.974], time: `${D}T10:00:00+11:00`, modes: ["LIGHT_RAIL"] },
  { name: "Rural Nevada (no rail)", from: [39.49, -117.07], to: [39.6, -116.93], time: `${D}T10:00:00-08:00`, expectRail: false },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const min = (s: number) => Math.round(s / 60);
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

function nonRailLegs(j: Journey, modes: RailMode[]): number {
  const ok = new Set<string>(["WALK", ...modes]);
  return j.legs.filter((l) => !ok.has(l.mode) || (l.mode !== "WALK" && !l.line)).length;
}

function sumMismatches(r: PlanResponse): number {
  return r.journeys.filter((j) => j.duration !== j.railDuration + j.walkDuration + j.waitDuration || j.waitDuration < 0).length;
}

async function main() {
  const filter = (process.argv[2] || "").toLowerCase();
  const cases = CASES.filter((c) => !filter || c.name.toLowerCase().includes(filter));
  const rows: string[] = [];
  let failures = 0;
  const header =
    pad("case", 40) + pad("#j", 4) + pad("lines used", 46) + pad("nonRail", 8) + pad("best", 6) + pad("rail/walk/wait (best)", 22) + pad("sum ok", 7) + "notes";
  console.log(header);
  console.log("-".repeat(header.length + 20));

  for (const c of cases) {
    const modes = c.modes ?? ALL_RAIL_MODES;
    const t0 = Date.now();
    let line: string;
    try {
      const r = await plan({
        from: { lat: c.from[0], lon: c.from[1] },
        to: { lat: c.to[0], lon: c.to[1] },
        options: { time: new Date(c.time).toISOString(), arriveBy: false, modes, maxWalkMinutes: c.maxWalk ?? 20 },
        language: "en",
      });
      const names = new Set<string>();
      for (const j of r.journeys) for (const l of j.legs) if (l.line) names.add(l.line.name);
      const nonRail = r.journeys.reduce((s, j) => s + nonRailLegs(j, modes), 0);
      const best = r.journeys.length ? r.journeys.reduce((a, b) => (b.duration < a.duration ? b : a)) : null;
      const mism = sumMismatches(r);
      const notes: string[] = [`${((Date.now() - t0) / 1000).toFixed(1)}s`, r.providers.join("+")];
      if (r.originTz) notes.push(r.originTz);
      const noColor = r.journeys.flatMap((j) => j.legs).filter((l) => l.line && !l.line.color).length;
      if (noColor) notes.push(`${noColor} legs w/o color`);
      if (r.warnings.length) notes.push(`warn: ${r.warnings.map((w) => w.slice(0, 70)).join(" / ")}`);
      const expectRail = c.expectRail ?? true;
      if (nonRail > 0) {
        failures++;
        notes.push("FAIL: non-rail leg");
      }
      if (mism > 0) {
        failures++;
        notes.push(`FAIL: ${mism} totals mismatch`);
      }
      if (expectRail && !r.journeys.length) notes.push("WARN: no journeys");
      if (!expectRail && r.journeys.length) notes.push("note: expected none");
      if (c.expectLines && r.journeys.length && ![...names].some((n) => c.expectLines!.test(n)))
        notes.push(`WARN: expected ${c.expectLines}`);
      line =
        pad(c.name, 40) +
        pad(String(r.journeys.length), 4) +
        pad([...names].join(", ") || "—", 46) +
        pad(String(nonRail), 8) +
        pad(best ? `${min(best.duration)}m` : "—", 6) +
        pad(best ? `${min(best.railDuration)}/${min(best.walkDuration)}/${min(best.waitDuration)}m` : "—", 22) +
        pad(mism ? "NO" : "yes", 7) +
        notes.join("; ");
    } catch (e) {
      const err = e as Error & { status?: number; detail?: string };
      line = pad(c.name, 40) + `ERROR ${err.status ?? ""} ${err.message}${err.detail ? ` — ${err.detail}` : ""}`;
      if (c.expectRail !== false) failures++;
    }
    console.log(line);
    rows.push(line);
    await sleep(1500);
  }
  console.log(`\n${cases.length} cases, ${failures} hard failures (non-rail legs, totals mismatches or errors).`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
