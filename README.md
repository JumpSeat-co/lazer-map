# lazer-map

Reusable MapLibre GL JS + OpenFreeMap Liberty map for the Lazer Careers site (Webflow). Versioned via git tags and served with jsDelivr.

Usage (pin an exact tag, never a branch):

    https://cdn.jsdelivr.net/gh/<OWNER>/lazer-map@v0.2.0/dist/lazer-map.min.js
    https://cdn.jsdelivr.net/gh/<OWNER>/lazer-map@v0.2.0/dist/lazer-map.css

Needs MapLibre GL JS 5.24.0 (jsDelivr npm). See PROTOTYPE-NOTES.md for behavior, privacy rules and tests (62 checks, `test/run.js`).
Points must be pre-generalized, public-safe data. Browser-side rounding is only a safety net.
