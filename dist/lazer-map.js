/*!
 * LazerMap: standalone MapLibre GL JS + OpenFreeMap (Liberty) map module.
 * Independent implementation: no map-builder wrapper, no vendor branding. Classic script (no build step), exposes window.LazerMap.
 *
 * Sections: 1 config | 2 privacy guard | 3 data sources | 4 style patch | 5 view (fit + limits)
 *           6 markers + tooltips | 7 UI states + controls | 8 controller | 9 auto-init
 */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- 1. config */
  var HARD_MAX_ZOOM = 10; // privacy cap; options can lower it but never raise it
  var ZIP_RE = /(^|[^0-9])[0-9]{5}([^0-9]|$)/; // any 5-digit run (ZIP, ZIP+4)

  var DEFAULTS = {
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    style: null,               // optional inline style object (tests / self-hosted style); skips the fetch
    market: null,              // filter points by point.market when set
    maxZoom: HARD_MAX_ZOOM,
    minZoomOffset: 1.5,        // how far out users may zoom from the fitted view
    boundsMargin: 1.5,         // pan limit = point bounds expanded by this ratio of their span
    coordPrecision: 2,         // decimals kept on public coordinates (2 = about 1.1 km)
    singlePointZoom: 9,
    loadTimeoutMs: 12000,
    cooperativeGestures: true, // page scroll is not hijacked by the embedded map
    patchStyle: true,
    labels: {
      region: 'Map of Lazer locations',
      pinSuffix: 'Lazer opportunities available',
      tooltip: 'Lazer opportunities are available in this area.',
      loading: 'Loading map…',
      error: 'The map could not be loaded.',
      retry: 'Try again',
      reset: 'Reset view',
      empty: 'No locations to show for this market yet.',
      partial: 'Some map details could not be loaded.',
      fallbackTitle: 'Locations in this market:',
      fallbackArea: 'Lazer location area'
    }
  };

  function merge(base, extra) {
    var out = {}, k;
    for (k in base) out[k] = base[k];
    for (k in (extra || {})) {
      out[k] = (extra[k] && typeof extra[k] === 'object' && !Array.isArray(extra[k]) && base[k] && typeof base[k] === 'object')
        ? merge(base[k], extra[k]) : extra[k];
    }
    return out;
  }

  /* ---------------------------------------------------------- 2. privacy guard */
  // Public data shape: { id, label, lng, lat, market? }. Everything else is dropped.
  // Coordinates are rounded. Labels containing a 5-digit (ZIP-like) number are replaced.
  function sanitizePoints(raw, opts) {
    var p = Math.max(0, Math.min(4, opts.coordPrecision | 0));
    var dropped = 0, relabeled = 0, excess = 0, out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (r, i) {
      var lng = Number(r && r.lng), lat = Number(r && r.lat);
      if (!isFinite(lng) || !isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 85) { dropped++; return; }
      var label = String((r && r.label) || '').replace(/[ \t\r\n]+/g, ' ').trim().slice(0, 80);
      if (!label || ZIP_RE.test(label)) { label = opts.labels.fallbackArea; relabeled++; }
      // Input more precise than the public precision means source coordinates reached the page (see README).
      if (Number(lng.toFixed(p)) !== lng || Number(lat.toFixed(p)) !== lat) excess++;
      out.push({
        id: String((r && r.id) || 'pt-' + i).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'pt-' + i,
        label: label,
        lng: Number(lng.toFixed(p)),
        lat: Number(lat.toFixed(p)),
        market: r && r.market ? String(r.market) : null
      });
    });
    if ((dropped || relabeled) && global.console) {
      console.warn('[LazerMap] privacy guard: ' + dropped + ' invalid point(s) dropped, ' + relabeled + ' label(s) generalized.');
    }
    if (excess && global.console) {
      console.warn('[LazerMap] ' + excess + ' point(s) arrived with more than ' + p + ' decimal places. Rounding in the browser does not protect source data: ' +
        'the page must be generated from pre-generalized public coordinates.');
    }
    return out;
  }

  /* ------------------------------------------------------------ 3. data sources */
  function parseJson(text) { try { return JSON.parse(text); } catch (e) { throw new Error('Invalid location data'); } }
  function pointsOf(json) { return Array.isArray(json) ? json : (json && json.points) || []; }

  // Webflow adapter: reads a (hidden) Collection List. Bind CMS fields to these attributes on each item:
  // data-lm-id, data-lm-lng, data-lm-lat, data-lm-label, data-lm-market
  function readCollection(listEl) {
    var items = listEl.querySelectorAll('[data-lm-lng][data-lm-lat]');
    return Array.prototype.map.call(items, function (el, i) {
      return {
        id: el.getAttribute('data-lm-id') || 'pt-' + i,
        label: el.getAttribute('data-lm-label'),
        lng: el.getAttribute('data-lm-lng'),
        lat: el.getAttribute('data-lm-lat'),
        market: el.getAttribute('data-lm-market')
      };
    });
  }

  function loadData(opts) {
    if (opts.data) return Promise.resolve(pointsOf(opts.data));
    if (opts.dataCollection) {
      var c = document.querySelector(opts.dataCollection);
      return c ? Promise.resolve(readCollection(c)) : Promise.reject(new Error('Collection not found'));
    }
    if (opts.dataElement) {
      var s = document.querySelector(opts.dataElement);
      return s ? Promise.resolve(pointsOf(parseJson(s.textContent))) : Promise.reject(new Error('Data element not found'));
    }
    if (opts.dataUrl) {
      return fetch(opts.dataUrl, { credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error('Data HTTP ' + r.status);
        return r.json();
      }).then(pointsOf);
    }
    return Promise.reject(new Error('No data source configured'));
  }

  /* ------------------------------------------------------------- 4. style patch */
  var C = {
    park: '#b5dea4', parkLine: '#86bf75', wood: '#a3d194', grass: '#c6e7b3',
    water: '#7dbdf0', waterway: '#4f9fe3',
    motorway: '#f4a640', motorwayCasing: '#8c5b1f',
    trunk: '#fbdc86', trunkCasing: '#a98a3c',
    minorCasing: '#c4bfb4'
  };
  function ramp(stops) { return ['interpolate', ['exponential', 1.4], ['zoom']].concat(stops); }

  function patchStyle(style) {
    var touched = 0;
    function paint(layer, props, layout) {
      layer.paint = Object.assign({}, layer.paint || {}, props);
      if (layout) layer.layout = Object.assign({}, layer.layout || {}, layout);
      touched++;
    }
    (style.layers || []).forEach(function (l) {
      var id = l.id;
      if (/^poi/.test(id)) { l.layout = Object.assign({}, l.layout, { visibility: 'none' }); return; }
      if (id === 'park') return paint(l, { 'fill-color': C.park, 'fill-opacity': 0.95 });
      if (id === 'park_outline') return paint(l, { 'line-color': C.parkLine });
      if (/^landcover_wood/.test(id)) return paint(l, { 'fill-color': C.wood });
      if (/^landcover_grass/.test(id)) return paint(l, { 'fill-color': C.grass });
      if (id === 'water') return paint(l, { 'fill-color': C.water });
      if (/^waterway_(river|other|tunnel)$/.test(id)) {
        return paint(l, { 'line-color': C.waterway, 'line-width': ramp([6, 0.6, 9, 1.4, 10, 2]) });
      }
      var m = /^(road|bridge|tunnel)_(motorway|motorway_link|trunk_primary|secondary_tertiary|minor)(_casing)?$/.exec(id);
      if (m) {
        var cls = m[2], casing = !!m[3], k;
        if (cls === 'motorway') {
          k = casing ? [5, 2, 7, 3.1, 9, 5, 10, 7, 12, 12] : [5, 1.1, 7, 1.8, 9, 3.3, 10, 5, 12, 9.2];
          return paint(l, { 'line-color': casing ? C.motorwayCasing : C.motorway, 'line-width': ramp(k), 'line-opacity': 1 });
        }
        if (cls === 'motorway_link') {
          k = casing ? [9, 1.4, 12, 6] : [9, 0.8, 12, 4];
          return paint(l, { 'line-color': casing ? C.motorwayCasing : C.motorway, 'line-width': ramp(k) });
        }
        if (cls === 'trunk_primary') {
          k = casing ? [6, 1.4, 8, 2.4, 10, 4.2, 12, 7] : [6, 0.8, 8, 1.6, 10, 3, 12, 5.2];
          return paint(l, { 'line-color': casing ? C.trunkCasing : C.trunk, 'line-width': ramp(k) });
        }
        if (cls === 'secondary_tertiary') {
          k = casing ? [8, 0.9, 10, 2.1, 12, 3.4] : [8, 0.4, 10, 1.3, 12, 2.4];
          return paint(l, { 'line-color': casing ? C.minorCasing : '#ffffff', 'line-width': ramp(k) }, {});
        }
        return paint(l, { 'line-color': casing ? C.minorCasing : '#ffffff' });
      }
      // Interstate shields and major road names: make them appear early enough to read at metro scale
      if (id === 'highway-shield-us-interstate' || id === 'road_shield_us' || id === 'highway-shield-non-us') {
        l.minzoom = Math.min(l.minzoom == null ? 7 : l.minzoom, 7);
        touched++;
      }
    });
    // Surface streets: lower the minzoom of the lightest road class we can show under the zoom cap
    (style.layers || []).forEach(function (l) {
      if (l.id === 'road_secondary_tertiary' || l.id === 'road_secondary_tertiary_casing') l.minzoom = Math.min(l.minzoom == null ? 8 : l.minzoom, 8);
    });
    return { style: style, touched: touched };
  }

  function loadStyle(opts) {
    if (opts.style) return Promise.resolve(opts.style);
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, opts.loadTimeoutMs) : null;
    return fetch(opts.styleUrl, ctl ? { signal: ctl.signal, credentials: 'omit' } : { credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('Style HTTP ' + r.status); return r.json(); })
      .then(function (s) { if (timer) clearTimeout(timer); return opts.patchStyle ? patchStyle(s).style : s; },
            function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  /* ------------------------------------------------------- 5. view: fit + limits */
  function boundsOf(points) {
    var w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    points.forEach(function (p) { w = Math.min(w, p.lng); e = Math.max(e, p.lng); s = Math.min(s, p.lat); n = Math.max(n, p.lat); });
    if (e - w < 0.02) { w -= 0.05; e += 0.05; }
    if (n - s < 0.02) { s -= 0.05; n += 0.05; }
    return [[w, s], [e, n]];
  }
  function paddingFor(el) {
    var w = el.clientWidth || 320, h = el.clientHeight || 360;
    var base = w < 480 ? 28 : w < 900 ? 52 : 80;
    var cap = function (v, dim) { return Math.max(8, Math.min(v, Math.floor(dim * 0.22))); };
    // Extra right gutter for the zoom buttons and extra bottom band for the reset control and attribution,
    // so no pin starts underneath a control.
    return { top: cap(base + 8, h), bottom: cap(base + 40, h), left: cap(base, w), right: cap(base + 44, w) };
  }
  function expand(b, ratio) {
    var dx = (b[1][0] - b[0][0]) * ratio, dy = (b[1][1] - b[0][1]) * ratio;
    return [[Math.max(-180, b[0][0] - dx), Math.max(-85, b[0][1] - dy)], [Math.min(180, b[1][0] + dx), Math.min(85, b[1][1] + dy)]];
  }
  function reducedMotion() { return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  /* ------------------------------------------------------- 7. UI states (DOM) */
  function el(tag, cls, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    for (var k in (attrs || {})) n.setAttribute(k, attrs[k]);
    return n;
  }

  // "Reset view": a small MapLibre control (button with label, so it is clear without hover).
  function resetControl(label, onClick) {
    var box;
    return {
      onAdd: function () {
        box = el('div', 'maplibregl-ctrl lm-reset-group');
        var b = el('button', 'lm-reset', { type: 'button', 'aria-label': label, title: label });
        b.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span></span>';
        b.lastChild.textContent = label;
        b.addEventListener('click', onClick);
        box.appendChild(b);
        return box;
      },
      onRemove: function () { if (box && box.parentNode) box.parentNode.removeChild(box); }
    };
  }

  /* ------------------------------------------------------------ 8. controller */
  var uid = 0;

  function init(target, userOptions) {
    var host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) throw new Error('LazerMap: container not found');
    var opts = merge(DEFAULTS, userOptions);
    opts.maxZoom = Math.min(Number(opts.maxZoom) || HARD_MAX_ZOOM, HARD_MAX_ZOOM);
    var id = 'lm' + (++uid), L = opts.labels;

    host.innerHTML = '';
    host.classList.add('lm-root');
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', L.region);
    var canvasEl = el('div', 'lm-canvas');
    var status = el('div', 'lm-status', { role: 'status', 'aria-live': 'polite' });
    var msg = el('p'); msg.style.margin = '0';
    var retryBtn = el('button', 'lm-retry', { type: 'button' }); retryBtn.textContent = L.retry;
    var fallback = el('ul', 'lm-fallback'); fallback.hidden = true;
    status.appendChild(el('div', 'lm-spinner', { 'aria-hidden': 'true' }));
    status.appendChild(msg); status.appendChild(retryBtn); status.appendChild(fallback);
    var notice = el('div', 'lm-notice', { role: 'status' }); notice.hidden = true;
    var srList = el('ul', 'lm-sr-only', { 'aria-label': L.region });
    host.appendChild(canvasEl); host.appendChild(notice); host.appendChild(srList); host.appendChild(status);

    var state = { map: null, markers: [], popup: null, pinned: null, points: [], bounds: null, destroyed: false, resizeObs: null, timer: null, tileErrors: 0, userMoved: false, lastW: 0, lastH: 0 };

    function setStatus(kind, text) {
      status.hidden = kind === 'ready';
      status.setAttribute('data-state', kind);
      if (kind === 'error' || kind === 'empty') status.setAttribute('role', 'alert'); else status.setAttribute('role', 'status');
      msg.textContent = text || '';
      fallback.hidden = !(kind === 'error' && state.points.length);
    }
    function fillLists(points) {
      srList.innerHTML = ''; fallback.innerHTML = '';
      if (points.length) {
        var t = el('li'); t.textContent = L.fallbackTitle; t.style.fontWeight = '600'; t.style.columnSpan = 'all';
        fallback.appendChild(t);
      }
      points.forEach(function (p) {
        [srList, fallback].forEach(function (list) { var li = el('li'); li.textContent = p.label; list.appendChild(li); });
      });
    }

    function hidePopup() {
      if (state.popup) { state.popup.remove(); state.popup = null; }
      state.markers.forEach(function (m) { m.el.removeAttribute('aria-describedby'); m.el.setAttribute('aria-expanded', 'false'); });
    }
    function showPopup(m) {
      hidePopup();
      var box = el('div', null, { role: 'tooltip', id: id + '-tip-' + m.point.id });
      var h = el('strong'); h.textContent = m.point.label;
      var p = el('span'); p.textContent = L.tooltip;
      box.appendChild(h); box.appendChild(p);
      state.popup = new global.maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 16, className: 'lm-tooltip', focusAfterOpen: false, maxWidth: '240px' })
        .setLngLat([m.point.lng, m.point.lat]).setDOMContent(box).addTo(state.map);
      m.el.setAttribute('aria-describedby', box.id);
      m.el.setAttribute('aria-expanded', 'true');
    }

    function addMarkers() {
      state.points.forEach(function (pt) {
        var b = el('button', 'lm-pin', { type: 'button', 'aria-label': pt.label + ', ' + L.pinSuffix, 'aria-expanded': 'false' });
        var m = { point: pt, el: b };
        b.addEventListener('mouseenter', function () { if (!state.pinned) showPopup(m); });
        b.addEventListener('mouseleave', function () { if (!state.pinned) hidePopup(); });
        b.addEventListener('focus', function () { if (!state.pinned) showPopup(m); });
        b.addEventListener('blur', function () { if (!state.pinned) hidePopup(); });
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          if (state.pinned === m) { state.pinned = null; hidePopup(); } else { state.pinned = m; showPopup(m); }
        });
        state.markers.push(m);
        new global.maplibregl.Marker({ element: b, anchor: 'center' }).setLngLat([pt.lng, pt.lat]).addTo(state.map);
      });
    }

    function onKey(e) { if (e.key === 'Escape' && (state.popup || state.pinned)) { state.pinned = null; hidePopup(); } }

    function applyLimits() {
      if (!state.map || state.destroyed) return;
      var cam = state.map.cameraForBounds(state.bounds, { padding: paddingFor(canvasEl), maxZoom: opts.maxZoom });
      var fitZoom = cam ? cam.zoom : opts.singlePointZoom;
      state.map.setMinZoom(Math.max(2, fitZoom - opts.minZoomOffset));
      state.map.setMaxBounds(limitBounds());
    }
    // Pan limit = point bounds + margin, but never smaller than ~2 viewports at maxZoom. A smaller box makes
    // MapLibre zoom IN to satisfy it, which would break the privacy zoom cap (found by test with a 1-point market).
    function limitBounds() {
      var b = expand(state.bounds, opts.boundsMargin);
      var dpp = 360 / (512 * Math.pow(2, opts.maxZoom));
      var halfW = Math.max(canvasEl.clientWidth, 320) * dpp, halfH = Math.max(canvasEl.clientHeight, 320) * dpp;
      var cx = (state.bounds[0][0] + state.bounds[1][0]) / 2, cy = (state.bounds[0][1] + state.bounds[1][1]) / 2;
      return [[Math.max(-180, Math.min(b[0][0], cx - halfW)), Math.max(-85, Math.min(b[0][1], cy - halfH))],
              [Math.min(180, Math.max(b[1][0], cx + halfW)), Math.min(85, Math.max(b[1][1], cy + halfH))]];
    }
    // Frames the market: fitBounds for several points, a fixed zoom for one. Limits are lifted while moving
    // (a stale pan limit can force a zoom) and always restored, even if no move event fires.
    function fit(animate) {
      var map = state.map;
      if (!map || state.destroyed || !state.bounds) return;
      map.setMaxBounds(null);
      var restored = false;
      var restore = function () { if (!restored) { restored = true; applyLimits(); } };
      var anim = !!animate && !reducedMotion();
      map.once('moveend', restore);
      setTimeout(restore, (anim ? 500 : 0) + 350);
      if (state.points.length === 1) {
        map.easeTo({ center: [state.points[0].lng, state.points[0].lat], zoom: opts.singlePointZoom, duration: anim ? 500 : 0, animate: anim });
      } else {
        map.fitBounds(state.bounds, { padding: paddingFor(canvasEl), maxZoom: opts.maxZoom, duration: anim ? 500 : 0, animate: anim });
      }
    }
    // Back to the original framed view, closing any tooltip. Also hands control back to automatic refitting.
    function resetView() {
      state.pinned = null; hidePopup();
      state.userMoved = false;
      fit(true);
    }

    function teardownMap() {
      if (state.resizeObs) { state.resizeObs.disconnect(); state.resizeObs = null; }
      document.removeEventListener('keydown', onKey);
      clearTimeout(state.timer);
      if (state.map) { try { state.map.remove(); } catch (e) { /* ignore */ } state.map = null; }
      state.markers = []; state.popup = null; state.pinned = null;
    }
    function fail(err) {
      if (state.destroyed) return;
      if (global.console) console.error('[LazerMap] ' + (err && err.message ? err.message : err));
      teardownMap();
      setStatus('error', L.error);
      if (typeof opts.onError === 'function') opts.onError(err);
    }

    function start() {
      teardownMap();
      state.tileErrors = 0; notice.hidden = true;
      setStatus('loading', L.loading);
      var dataP = loadData(opts).then(function (raw) {
        var pts = sanitizePoints(raw, opts);
        if (opts.market) pts = pts.filter(function (p) { return p.market === opts.market; });
        state.points = pts; fillLists(pts);
        return pts;
      });
      Promise.all([dataP, loadStyle(opts)]).then(function (res) {
        if (state.destroyed) return;
        var pts = res[0];
        if (!pts.length) { setStatus('empty', L.empty); return; }
        if (!global.maplibregl) throw new Error('MapLibre GL JS is not loaded');
        state.bounds = boundsOf(pts);
        var single = pts.length === 1;
        var mapOpts = {
          container: canvasEl, style: res[1], maxZoom: opts.maxZoom, renderWorldCopies: false,
          dragRotate: false, pitchWithRotate: false, touchPitch: false, cooperativeGestures: opts.cooperativeGestures,
          attributionControl: { compact: true }, fadeDuration: reducedMotion() ? 0 : 150,
          center: single ? [pts[0].lng, pts[0].lat] : undefined, zoom: single ? opts.singlePointZoom : undefined
        };
        if (!single) { mapOpts.bounds = state.bounds; mapOpts.fitBoundsOptions = { padding: paddingFor(canvasEl), maxZoom: opts.maxZoom }; }
        var map = state.map = new global.maplibregl.Map(mapOpts);
        map.touchZoomRotate.disableRotation();
        map.addControl(new global.maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        map.addControl(resetControl(L.reset, resetView), 'bottom-left');
        state.timer = setTimeout(function () { fail(new Error('Map load timed out')); }, opts.loadTimeoutMs);
        map.on('load', function () {
          clearTimeout(state.timer);
          addMarkers(); applyLimits(); setStatus('ready');
          // MapLibre opens the compact attribution at start; on phones it covers the Reset control.
          // Collapse it to the (i) button; the credit stays one tap or Enter away.
          var at = canvasEl.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact');
          if (at) { at.removeAttribute('open'); at.classList.remove('maplibregl-compact-show'); }
          map.on('click', function () { state.pinned = null; hidePopup(); });
          // Only gestures, keys and control buttons (they carry an originalEvent) count as the user moving the map.
          map.on('movestart', function (e) { if (e.originalEvent) state.userMoved = true; });
          document.addEventListener('keydown', onKey);
          if (typeof ResizeObserver === 'function') {
            var t;
            state.lastW = canvasEl.clientWidth; state.lastH = canvasEl.clientHeight;
            state.resizeObs = new ResizeObserver(function () {
              clearTimeout(t);
              t = setTimeout(function () {
                var w = canvasEl.clientWidth, h = canvasEl.clientHeight;
                if (w === state.lastW && h === state.lastH) return; // the observer's first callback, or no real change: do not move the map
                state.lastW = w; state.lastH = h;
                if (state.userMoved) applyLimits(); else fit(false); // never undo the user's own pan or zoom
              }, 150);
            });
            state.resizeObs.observe(canvasEl);
          }
          if (typeof opts.onReady === 'function') opts.onReady(api);
        });
        map.on('error', function (ev) {
          // Before 'load' a hard failure is caught by the timeout; after it, tile/glyph errors are non-fatal.
          state.tileErrors++;
          if (global.console && state.tileErrors === 1) console.warn('[LazerMap] resource error: ' + (ev && ev.error && ev.error.message));
          if (map.loaded() && notice.hidden && state.tileErrors > 2) { notice.textContent = L.partial; notice.hidden = false; }
        });
      }).catch(fail);
    }

    retryBtn.addEventListener('click', start);
    start();

    var api = {
      get map() { return state.map; },
      get points() { return state.points.slice(); },
      refit: resetView,
      reset: resetView,
      retry: start,
      destroy: function () { state.destroyed = true; teardownMap(); host.innerHTML = ''; host.classList.remove('lm-root'); }
    };
    return api;
  }

  /* ------------------------------------------------------------- 9. auto-init */
  // <div data-lazer-map data-market="atlanta-ga" data-source="#lm-data"></div>   (JSON in a <script type="application/json">)
  // or data-collection=".lm-collection" for a Webflow Collection List, or data-url="/points.json"
  function autoInit(root) {
    return Array.prototype.map.call((root || document).querySelectorAll('[data-lazer-map]'), function (node) {
      var o = {};
      if (node.dataset.market) o.market = node.dataset.market;
      if (node.dataset.source) o.dataElement = node.dataset.source;
      if (node.dataset.collection) o.dataCollection = node.dataset.collection;
      if (node.dataset.url) o.dataUrl = node.dataset.url;
      if (node.dataset.styleUrl) o.styleUrl = node.dataset.styleUrl;
      if (node.dataset.maxZoom) o.maxZoom = Number(node.dataset.maxZoom);
      return init(node, o);
    });
  }

  global.LazerMap = { init: init, autoInit: autoInit, sanitizePoints: sanitizePoints, patchStyle: patchStyle, HARD_MAX_ZOOM: HARD_MAX_ZOOM, version: '0.1.0-prototype' };
  if (!global.LAZER_MAP_NO_AUTO && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { autoInit(); });
    else autoInit();
  }
})(typeof window !== 'undefined' ? window : this);
