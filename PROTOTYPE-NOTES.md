# Lazer map: standalone prototype (R4M.2 + R4M.2B refinements)

Independent MapLibre GL JS 5.24.0 + OpenFreeMap Liberty map. No No Code Flow scripts, components, branding or API key. Nothing here touches Webflow, its CMS or MAP LAB.

## Run it

**Simplest way in Chrome:** unzip, then double-click `index.html` (or drag it into a Chrome window). It needs an internet connection, because the map tiles come from OpenFreeMap. Everything else (MapLibre, the module, the data) is local.

If the map shows "The map could not be loaded" when opened from a file, serve the folder instead and open the address in Chrome:

```
cd lazer-map-prototype
python3 -m http.server 8000      # then open http://localhost:8000/
```

## Webflow requirement: pre-generalized public coordinates (read before integrating)

**The real Webflow integration must feed the map only coordinates that were generalized before they reach the page. Rounding in the browser is not protection for the original CMS coordinates.**

- `sanitizePoints` rounds to 2 decimals, but by then the original values have already been delivered to the visitor. They sit in the page HTML, in a hidden Collection List (hidden is not private), and in the network response, and CMS collection pages (for example `/map-points/<slug>`) are public too.
- So the CMS needs separate public fields (display latitude, display longitude, public area label, market). They must be generated server-side or in a CMS process (for example an automation that rounds or snaps to an area centroid; the method is a team decision), then the page binds only those fields.
- Never bind the original latitude, longitude, ZIP or address fields to anything on a public page or template. Keep original-field data off public templates and unpublished from public collection pages.
- The module logs a console warning when input is more precise than the public precision (`pre-generalized` in the message). It is a tripwire for mistakes, not a control.

Demo switches (add to the address): `?state=error` (forces a style failure) and `?state=empty` (unknown market).

## Files

| Path | Purpose |
|---|---|
| `index.html` | Demo page: placeholder hero, then the map, as it would sit on a Main Location page |
| `src/lazer-map.js` | The module (about 12 KB minified, 4.8 KB gzip). Exposes `window.LazerMap` |
| `src/lazer-map.css` | Styles scoped to `.lm-root`. Brand red is one variable: `--lm-pin` |
| `data/atlanta-mock.json` | 14 mock, generalized Atlanta area points. Not derived from the pilot CMS records |
| `vendor/` | MapLibre GL JS 5.24.0 (JS, CSS, license), self-hosted (no SRI on local files; see the hashes below if you serve them from a CDN) |
| `test/` | 62 offline checks (Playwright, stub style). Run: `npm i playwright-core`, then `CHROMIUM_PATH=<chrome> node test/run.js` (set `V=1` for details) |
| `preview/` | Real-tile Chrome captures: `01` new desktop, `02` original desktop, `03` side by side, `04` mobile 390 px before and after a tooltip tap, `07` interstate colors before and after, `08` marker sizes 16/18/20 px |

## Architecture

The module has nine sections in one file and no build step:

1. **Config.** Defaults plus a hard zoom cap. `maxZoom` can be lowered by options but never raised above 10.
2. **Privacy guard.** Every point passes through `sanitizePoints` before the map sees it. Only `id, label, lng, lat, market` survive. Coordinates are rounded to 2 decimals (about 1.1 km). Any label containing a 5-digit number is replaced with a generic one. Invalid points are dropped.
3. **Data sources.** One shape, four ways to supply it: inline `data`, a `<script type="application/json">` (`dataElement`), a hidden Webflow Collection List (`dataCollection`, via `data-lm-*` attributes), or a `dataUrl`.
4. **Style patch.** Liberty's style JSON is fetched at runtime and its paint properties are overridden by layer ID (parks green, water and waterways blue, interstates thick orange with dark casing, trunk/primary yellow, POIs hidden, interstate shields shown from zoom 7). If a layer ID is missing it is skipped, so an upstream change degrades the look rather than breaking the map.
5. **View.** `fitBounds` uses responsive padding based on container width (28 / 52 / 80 px, capped to 22% of the container). The view is re-fitted on resize via `ResizeObserver` (debounced, animation off under reduced motion). `minZoom` is the fitted zoom minus 1.5. A pan limit (`maxBounds`) keeps users in the market area.
6. **Markers and tooltips.** Each pin is a real `<button>` with an `aria-label`. The tooltip is a `role="tooltip"` linked by `aria-describedby`. It opens on hover and focus, pins on click or tap (tap again to close), and closes on Escape or map click.
7. **UI states.** Loading, ready, empty, error (with Try again and a plain-text list of areas), and a non-blocking notice when tiles partly fail. A 12 s timeout turns a hung load into the error state.
8. **Controller.** `LazerMap.init(el, options)` returns `{ map, points, refit(), retry(), destroy() }`.
9. **Auto-init.** `<div data-lazer-map data-market="atlanta-ga" data-source="#lm-data">` works with no JavaScript written on the page.

