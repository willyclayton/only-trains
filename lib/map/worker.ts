/**
 * MapLibre v6 ships its web worker as a separate ES module and locates it
 * from `import.meta.url`. Under Turbopack that lookup breaks (the bundled
 * chunk has no http(s) import.meta.url, and the dynamic `new URL(\`./${name}\`)`
 * is statically resolved to the wrong file), so the map fails with
 * "Worker failed to load".
 *
 * A literal `new URL("…", import.meta.url)` is understood by Turbopack (and
 * webpack) as an asset reference: the file is emitted under /_next/static and
 * the expression evaluates to its served URL. The worker module is
 * self-contained (no imports), so serving it as a static file is enough.
 */
import { setWorkerUrl } from "maplibre-gl";

let configured = false;

export function configureMapWorker(): void {
  if (configured) return;
  configured = true;
  try {
    const ref = new URL("../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url);
    // Turbopack yields a root-relative URL here; make it absolute for new Worker().
    const abs = new URL(String(ref.href ?? ref), window.location.href).href;
    if (/^https?:/.test(abs)) setWorkerUrl(abs);
  } catch {
    /* fall back to MapLibre's own lookup */
  }
}
