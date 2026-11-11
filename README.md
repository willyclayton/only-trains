# Only Trains

Pick two points anywhere in the world and get there using **only trains and walking**: metro and subway (the Chicago "L", NYC Subway, the Tube), commuter and regional rail, intercity and high-speed trains, light rail and trams. No buses, ferries, coaches or planes.

Every route shows the specific lines you ride, in their official colors, with the boarding station, direction, stop count, transfers and turn-by-turn walking. Each trip shows its total time split into time on trains, time walking and time waiting.

## How it works

| Piece | What it does |
| --- | --- |
| `app/api/plan` | Plans the trip. Calls [Transitous](https://transitous.org) (a free, community-run [MOTIS](https://github.com/motis-project/motis) instance with worldwide GTFS timetables), restricted to rail modes with walking-only access, egress and transfers. If nothing is found, it raises the walking limit (to 30, then 60 min) and says so. Any itinerary that contains a non-rail leg is dropped. |
| `app/api/geocode` | Search box. Merges station matches from Transitous with addresses and places from [Photon](https://photon.komoot.io) (OpenStreetMap). |
| `app/api/reverse` | Names a pin dropped on the map. |
| `components/MapView.tsx` | MapLibre GL map on [OpenFreeMap](https://openfreemap.org) basemaps, with an [OpenRailwayMap](https://www.openrailwaymap.org) track overlay (standard, max speed or electrification). |
| `components/*` | Search panel, journey cards and step-by-step detail. |
| `lib/types.ts` | The provider-agnostic contract every provider normalizes into. |

Optional: if `GOOGLE_MAPS_API_KEY` is set, the Google Routes API (transit, rail modes only) is used as a fallback where Transitous finds nothing.

## Run locally

```bash
npm install
npm run dev
# open http://localhost:3000
```

Try the Chicago L: `http://localhost:3000/?from=41.9088,-87.6776&fromName=Wicker%20Park&to=41.8826,-87.6233&toName=The%20Loop`

Routing smoke test across 18 cities: `npx tsx scripts/test-plan.ts` (or `npx tsx scripts/test-plan.ts chicago`).

## Deploy to Vercel

1. Import the repository in Vercel. The defaults are correct: Next.js framework preset, `npm run build`.
2. Optional environment variables (see `.env.example`):
   - `ONLY_TRAINS_CONTACT`: an email or URL added to the User-Agent sent to Transitous and Photon. Their policies ask for a way to contact the app's operator.
   - `GOOGLE_MAPS_API_KEY`: enables the Google Routes fallback (billed by Google).
   - `PHOTON_URL`: your own [Photon](https://github.com/komoot/photon) instance for search. The public one is fair-use only and sometimes returns 503 under load.
3. Deploy. No database or other services are needed.

## Data sources and usage terms

- **Transitous** routing is free for **open-source, non-commercial** projects. Their policy requires a visible link to [transitous.org/sources](https://transitous.org/sources/) (shown in the app), OpenStreetMap attribution, and a User-Agent with the app name, version and contact. Above roughly 720 route searches a day, coordinate with the Transitous team in their Matrix channel. The plan API de-duplicates identical requests and lets the CDN cache explicit-time searches briefly to keep load down. Policy: <https://transitous.org/api/>.
- **Photon** geocoding (komoot) is a fair-use public service. For heavy traffic, self-host Photon or switch to a keyed geocoder.
- **OpenFreeMap** basemaps are free with attribution: © OpenMapTiles, © OpenStreetMap contributors.
- **OpenRailwayMap** tiles are CC-BY-SA with attribution. The overlay can be switched off in the map's layer menu.

## Coverage

Coverage follows the open timetable data Transitous has. It is strong across Europe, Japan, South Korea, the US and Canada, Australia, Hong Kong and Brazil. Some major systems are missing today (for example the Mexico City Metro and the Delhi Metro), as are mainland China and most of Africa. Where there's no data, the app says so instead of suggesting a bus.