Other behaviors: cooperative gestures (the page still scrolls past the map; desktop zooms with Ctrl+scroll, mobile pans with two fingers), rotation and pitch disabled, a visually hidden list of locations for screen readers, and OpenFreeMap / OpenMapTiles / OpenStreetMap attribution kept on the map.

### Bugs found and fixed during testing

1. **Stylesheet order.** MapLibre's CSS sets `.maplibregl-map { position: relative }`, which overrode the module's `position: absolute` when it loaded later and collapsed the map to 300 px high. The rule now has higher specificity, so load order no longer matters (a Webflow embed may differ from `index.html`). A test covers it.
2. **Zoom cap leak.** The pan limit for a market with very few points was smaller than one screen at max zoom. MapLibre responded by zooming in past the cap (10.78 in the test). The pan limit is now never smaller than two viewports at max zoom, and a regression test covers it.

## R4M.2B refinements

1. **Reset view.** A labelled "Reset view" button (bottom-left, keyboard focusable, at least 32 px tall) returns to the original `fitBounds` view with all markers, closes any open tooltip, and restores zoom and pan limits. Also available as `LazerMap` instance `reset()`. Verified by mouse and Enter key, including a single-point market. In real Chrome: zoom 10 and a moved center returned to the original center and zoom exactly.
2. **Tooltip and map movement.** MapLibre popups do not pan or zoom the map, and none did: opening all 14 tooltips by tap (390 px) and click (desktop) changed no center, zoom, scroll position or pin position (0 px in real Chrome), and every tooltip stayed inside the map. The unnecessary movement that did exist came from elsewhere and is fixed: an animated refit right after load, and a refit on resize that threw away a view the user had moved. Now there is no move after load, and resize refits only if the user has not moved the map.
3. **Interstates softened.** Fill `#f59e0b` to `#f4a640`, casing `#6b3f00` to `#8c5b1f`, trunk/primary `#fbdc86`. Casing contrast against land is 5.3:1 (rule: at least 3:1), interstates remain clearly separate from primary roads, shields still show from zoom 7. `preview/07` compares colors only; the line widths were also trimmed slightly.
4. **Marker size.** Default is an 18 px red fill (white 2 px ring adds 2 px each side; 32 px hit area unchanged), 16 px under 360 px wide. 20 px works from 390 px up but leaves 2 px between neighbours at 320 px wide. Smallest center gap between any two markers: 26 px at 320 wide, 34 px at 390, 40 px at 1280, 58 px at 1920. `preview/08` shows 16/18/20.
5. **Initial visibility.** At 12 viewport sizes (320 to 1920 px) all 14 markers are visible on load, none sits under a control, and no tooltip is open. The fit padding now reserves room for the zoom buttons and Reset.
6. **Preserved.** Max zoom 10 (also by keyboard), keyboard access (Tab reaches all 14 pins, zoom in, zoom out, Reset; Escape closes tooltips), and the privacy behavior, now with the precision warning.
7. **Found while verifying on mobile.** MapLibre starts the compact attribution expanded, and at 390 px it covered the Reset button. It now starts collapsed to the (i) button (still one tap or Enter away). A test covers 320, 390, 768 and 1280 px.

## Current map vs new map

Images are in `preview/`. The new-map images are real Liberty tiles rendered in Chrome with the 14 mock points. (An earlier version of this table described the original as having no roads or water; that came from a capture taken before its tiles had loaded and was wrong.)

| | Current (NCF prototype) | New prototype |
|---|---|---|
| Basemap | Muted light-grey basemap with grey roads and labels. No green parks, no blue water | Liberty: green parks and land cover, blue water and rivers, state lines, city labels |
| Roads | Thin grey lines | Arterials and secondary roads in white/yellow from the metro view; thin local streets also visible at the cap |
| Interstates | Same grey as other major roads, with small shields; hard to pick out | Amber with dark casing and interstate shields (I-20, I-75, I-85, I-285, I-675); primary roads thinner and yellow |
| Pins | Lazer red; the 9 pilot pins sit in the south-west with one at the screen edge | Lazer red, 18 px dot in a 32 px hit area, white ring, focus ring; all 14 mock points fitted |
| Tooltips | NCF templates (hidden Collection List, 26 items vs 9 map items, logs a console error) | Simple tooltip, keyboard and touch accessible |
| Fit to market | None (no `fitBounds`) | Automatic, responsive padding, refits on resize |
| Zoom cap | 10 | 10, enforced in code and by tests |
| Branding | Two "Powered by No Code Flow" badges | None. Only the required map data attribution |
| Public data | ZIP in slugs and names, 4-decimal coordinates in the DOM, vendor API key in the script URL | No ZIPs; coordinates rounded to about 1 km; no keys |

The original and new maps are the same width in `preview/03-comparison-desktop.png`. The original site refuses to be shown inside a frame, so a 390 px capture of it was not possible; the new map's mobile view is in `preview/04-mobile-new-390px-before-after-tooltip.png`.

## Verification

- **Offline tests (62/62 pass).** (The previous version fails 13 of the new checks.) Fit on desktop and mobile widths, zoom cap and pan limit, accessibility behavior, no ZIP text or coordinates in the map DOM, sanitizer, single-point market, market filter, empty and error states, refit on resize, and no No Code Flow references in the source.
- **Real rendering.** Checked in Chrome against live OpenFreeMap tiles: load, fit, attribution, tooltip, live refit when the layout width changed, and the zoom cap (a request for zoom 15 landed at 10).
- **Not tested.** Real touch input on a phone (the mobile capture is a true 390 px frame with a simulated tap), Safari/Firefox, a screen reader, and anything inside Webflow.

## Limitations and open questions

1. **Street detail is capped by the zoom cap.** At max zoom 10 you see arterials, secondary roads and thin local lines, not named neighborhood streets. Raising the cap would show more but conflicts with the privacy requirement.
2. **Full market extent needs more than points.** The map fits to the points it is given. The nine pilot points are pilot data, so they are not treated as complete. For "full geographic extent of each market" (Southern California especially), each market needs either a complete point list or an optional bounding box. The module does not yet accept a market bounding box; that is a small addition once the data exists.
3. **Rounded coordinates are still in the page source by design.** At 0.01° they are neighborhood-level, not facility-level. If even that is too precise, increase rounding or generalize server-side before the data reaches the page. This is a decision for the team.
4. **Gray urban land use dominates the dense core** in Liberty, so parks look small at metro scale. A softer urban tone is a small style change if wanted.
5. **Interstate vs primary road contrast is moderate** (amber vs pale yellow). The shields and extra width carry most of the distinction. A stronger color change is possible if the client wants it.
6. **Runtime dependency on OpenFreeMap.** No SLA, no rate limit published, may change without notice. The style is fetched and patched at runtime, so upstream layer renames could weaken the overrides. Mitigations are in the plan below.
7. **Cooperative gestures** (Ctrl+scroll to zoom on desktop) is a UX choice to confirm.

## Data requirements

Public-safe fields only, per point: `id`, `label` (neutral area name, no ZIP or street), `lng`, `lat` (generalized), `market`. For the CMS this means a few new fields (display latitude/longitude, public area label, market reference), and stopping the use of ZIP-based names or slugs on any public page. Atlanta needs a confirmed, complete point list; Chicago, Dallas, Southern California and smaller markets need theirs, plus a bounding box per market for the extent question above.

## Proposed Webflow integration plan

Nothing below has been done. Each step needs approval.

1. **CMS prep (staging first).** Add the public-safe fields and a Market reference to Map Points. Backfill from reviewed data, not from the pilot ZIP records. Exclude placeholder records.
2. **Assets.** Upload `maplibre-gl.js/css` (5.24.0), `lazer-map.js/css` as Webflow assets, or host them on a pinned CDN with SRI (sha384 for the vendored files: `maplibre-gl.js` 5+cfbwT0iiub6VsQAdn6yz16nr6sDiQoHx6tm4O8OVYXHYOxcffFmCJBL0dgdvGp, `maplibre-gl.css` uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK). Keep a pinned copy of the Liberty style JSON as a fallback.
3. **Component.** Build one "Location Map" component placed after the hero on each Main Location page: a container with `data-lazer-map` and `data-market`, plus a hidden Collection List filtered by that page's market, with each CMS field bound to a `data-lm-*` attribute. The component loads the scripts once.
4. **Prove it on a branch.** Use the MAP LAB site or a page branch, never production. Compare against the acceptance checks below.
5. **Rollout.** Add to each Main Location page, then remove the NCF scripts, badges and key from the pilot.

### Acceptance checks for the Webflow version

- No No Code Flow requests or markup. No ZIPs in slugs, text or attributes.
- Every market shows all its points on load at desktop and mobile widths, and never zooms past 10.
- Pins and tooltips work by mouse, touch and keyboard. Error and empty states appear when expected.
- Page scroll is not trapped by the map. Lighthouse and layout shift are no worse than before the map was added.
