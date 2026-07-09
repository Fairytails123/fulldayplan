/* ==================================================================
 * Reorder Routes — staging tab module (added 2026-06-26)
 * ------------------------------------------------------------------
 * Additive companion to index_v6.html. Loaded right after route_sender.js.
 * Powers the new "🔄 Reorder Routes" tab: a route that is STAGED (the
 * "📍 Stage Route" button now sends stage_only:true, so n8n optimises but
 * does NOT post to Telegram) lands in a new `ReorderQueue` tab of the Load
 * Plan workbook. Staff drag the optimised stops into the order they want,
 * then press "Send Final Route", which replays the EXISTING n8n webhook with
 * skip_optimisation:true (and NO is_reorder / is_update / stage_only) so the
 * Telegram message is byte-identical to a normal first send.
 *
 * Self-contained (own URLs + token). Reuses index_v6.html's tile-drag VISUAL
 * primitives (.is-dragging clone, .send-route-btn states, the toast classes)
 * but NOT the protected kennel-drag handlers — this is a simple vertical
 * grip-drag list. Exposes window.RouteReorder = { enter, exit } which the tab
 * switcher calls.
 *
 * "🗺 Check on Map" (added 2026-07-09): each card can open an inline Leaflet map
 * (lazy-loaded, OSM tiles) plotting its stops in the CURRENT tile order, so staff
 * can sanity-check the route geographically before Send Final Route. It re-draws on
 * every order change (drag, Reverse, ✕, remote edit). Coordinates ride the staged
 * ctx (`c`/`sc`/`ec`, written by Format Route; `ex` for Add-Dog stops) — nothing is
 * re-geocoded client-side, so the map shows exactly the points RouteXL optimised on.
 * "⛶ Full screen" blows the same map up to fill the desktop/mobile viewport (a CSS
 * overlay, not the Fullscreen API — iOS Safari only grants that to <video>); Escape
 * or "✕ Close" returns it to the card.
 *
 * Backend contract (all on the EXISTING Apps Script web app the page already
 * uses for Share/Fetch):
 *   GET  ?action=loadStaged&token=…        -> { ok, slots:[ {slot_key, section,
 *        van, ctx:{v,p,t,rt,r,s,sa,ea,d,o,aa,gg,c,sc,ec,ex}, skipped, staged_at, rev, …} ] }
 *   POST { action:'saveOrder', token, slot_key, o, last_reordered_by }
 *   POST { action:'clearSlot', token, slot_key }
 * Final send goes to the EXISTING n8n webhook, not the Apps Script.
 * ================================================================== */

(function () {
  'use strict';
  if (window.RouteReorder) return; // guard against double-load

  // ---- config ----------------------------------------------------
  var REORDER_URL = 'https://script.google.com/macros/s/AKfycbxUeIiIJQZZeoo3aXHDdqVZNNqFKLhWhi_WhPVb6GUIvkMlfNxTKsOXyCTGdvAEsMLC/exec';
  var N8N_WEBHOOK_URL = 'https://auto.thefairytails.co.uk/webhook/van-route';
  var TOKEN = 'ft-k9-board-2024-sec';
  var POLL_MS = 5000;
  var SAVE_DEBOUNCE_MS = 600;
  var REQUEST_TIMEOUT_MS = 30000;
  var SENT_RESET_MS = 2500;   // after a send: hold "✅ Sent", then re-enable so the (persisting) route can be re-sent
  var CLEAR_TOMBSTONE_MS = 6000;   // ignore a just-cleared slot for this long so an in-flight poll can't re-add its card

  var SECTIONS = [
    { key: 'HALF_DAY', title: '☀️ Today — Half Day' },
    { key: 'PM',       title: '🌆 Today — PM' },
    { key: 'NEXT_AM',  title: '📅 Next Day — AM' }
  ];
  var VAN_ORDER = ['BV', 'BVX', 'SV'];

  // "Add Dog" — section → route defaults used ONLY when creating a brand-new slot
  // (an add to a van+route that has nothing staged). period + run_type + a sensible
  // default departure; mirrors the Load Plan's own defaults + the Half-Day 12:30.
  var SECTION_DEFAULTS = {
    HALF_DAY: { p: 'PM',      rt: 'HD', t: '12:30' },
    PM:       { p: 'PM',      rt: 'FD', t: '15:00' },
    NEXT_AM:  { p: 'NEXT_AM', rt: '',   t: '08:00' }
  };
  var NEXT_AM_DEPART = { BV: '08:30', BVX: '08:30', SV: '07:30' }; // NEXT_AM default depart per van
  var STAGING_LS_KEY = 'reorder_staging_v1';

  // ---- map ("Check on Map") --------------------------------------
  // Leaflet is loaded LAZILY on the first "Check on Map" tap, so the Load Plan
  // never blocks on (or pays for) a CDN fetch it may not need, and a CDN outage
  // degrades to a toast instead of a broken page. SRI hashes pin the exact
  // 1.9.4 bytes (verified against the published leafletjs.com integrity values).
  var LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  var LEAFLET_JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
  var LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  var LEAFLET_CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
  var TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  var TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  // Fairy Tails K9 Centre (TN35 5DT) — byte-identical to stage3_build_routexl_request.js
  // CENTRE. Only a FALLBACK: used when a staged ctx has no sc/ec (a slot created by
  // the Add Dog panel, or one staged before this feature shipped).
  var CENTRE_LATLNG = [50.8741198, 0.6255011];
  var leafletPromise = null;

  // ---- state -----------------------------------------------------
  var active = false;
  var pollTimer = null;
  var pollFails = 0;
  var slots = {};   // slot_key -> { record, card, stopsById, renderedRev, dragging, pendingSave, saveTimer, staleRemove, preDragOrder }
  var cleared = {}; // slot_key -> Date.now() tombstone: a slot we just removed (so a stale in-flight poll can't re-add its card)
  var drag = null;  // active drag context
  var staging = []; // "Add Dog" pending tiles: [{id,name,address,van,section,status,lat,lng,km,reason}], persisted in localStorage

  // ---- small helpers --------------------------------------------
  function deviceId() {
    var k = 'reorder_device_id';
    var v = '';
    try { v = localStorage.getItem(k) || ''; } catch (e) {}
    if (!v) {
      v = 'd' + Math.floor(Math.random() * 1e9).toString(36);
      try { localStorage.setItem(k, v); } catch (e2) {}
    }
    return v;
  }

  function normNm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // normKey — the COORDINATE key. Must stay byte-identical to stage4_format_route.js
  // `normaliseName()` (which builds ctx.c's keys) and to stage2's `normalise()`.
  // NOT the same as normNm above: this also folds accents (Zoë → zoe) and strips
  // punctuation, so a name that stage4 keyed as "zoe ardern" is found here too.
  // Idempotent, so re-normalising an already-normalised ctx.c key is a no-op.
  function normKey(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{Letter}\p{Number}\s'-]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function normSet(arr) {
    var m = {};
    (arr || []).forEach(function (n) { m[normNm(n)] = true; });
    return m;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtTime(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      var h = d.getHours(), m = d.getMinutes();
      return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
    } catch (e) { return ''; }
  }

  // Short, staff-friendly label for WHY a dog was held out of the staged route,
  // so the "not staged" banner is actionable (e.g. tells staff a grooming dog
  // needs adding to the grooming tab, not the master). Mirrors the skip reasons
  // emitted by Stage 2/3 (stage2_fuzzy_match.js / stage3_build_routexl_request.js).
  function skipReasonLabel(s) {
    if (!s) return '';
    switch (s.reason) {
      case 'not_found':      return s.is_grooming ? 'not on grooming tab' : 'not on master sheet';
      case 'no_address':     return 'no address on master sheet';
      case 'no_coordinates': return 'not geocoded yet';
      case 'suspect_far':    return 'address looks wrong — add a postcode';
      case 'alt_no_table':
      case 'alt_not_listed':
      case 'alt_no_address':
      case 'alt_no_coordinates': return 'no 2nd address set';
      default: return s.reason || '';
    }
  }

  // Reuse the page's toast look (.toast-container/.toast/.toast-*). We build the
  // DOM directly rather than calling the inline IIFE's showToast (different scope).
  function toast(msg, type) {
    var c = document.querySelector('.toast-container');
    if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c); }
    var t = document.createElement('div');
    t.className = 'toast toast-' + (type || 'info');
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3000);
  }

  // ---- network (preflight-free idiom, mirrors the page's Share/Fetch) -----
  function getStaged() {
    return fetch(REORDER_URL + '?action=loadStaged&token=' + encodeURIComponent(TOKEN),
      { method: 'GET', cache: 'no-cache', redirect: 'follow' })
      .then(function (r) { return r.json(); });
  }
  function postStore(body) {
    // No Content-Type header => simple request, no CORS preflight (Apps Script).
    return fetch(REORDER_URL, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' })
      .then(function (r) { return r.text(); })
      .then(function (t) { try { return JSON.parse(t); } catch (e) { return { ok: false, error: 'bad json' }; } });
  }
  function postN8n(payload) {
    var controller = new AbortController();
    var to = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    return fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    }).then(function (res) {
      clearTimeout(to);
      if (!res.ok) throw new Error('Webhook responded ' + res.status);
      return res;
    }).catch(function (err) { clearTimeout(to); throw err; });
  }

  // ---- skeleton + card DOM --------------------------------------
  // Styles for the controls this module ADDS (per-tile ✕ remove, per-section
  // Clear-route button, the "✅ sent" flag). Injected once so the whole feature
  // stays in this single self-contained file; the base .reorder-* styles live in
  // index_v6.html and are unchanged.
  function ensureStyles() {
    if (document.getElementById('reorder-extra-styles')) return;
    var css =
      '.reorder-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 12px;}' +
      '.reorder-section-head .reorder-section-title{margin:0;}' +
      '.reorder-clear-section{flex:0 0 auto;border:1px solid #fecaca;background:#fff5f5;color:#b91c1c;' +
        'font-size:12px;font-weight:600;padding:5px 10px;border-radius:8px;cursor:pointer;line-height:1.2;}' +
      '.reorder-clear-section:hover:not(:disabled){background:#fee2e2;}' +
      '.reorder-clear-section:disabled{opacity:.4;cursor:default;}' +
      '.reorder-tile .reorder-del{flex:0 0 auto;align-self:flex-start;width:24px;height:24px;display:inline-flex;' +
        'align-items:center;justify-content:center;margin-left:2px;border:none;border-radius:50%;background:#fee2e2;' +
        'color:#b91c1c;font-size:14px;font-weight:700;line-height:1;cursor:pointer;padding:0;}' +
      '.reorder-tile .reorder-del:hover{background:#fecaca;color:#7f1d1d;}' +
      '.reorder-sent-flag{background:var(--success);color:#fff;font-size:11px;padding:1px 8px;border-radius:999px;}' +
      '.reorder-day{background:#eef2ff;color:#3730a3;font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px;letter-spacing:.3px;}' +
      // ---- Add Dog panel ----
      '.reorder-add{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;}' +
      '.reorder-add-head{font-weight:700;font-size:15px;margin:0 0 10px;color:#0f172a;}' +
      '.reorder-add-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}' +
      '.reorder-add-form input,.reorder-add-form select{font-size:14px;padding:8px 10px;border:1px solid #cbd5e1;' +
        'border-radius:8px;background:#fff;color:#0f172a;min-height:38px;box-sizing:border-box;}' +
      '.reorder-add-name{flex:1 1 140px;min-width:120px;}' +
      '.reorder-add-addr{flex:2 1 240px;min-width:160px;}' +
      '.reorder-add-van,.reorder-add-route{flex:0 0 auto;cursor:pointer;}' +
      '.reorder-add-btn{flex:0 0 auto;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;' +
        'font-weight:600;padding:9px 16px;cursor:pointer;min-height:38px;}' +
      '.reorder-add-btn:hover{background:#1d4ed8;}' +
      // ---- staging tiles ----
      '.reorder-staging{display:flex;flex-direction:column;gap:8px;margin-top:12px;}' +
      '.reorder-stage-tile{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;' +
        'padding:10px 12px;border-radius:10px;border:1px solid #e2e8f0;background:#fff;}' +
      '.reorder-stage--checking{border-color:#cbd5e1;background:#f8fafc;}' +
      '.reorder-stage--valid{border-color:#bbf7d0;background:#f0fdf4;}' +
      '.reorder-stage--invalid{border-color:#fecaca;background:#fff5f5;}' +
      '.reorder-stage-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 200px;}' +
      '.reorder-stage-name{font-weight:700;font-size:14px;color:#0f172a;}' +
      '.reorder-stage-meta{font-size:11px;color:#64748b;font-weight:600;}' +
      '.reorder-stage-addr{font-size:12px;color:#475569;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}' +
      '.reorder-stage-side{display:flex;align-items:center;gap:10px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end;}' +
      '.reorder-stage-status{font-size:12px;font-weight:600;}' +
      '.reorder-stage--valid .reorder-stage-status{color:#15803d;}' +
      '.reorder-stage--invalid .reorder-stage-status{color:#b91c1c;}' +
      '.reorder-stage--checking .reorder-stage-status{color:#64748b;}' +
      '.reorder-stage-actions{display:flex;gap:6px;align-items:center;}' +
      '.reorder-stage-add{border:none;border-radius:8px;background:var(--success,#16a34a);color:#fff;font-size:12px;' +
        'font-weight:700;padding:6px 12px;cursor:pointer;}' +
      '.reorder-stage-recheck{border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#334155;font-size:12px;' +
        'font-weight:600;padding:6px 10px;cursor:pointer;}' +
      '.reorder-stage-x{border:none;border-radius:50%;width:24px;height:24px;background:#fee2e2;color:#b91c1c;' +
        'font-size:13px;font-weight:700;cursor:pointer;line-height:1;padding:0;}' +
      '.reorder-stage-x:hover{background:#fecaca;}' +
      // ---- per-card foot (Map + Reverse on row 1, Send full-width on row 2) ----
      '.reorder-slot-foot{display:flex;gap:8px;align-items:stretch;margin-top:4px;flex-wrap:wrap;}' +
      '.reorder-slot-foot .reorder-send{flex:1 1 100%;}' +
      '.reorder-reverse,.reorder-mapbtn{flex:1 1 0;min-width:120px;min-height:38px;border-radius:8px;' +
        'font-size:13px;font-weight:700;padding:0 12px;cursor:pointer;}' +
      '.reorder-reverse{border:1px solid #c7d2fe;background:#eef2ff;color:#3730a3;}' +
      '.reorder-reverse:hover{background:#e0e7ff;}' +
      '.reorder-mapbtn{border:1px solid #bae6fd;background:#f0f9ff;color:#075985;}' +
      '.reorder-mapbtn:hover{background:#e0f2fe;}' +
      '.reorder-mapbtn.is-open{background:#0284c7;border-color:#0284c7;color:#fff;}' +
      // ---- map panel ----
      '.reorder-mapwrap{margin:4px 0 10px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#f8fafc;}' +
      '.reorder-map{height:300px;width:100%;background:#e8eef3;}' +
      '@media (max-width:600px){.reorder-map{height:260px;}}' +
      '.reorder-mapbar{display:flex;align-items:center;justify-content:space-between;gap:8px;' +
        'padding:6px 10px;font-size:12px;color:#475569;border-top:1px solid #e2e8f0;background:#fff;}' +
      '.reorder-mapnote{flex:1 1 auto;min-width:0;color:#b45309;font-weight:600;}' +
      '.reorder-mapbtns{flex:0 0 auto;display:flex;gap:6px;align-items:center;}' +
      '.reorder-mapfit,.reorder-mapfull{flex:0 0 auto;border:1px solid #cbd5e1;background:#fff;color:#334155;' +
        'font-size:12px;font-weight:600;padding:6px 10px;border-radius:6px;cursor:pointer;min-height:32px;}' +
      '.reorder-mapfit:hover,.reorder-mapfull:hover{background:#f1f5f9;}' +
      // ---- full-screen overlay ----
      // A CSS overlay, NOT the Fullscreen API: iOS Safari refuses requestFullscreen on
      // anything but <video>, so the API would silently do nothing on half the devices.
      // position:fixed + inset:0 fills the layout viewport on every engine we ship to.
      '.reorder-mapwrap.is-full{position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;margin:0;' +
        'border:0;border-radius:0;display:flex;flex-direction:column;background:#fff;}' +
      '.reorder-mapwrap.is-full .reorder-map{flex:1 1 auto;height:auto;min-height:0;}' +
      // bar to the TOP in full screen so Close is always reachable (thumb-friendly on mobile)
      '.reorder-mapwrap.is-full .reorder-mapbar{order:-1;border-top:0;border-bottom:1px solid #e2e8f0;' +
        'padding:10px 12px;padding-top:calc(10px + env(safe-area-inset-top,0px));}' +
      '.reorder-mapwrap.is-full .reorder-mapfull{background:#0284c7;border-color:#0284c7;color:#fff;}' +
      'body.reorder-map-open{overflow:hidden;}' +
      // numbered stop markers — mirror the .reorder-pos tile badge so map == list
      '.reorder-pin{background:transparent;border:0;}' +
      '.reorder-pin span{display:flex;align-items:center;justify-content:center;width:26px;height:26px;' +
        'border-radius:50%;background:var(--accent,#2b6cb0);color:#fff;font-weight:700;font-size:13px;' +
        'border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);}' +
      '.reorder-pin--start span{background:var(--success,#2f855a);font-size:14px;}' +
      '.reorder-pin--end span{background:#b91c1c;font-size:14px;}' +
      '.reorder-pop{font-size:13px;line-height:1.45;}' +
      '.reorder-pop b{display:block;margin-bottom:2px;}' +
      // stop numbers pop when the ORDER changes, so a reorder is visibly acknowledged
      '@keyframes reorderPinPop{0%{transform:scale(1);}45%{transform:scale(1.45);}100%{transform:scale(1);}}' +
      '.reorder-map.is-repinned .reorder-pin span{animation:reorderPinPop .36s ease-out;}' +
      // direction arrow along each leg of the route
      '.reorder-arrow{background:transparent;border:0;}' +
      '.reorder-arrow i{display:block;width:0;height:0;border-left:6px solid #0284c7;' +
        'border-top:4.5px solid transparent;border-bottom:4.5px solid transparent;' +
        'filter:drop-shadow(0 0 1px #fff) drop-shadow(0 0 1px #fff);}';
    var el = document.createElement('style');
    el.id = 'reorder-extra-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function buildSkeleton() {
    var view = document.getElementById('reorderView');
    if (!view) return;
    ensureStyles();
    view.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'reorder-head';
    head.innerHTML = '<span class="reorder-poll-dot" id="reorderPollDot"></span>' +
      '<span id="reorderStatus">Drag stops to reorder, then Send Final Route — syncs across devices</span>';
    view.appendChild(head);
    view.appendChild(buildAddPanel());
    SECTIONS.forEach(function (sec) {
      var s = document.createElement('section');
      s.className = 'reorder-section';
      s.setAttribute('data-section', sec.key);
      s.innerHTML =
        '<div class="reorder-section-head">' +
          '<h2 class="reorder-section-title">' + sec.title + '</h2>' +
          '<button type="button" class="reorder-clear-section" data-section="' + sec.key + '" disabled>🗑 Clear route</button>' +
        '</div>' +
        '<div class="reorder-slots" data-section="' + sec.key + '"></div>' +
        '<div class="reorder-empty" data-section="' + sec.key + '">No routes staged</div>';
      view.appendChild(s);
      var clr = s.querySelector('.reorder-clear-section');
      if (clr) clr.addEventListener('click', function () { clearSection(sec.key); });
    });
    view.__built = true;
  }

  // ---- Add Dog panel + staging area ------------------------------
  // A dispatcher types a dog name + address, picks a van + route, and presses
  // "Check address". The dog shows as a STAGED tile that is geocode-validated
  // server-side (green = ready / red = needs attention). A valid tile's "Add to
  // <van>" commits the dog to that slot (appending to an existing staged route,
  // or CREATING a new route if none is staged). The added dog carries its coords
  // to the final send as an extra_stop (sendFinal), so an off-master dog routes.
  function buildAddPanel() {
    var wrap = document.createElement('section');
    wrap.className = 'reorder-add';
    var vanOpts = VAN_ORDER.map(function (v) {
      return '<option value="' + v + '">' + v + '</option>';
    }).join('');
    var secOpts = SECTIONS.map(function (s) {
      return '<option value="' + s.key + '">' + s.title + '</option>';
    }).join('');
    wrap.innerHTML =
      '<div class="reorder-add-head">➕ Add a dog to a route</div>' +
      '<div class="reorder-add-form">' +
        '<input type="text" class="reorder-add-name" placeholder="Dog name" autocomplete="off">' +
        '<input type="text" class="reorder-add-addr" placeholder="Full address incl. postcode" autocomplete="off">' +
        '<select class="reorder-add-van" aria-label="Van">' + vanOpts + '</select>' +
        '<select class="reorder-add-route" aria-label="Route">' + secOpts + '</select>' +
        '<button type="button" class="reorder-add-btn">Check address</button>' +
      '</div>' +
      '<div class="reorder-staging" aria-live="polite"></div>';
    var btn = wrap.querySelector('.reorder-add-btn');
    if (btn) btn.addEventListener('click', function () { stagingAdd(wrap); });
    ['.reorder-add-name', '.reorder-add-addr'].forEach(function (sel) {
      var el = wrap.querySelector(sel);
      if (el) el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); stagingAdd(wrap); }
      });
    });
    return wrap;
  }

  function saveStaging() {
    try { localStorage.setItem(STAGING_LS_KEY, JSON.stringify(staging)); } catch (e) {}
  }
  function loadStaging() {
    try {
      var raw = localStorage.getItem(STAGING_LS_KEY);
      staging = raw ? (JSON.parse(raw) || []) : [];
      if (!Array.isArray(staging)) staging = [];
    } catch (e) { staging = []; }
    // any tile left mid-check from a previous session → mark for a re-check
    staging.forEach(function (it) {
      if (it && it.status === 'checking') { it.status = 'invalid'; it.reason = 'not checked — press Re-check'; }
    });
  }
  function stagingId() { return 'a' + Math.floor(Math.random() * 1e9).toString(36) + Date.now().toString(36); }
  function findStaging(id) {
    for (var i = 0; i < staging.length; i++) if (staging[i].id === id) return staging[i];
    return null;
  }
  function removeStaging(id) {
    staging = staging.filter(function (x) { return x.id !== id; });
    saveStaging(); stagingRender();
  }
  function sectionTitle(key) {
    var t = key;
    SECTIONS.forEach(function (s) { if (s.key === key) t = s.title; });
    return t;
  }

  function stagingAdd(wrap) {
    var nameEl = wrap.querySelector('.reorder-add-name');
    var addrEl = wrap.querySelector('.reorder-add-addr');
    var name = (nameEl.value || '').trim();
    var addr = (addrEl.value || '').trim();
    var van = wrap.querySelector('.reorder-add-van').value;
    var section = wrap.querySelector('.reorder-add-route').value;
    if (!name) { toast('Enter a dog name', 'error'); nameEl.focus(); return; }
    if (!addr) { toast('Enter an address', 'error'); addrEl.focus(); return; }
    var item = {
      id: stagingId(), name: name, address: addr, van: van, section: section,
      status: 'checking', lat: null, lng: null, km: null, reason: ''
    };
    staging.push(item);
    saveStaging();
    stagingRender();
    nameEl.value = ''; addrEl.value = '';   // clear the form for the next dog
    nameEl.focus();
    stagingGeocode(item);
  }

  function stagingGeocode(item) {
    var cur0 = findStaging(item.id);
    if (cur0) { cur0.status = 'checking'; cur0.reason = ''; saveStaging(); stagingRender(); }
    postStore({ action: 'geocodeAddress', token: TOKEN, address: item.address })
      .then(function (r) {
        var cur = findStaging(item.id);
        if (!cur) return;
        if (r && r.ok) {
          cur.status = 'valid'; cur.lat = r.lat; cur.lng = r.lng; cur.km = r.km; cur.reason = '';
        } else {
          cur.status = 'invalid';
          cur.reason = (r && r.message) || 'Address check failed';
          cur.lat = (r && r.lat != null) ? r.lat : null;
          cur.lng = (r && r.lng != null) ? r.lng : null;
        }
        saveStaging(); stagingRender();
      })
      .catch(function () {
        var cur = findStaging(item.id);
        if (!cur) return;
        cur.status = 'invalid'; cur.reason = 'Address check failed — try again';
        saveStaging(); stagingRender();
      });
  }

  function stagingCommit(item) {
    if (!item || item.status !== 'valid') return;
    var d = SECTION_DEFAULTS[item.section] || { p: 'PM', rt: '', t: '' };
    var depart = d.t;
    if (item.section === 'NEXT_AM') depart = NEXT_AM_DEPART[item.van] || d.t;
    var newCtx = { p: d.p, rt: d.rt, t: depart, r: true, s: true, sa: '', ea: '' };
    postStore({
      action: 'addStagedDog', token: TOKEN, section: item.section, van: item.van,
      dog: { name: item.name, address: item.address, lat: item.lat, lng: item.lng },
      added_by: deviceId(), new_ctx: newCtx
    }).then(function (r) {
      if (r && r.ok) {
        removeStaging(item.id);
        // An intentional re-stage to a just-cleared slot must clear its tombstone, else
        // the new card is suppressed for up to CLEAR_TOMBSTONE_MS despite the success toast.
        if (r.slot_key) delete cleared[r.slot_key];
        toast('✓ ' + item.name + ' added to ' + item.van + (r.created ? ' — new route created' : ''), 'success');
        poll();   // refresh the target card immediately
      } else {
        toast((r && r.error) || 'Could not add dog — try again', 'error');
      }
    }).catch(function () { toast('Could not add dog — try again', 'error'); });
  }

  function stagingRender() {
    var host = document.querySelector('.reorder-staging');
    if (!host) return;
    host.innerHTML = '';
    staging.forEach(function (it) {
      var tile = document.createElement('div');
      tile.className = 'reorder-stage-tile reorder-stage--' + it.status;
      var statusHtml, actionsHtml;
      if (it.status === 'checking') {
        statusHtml = '<span class="reorder-stage-status">⏳ checking address…</span>';
        actionsHtml = '<button type="button" class="reorder-stage-x" data-id="' + it.id + '" title="Remove">✕</button>';
      } else if (it.status === 'valid') {
        statusHtml = '<span class="reorder-stage-status">✓ ready' + (it.km != null ? ' · ' + it.km + ' km' : '') + '</span>';
        actionsHtml =
          '<button type="button" class="reorder-stage-add" data-id="' + it.id + '">Add to ' + escapeHtml(it.van) + '</button>' +
          '<button type="button" class="reorder-stage-x" data-id="' + it.id + '" title="Remove">✕</button>';
      } else {
        statusHtml = '<span class="reorder-stage-status">⚠️ ' + escapeHtml(it.reason || 'needs attention') + '</span>';
        actionsHtml =
          '<button type="button" class="reorder-stage-recheck" data-id="' + it.id + '">Re-check</button>' +
          '<button type="button" class="reorder-stage-x" data-id="' + it.id + '" title="Remove">✕</button>';
      }
      tile.innerHTML =
        '<div class="reorder-stage-main">' +
          '<span class="reorder-stage-name">' + escapeHtml(it.name) + '</span>' +
          '<span class="reorder-stage-meta">' + escapeHtml(it.van) + ' · ' + escapeHtml(sectionTitle(it.section)) + '</span>' +
          '<span class="reorder-stage-addr" title="' + escapeHtml(it.address) + '">' + escapeHtml(it.address) + '</span>' +
        '</div>' +
        '<div class="reorder-stage-side">' + statusHtml +
          '<div class="reorder-stage-actions">' + actionsHtml + '</div>' +
        '</div>';
      host.appendChild(tile);
    });
    [].slice.call(host.querySelectorAll('.reorder-stage-add')).forEach(function (b) {
      b.addEventListener('click', function () { var it = findStaging(b.getAttribute('data-id')); if (it) stagingCommit(it); });
    });
    [].slice.call(host.querySelectorAll('.reorder-stage-recheck')).forEach(function (b) {
      b.addEventListener('click', function () { var it = findStaging(b.getAttribute('data-id')); if (it) stagingGeocode(it); });
    });
    [].slice.call(host.querySelectorAll('.reorder-stage-x')).forEach(function (b) {
      b.addEventListener('click', function () { removeStaging(b.getAttribute('data-id')); });
    });
  }

  // ---- "🗺 Check on Map" ------------------------------------------
  // An inline Leaflet panel per card, sitting directly above Send Final Route so
  // staff get a final geographic sanity-check before delivering. It plots the stops
  // in the CURRENT tile order (numbers match the tiles) and re-draws the moment the
  // order changes — a drag, a 🔁 Reverse, a ✕ removal, or a remote edit from another
  // device. Read-only: the map never writes an order.
  //
  // Coordinates come from the staged ctx and are NEVER re-geocoded here:
  //   ctx.c  { <normKey(dog)>: [lat,lng] }  every routed dog (added by Format Route —
  //                                         the exact points RouteXL optimised on)
  //   ctx.ex [{ d, a, lat, lng }]           dogs added via the ➕ Add Dog panel
  //   ctx.sc / ctx.ec                       start / end point ([lat,lng] or null)
  // A route staged BEFORE this feature has no ctx.c — those slots show a "re-stage"
  // prompt rather than a half-empty map.

  // Lazy-load Leaflet once, on the first map open. Resolves with window.L.
  function ensureLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LEAFLET_CSS;
      css.integrity = LEAFLET_CSS_SRI;
      css.crossOrigin = '';
      document.head.appendChild(css);

      var js = document.createElement('script');
      js.src = LEAFLET_JS;
      js.integrity = LEAFLET_JS_SRI;
      js.crossOrigin = '';
      js.async = true;
      js.onload = function () {
        if (window.L) { resolve(window.L); return; }
        leafletPromise = null;   // never cache a rejection — a later tap must be able to retry
        reject(new Error('leaflet loaded but window.L missing'));
      };
      js.onerror = function () {
        leafletPromise = null;   // let a later tap retry (transient CDN blip)
        reject(new Error('leaflet failed to load'));
      };
      document.head.appendChild(js);
    });
    return leafletPromise;
  }

  // { <normKey(dog)>: [lat,lng] } for every dog we can plot on this slot.
  // An added dog (ctx.ex) wins over ctx.c — if a dog was re-added at a corrected
  // address, ex holds the newer coordinate.
  function coordIndexFor(ctx) {
    var idx = {};
    var c = (ctx && ctx.c && typeof ctx.c === 'object' && !Array.isArray(ctx.c)) ? ctx.c : {};
    Object.keys(c).forEach(function (k) {
      var p = c[k];
      if (!Array.isArray(p) || p.length < 2) return;
      var la = Number(p[0]), ln = Number(p[1]);
      if (isFinite(la) && isFinite(ln)) idx[normKey(k)] = [la, ln];
    });
    ((ctx && ctx.ex) || []).forEach(function (e) {
      if (!e) return;
      var la = Number(e.lat), ln = Number(e.lng);
      var k = normKey(e.d);
      if (k && isFinite(la) && isFinite(ln)) idx[k] = [la, ln];
    });
    return idx;
  }

  // A household stop is one tile with several members sharing one address, so the
  // first member that resolves gives the stop's point.
  function stopCoord(members, idx) {
    for (var i = 0; i < (members || []).length; i++) {
      var p = idx[normKey(members[i])];
      if (p) return p;
    }
    return null;
  }

  function ctxPointOr(p, fallback) {
    if (Array.isArray(p) && p.length >= 2 && isFinite(Number(p[0])) && isFinite(Number(p[1]))) {
      return [Number(p[0]), Number(p[1])];
    }
    return fallback || null;
  }

  // Build the plot for a slot from the CURRENT tile order in the DOM.
  function mapPlotFor(st) {
    var ctx = (st.record && st.record.ctx) || {};
    var idx = coordIndexFor(ctx);
    var ol = st.card && st.card.querySelector('.reorder-list');
    var stops = [], missing = [];
    if (ol) {
      currentOrderIds(ol).forEach(function (id, i) {
        var members = st.stopsById[id] || [];
        var pt = stopCoord(members, idx);
        if (pt) stops.push({ n: i + 1, pt: pt, members: members });
        else missing.push(members.join(' & ') || '?');
      });
    }
    // sc/ec absent (slot created by Add Dog, or staged before this feature) →
    // fall back to the Centre where the route params say we start/end there.
    var start = ctxPointOr(ctx.sc, ctx.s !== false ? CENTRE_LATLNG : null);
    var end = ctxPointOr(ctx.ec, ctx.r !== false ? CENTRE_LATLNG : null);
    return { stops: stops, missing: missing, start: start, end: end, plottable: Object.keys(idx).length > 0 };
  }

  function pinIcon(L, label, cls) {
    return L.divIcon({
      className: 'reorder-pin' + (cls ? ' ' + cls : ''),
      html: '<span>' + escapeHtml(label) + '</span>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -14]
    });
  }

  // Fairy Tails routes are a tight cluster of Hastings streets, so several stops land
  // within a pin's width of each other. Drawn at their true points they OVERLAP and the
  // later pin hides the earlier one — a reorder then looks like nothing happened, because
  // the same blob is on top with a different number under it. So: pins that would collide
  // are fanned out around a small circle and tethered to their true point by a leader
  // line. The route LINE still uses the true points, so the geometry is never a lie.
  // Screen distance depends on zoom, so this is recomputed on every zoom (see createMap).
  var PIN_COLLIDE_PX = 32;   // > the 26px pin, so numbers never touch
  var PIN_MAX_SHIFT_PX = 46; // never drag a pin so far it reads as a different street

  function spreadPins(L, map, stops) {
    var truth = stops.map(function (s) { return map.latLngToLayerPoint(L.latLng(s.pt[0], s.pt[1])); });
    var pos = truth.map(function (p) { return p.clone(); });
    var n = stops.length;

    // Exactly-coincident pins have no direction to separate along, so seed them apart
    // deterministically (same input -> same layout, no jitter between redraws).
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        if (pos[i].distanceTo(pos[j]) < 0.5) {
          var a = (2 * Math.PI * j) / n - Math.PI / 2;
          pos[j] = pos[j].add(L.point(Math.cos(a), Math.sin(a)));
        }
      }
    }

    // Relax: push every colliding pair apart, then tug each pin gently back toward its
    // true point. A handful of passes settles ≤22 pins; transitive clusters resolve too
    // (the reason a one-pass grouping left pins 21px apart).
    for (var pass = 0; pass < 24; pass++) {
      var moved = false;
      for (var x = 0; x < n; x++) {
        for (var y = x + 1; y < n; y++) {
          var dx = pos[y].x - pos[x].x, dy = pos[y].y - pos[x].y;
          var d = Math.sqrt(dx * dx + dy * dy) || 0.001;
          if (d >= PIN_COLLIDE_PX) continue;
          var push = (PIN_COLLIDE_PX - d) / 2;
          var ux = dx / d, uy = dy / d;
          pos[x] = pos[x].subtract(L.point(ux * push, uy * push));
          pos[y] = pos[y].add(L.point(ux * push, uy * push));
          moved = true;
        }
      }
      // spring back toward truth, and hard-clamp the displacement
      for (var k = 0; k < n; k++) {
        pos[k] = pos[k].add(truth[k].subtract(pos[k]).multiplyBy(0.06));
        var off = pos[k].subtract(truth[k]);
        var len = Math.sqrt(off.x * off.x + off.y * off.y);
        if (len > PIN_MAX_SHIFT_PX) pos[k] = truth[k].add(off.multiplyBy(PIN_MAX_SHIFT_PX / len));
      }
      if (!moved) break;
    }

    return stops.map(function (s, idx) {
      var shifted = pos[idx].distanceTo(truth[idx]) > 3;
      var ll = map.layerPointToLatLng(pos[idx]);
      return { pin: shifted ? [ll.lat, ll.lng] : s.pt, tether: shifted ? s.pt : null };
    });
  }

  // A small arrowhead at the midpoint of each leg, rotated to the direction of travel —
  // without it a dotted line between numbered pins doesn't say which way the van goes.
  function addArrows(L, map, layer, line) {
    for (var i = 0; i < line.length - 1; i++) {
      var a = map.latLngToLayerPoint(L.latLng(line[i][0], line[i][1]));
      var b = map.latLngToLayerPoint(L.latLng(line[i + 1][0], line[i + 1][1]));
      if (a.distanceTo(b) < 34) continue;           // leg too short to hold an arrow
      var mid = map.layerPointToLatLng(L.point((a.x + b.x) / 2, (a.y + b.y) / 2));
      var deg = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      L.marker(mid, {
        interactive: false,
        keyboard: false,
        zIndexOffset: -200,
        icon: L.divIcon({
          className: 'reorder-arrow',
          html: '<i style="transform:rotate(' + deg.toFixed(1) + 'deg)"></i>',
          iconSize: [10, 10],
          iconAnchor: [5, 5]
        })
      }).addTo(layer);
    }
  }

  // Popup: stop number + dog name(s) + a direct navigation link to that exact point.
  // encodeURIComponent is CORRECT here — the Telegram-iOS "+ not %20" rule applies to
  // links sent THROUGH Telegram, not to a link opened from a browser page. Coordinates
  // carry no characters needing encoding anyway.
  function popupHtml(n, members, pt) {
    var url = 'https://www.google.com/maps/dir/?api=1&destination=' +
      encodeURIComponent(pt[0] + ',' + pt[1]) + '&dir_action=navigate';
    return '<div class="reorder-pop"><b>' + n + '. ' + escapeHtml(members.join(' & ') || '—') + '</b>' +
      '<a href="' + url + '" target="_blank" rel="noopener noreferrer">Open in Google Maps</a></div>';
  }

  function fitMap(st) {
    if (!st.map || !st.mapBounds || !st.mapBounds.isValid()) return;
    st.map.fitBounds(st.mapBounds, { padding: [26, 26], maxZoom: 15 });
  }

  // ---- full screen ------------------------------------------------
  // The panel is deliberately small so it sits inline with the stops, but a driver
  // checking a 15-stop route wants the whole screen. "⛶ Full screen" blows the SAME
  // map up to fill the viewport (no second map, no reload — just a resize), on desktop
  // and mobile alike. Escape or "✕ Close" returns it to the card.
  //
  // Implemented as a CSS overlay rather than the Fullscreen API on purpose: iOS Safari
  // only grants requestFullscreen() to <video>, so the API is a silent no-op on iPhones
  // and iPads — which is most of the staff. position:fixed + inset:0 works everywhere.
  var fullscreenSlot = null;   // at most one map is full screen at a time

  function setFullscreen(st, on) {
    if (!st || !st.card) return;
    var wrap = st.card.querySelector('.reorder-mapwrap');
    var btn = st.card.querySelector('.reorder-mapfull');
    if (!wrap) return;
    if (on) {
      wrap.classList.add('is-full');
      document.body.classList.add('reorder-map-open');   // stop the page scrolling behind
      if (btn) { btn.textContent = '✕ Close'; btn.title = 'Back to the route card'; }
      fullscreenSlot = st.record.slot_key;
    } else {
      wrap.classList.remove('is-full');
      document.body.classList.remove('reorder-map-open');
      if (btn) { btn.textContent = '⛶ Full screen'; btn.title = 'Fill the screen'; }
      if (fullscreenSlot === (st.record && st.record.slot_key)) fullscreenSlot = null;
    }
    // The container just changed size — Leaflet must re-measure, then re-frame the route.
    // Two ticks: one after the class applies, one after layout/scroll settles (iOS).
    var refit = function () { try { if (st.map) { st.map.invalidateSize(); fitMap(st); } } catch (e) {} };
    setTimeout(refit, 0);
    setTimeout(refit, 250);
  }

  function toggleFullscreen(slotKey) {
    var st = slots[slotKey];
    if (!st || !st.mapOpen || !st.map) return;
    var wrap = st.card.querySelector('.reorder-mapwrap');
    setFullscreen(st, !(wrap && wrap.classList.contains('is-full')));
  }

  function exitFullscreenFor(st) {
    if (st && st.record && fullscreenSlot === st.record.slot_key) setFullscreen(st, false);
  }

  // Escape always gets you out — a full-screen map with no visible way back is a trap.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !fullscreenSlot) return;
    var st = slots[fullscreenSlot];
    if (st) setFullscreen(st, false);
    else { document.body.classList.remove('reorder-map-open'); fullscreenSlot = null; }
  });

  // Redraw the markers + order line. Cheap (a few dozen layers) so it can run on
  // every order change. ALWAYS guarded: a map error must never break a drag or a send.
  function syncMap(st) {
    try {
      if (!st || !st.mapOpen || !st.map || !window.L) return;
      var L = window.L;
      var plot = mapPlotFor(st);
      if (st.mapLayer) st.mapLayer.clearLayers();
      else st.mapLayer = L.layerGroup().addTo(st.map);

      // The route line always follows the TRUE stop coordinates (pins may be fanned out).
      var line = [];
      if (plot.start) line.push(plot.start);
      plot.stops.forEach(function (s) { line.push(s.pt); });
      if (plot.end) line.push(plot.end);

      if (line.length > 1) {
        L.polyline(line, { color: '#0284c7', weight: 3, opacity: 0.75, dashArray: '1 6', lineCap: 'round' })
          .addTo(st.mapLayer);
        addArrows(L, st.map, st.mapLayer, line);
      }

      // Fan out any pins that would sit on top of each other, and tether them home.
      var placed = spreadPins(L, st.map, plot.stops);
      placed.forEach(function (p, i) {
        if (!p.tether) return;
        L.polyline([p.tether, p.pin], { color: '#64748b', weight: 1, opacity: 0.6, interactive: false })
          .addTo(st.mapLayer);
      });

      if (plot.start) {
        L.marker(plot.start, { icon: pinIcon(L, '🏠', 'reorder-pin--start'), zIndexOffset: -100 })
          .bindPopup('<div class="reorder-pop"><b>Start</b></div>').addTo(st.mapLayer);
      }
      plot.stops.forEach(function (s, i) {
        // EARLIER stops paint on top: if anything still overlaps, you want to see stop 1.
        L.marker(placed[i].pin, { icon: pinIcon(L, String(s.n)), zIndexOffset: 1000 - s.n })
          .bindPopup(popupHtml(s.n, s.members, s.pt)).addTo(st.mapLayer);
      });
      if (plot.end) {
        // A return-to-Centre route ends where it started; don't stack a 2nd pin there.
        var sameAsStart = plot.start && plot.end[0] === plot.start[0] && plot.end[1] === plot.start[1];
        if (!sameAsStart) {
          L.marker(plot.end, { icon: pinIcon(L, '🏁', 'reorder-pin--end'), zIndexOffset: -100 })
            .bindPopup('<div class="reorder-pop"><b>End</b></div>').addTo(st.mapLayer);
        }
      }
      st.mapBounds = line.length ? L.latLngBounds(line) : null;

      // Pop the numbers when the ORDER actually changed (not on a pan/zoom redraw), so a
      // drag/Reverse is visibly acknowledged even when two stops share a street corner.
      var orderKey = plot.stops.map(function (s) { return s.members.join('+'); }).join('>');
      if (st.mapOrderKey !== undefined && st.mapOrderKey !== orderKey) {
        var el = st.card.querySelector('.reorder-map');
        if (el) {
          el.classList.remove('is-repinned');
          void el.offsetWidth;                 // restart the CSS animation
          el.classList.add('is-repinned');
          setTimeout(function () { el.classList.remove('is-repinned'); }, 500);
        }
      }
      st.mapOrderKey = orderKey;

      var note = st.card.querySelector('.reorder-mapnote');
      if (note) {
        if (plot.missing.length) {
          note.textContent = '⚠️ ' + plot.missing.length + ' stop' + (plot.missing.length > 1 ? 's' : '') +
            ' not on the map (' + plot.missing.join(', ') + ') — re-stage to plot';
        } else {
          note.textContent = plot.stops.length + ' stop' + (plot.stops.length === 1 ? '' : 's') +
            ' in the order shown above';
        }
      }
    } catch (e) { /* never let the map break the tab */ }
  }

  function openMap(st) {
    var wrap = st.card.querySelector('.reorder-mapwrap');
    var btn = st.card.querySelector('.reorder-mapbtn');
    var ctx = (st.record && st.record.ctx) || {};
    // Nothing to plot at all → say so instead of showing an empty grey box.
    if (!Object.keys(coordIndexFor(ctx)).length) {
      toast('No map data — re-stage this route from the Load Plan', 'info');
      return;
    }
    ensureLeaflet().then(function (L) {
      // Identity, not presence: while Leaflet was fetching (only the first open is
      // truly async), a poll may have cleared this slot AND a re-stage rebuilt a NEW
      // st under the same key. Building a map on the old, DOM-detached card would
      // leak a Leaflet instance that destroyMap can never reach.
      if (slots[st.record.slot_key] !== st) return;
      st.mapOpen = true;
      wrap.hidden = false;
      if (btn) { btn.classList.add('is-open'); btn.textContent = '🗺 Hide map'; }
      if (!st.map) {
        st.map = L.map(st.card.querySelector('.reorder-map'), {
          scrollWheelZoom: false,          // don't hijack page scroll
          zoomControl: true,
          attributionControl: true
        }).setView(CENTRE_LATLNG, 12);
        L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(st.map);
        // Pin fan-out and arrow placement are computed in SCREEN space, so they must be
        // rebuilt whenever the zoom changes (zoom in far enough and nothing collides).
        st.map.on('zoomend', function () { syncMap(st); });
      }
      syncMap(st);
      // The container was display:none until now, so Leaflet measured 0×0.
      setTimeout(function () {
        if (!st.map || !st.mapOpen) return;
        st.map.invalidateSize();
        fitMap(st);
      }, 0);
    }).catch(function () {
      toast('Could not load the map — check the connection and try again', 'error');
    });
  }

  function closeMap(st) {
    exitFullscreenFor(st);           // never leave a full-screen overlay on a hidden map
    st.mapOpen = false;
    var wrap = st.card && st.card.querySelector('.reorder-mapwrap');
    var btn = st.card && st.card.querySelector('.reorder-mapbtn');
    if (wrap) wrap.hidden = true;
    if (btn) { btn.classList.remove('is-open'); btn.textContent = '🗺 Check on Map'; }
  }

  function toggleMap(slotKey) {
    var st = slots[slotKey];
    if (!st || !st.card) return;
    if (st.mapOpen) closeMap(st); else openMap(st);
  }

  function destroyMap(st) {
    // A card can vanish under a full-screen map (cleared or re-staged on another device).
    // Drop the overlay + body scroll-lock BEFORE the DOM goes, or the page is left frozen.
    exitFullscreenFor(st);
    try {
      if (st && st.map) { st.map.remove(); }
    } catch (e) {}
    if (st) { st.map = null; st.mapLayer = null; st.mapBounds = null; st.mapOpen = false; }
  }

  // "🔁 Reverse": flip the staged stop order in one tap, then persist through the
  // SAME saveOrder plumbing as a drag. The final send uses skip_optimisation:true,
  // so the reversed staff order is exactly what RouteXL returns (with ETAs) and
  // delivers. A single-stop route has nothing to reverse.
  function reverseRoute(slotKey) {
    var st = slots[slotKey];
    if (!st || st.dragging) return;
    var ol = st.card && st.card.querySelector('.reorder-list');
    if (!ol) return;
    var tiles = [].slice.call(ol.querySelectorAll('.reorder-tile'));
    if (tiles.length < 2) { toast('Nothing to reverse (single stop)', 'info'); return; }
    tiles.reverse().forEach(function (li) { ol.appendChild(li); });
    renumber(ol);
    syncMap(st);            // map follows the reversed order immediately
    scheduleSave(st);
    toast('Route reversed', 'info');
  }

  // Day+date stamp ("MON 28/06") for a card. Prefer the server-computed ctx.dt
  // (set by Format Route at stage time, so it matches the Telegram message exactly);
  // fall back to computing from staged_at + section for routes staged before this
  // feature (today for PM/Half-Day, the next day for NEXT_AM). Europe/London.
  function dayStampFor(rec) {
    if (rec && rec.ctx && rec.ctx.dt) return String(rec.ctx.dt);
    try {
      var d = (rec && rec.staged_at) ? new Date(rec.staged_at) : new Date();
      if (isNaN(d.getTime())) d = new Date();
      if (rec && rec.section === 'NEXT_AM') d = new Date(d.getTime() + 86400000);
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London', weekday: 'short', day: '2-digit', month: '2-digit'
      }).formatToParts(d);
      var wd = '', dd = '', mm = '';
      parts.forEach(function (p) {
        if (p.type === 'weekday') wd = p.value;
        else if (p.type === 'day') dd = p.value;
        else if (p.type === 'month') mm = p.value;
      });
      if (!wd || !dd || !mm) return '';
      return wd.slice(0, 3).toUpperCase() + ' ' + dd + '/' + mm;
    } catch (e) { return ''; }
  }

  function buildCard(rec) {
    var card = document.createElement('div');
    card.className = 'reorder-slot';
    card.setAttribute('data-slot', rec.slot_key);
    var vanCls = 'van-badge--' + String(rec.van).toLowerCase();
    card.innerHTML =
      '<div class="reorder-slot-head">' +
        '<span class="van-badge ' + vanCls + '">' + escapeHtml(rec.van) + '</span>' +
        '<span class="reorder-day" hidden></span>' +
        '<span class="reorder-staged-at"></span>' +
        '<span class="reorder-updated-flag" hidden>updated</span>' +
        '<span class="reorder-sent-flag" hidden></span>' +
        '<span class="reorder-skip" hidden></span>' +
      '</div>' +
      '<ol class="reorder-list"></ol>' +
      '<div class="reorder-mapwrap" hidden>' +
        '<div class="reorder-map"></div>' +
        '<div class="reorder-mapbar">' +
          '<span class="reorder-mapnote"></span>' +
          '<span class="reorder-mapbtns">' +
            '<button type="button" class="reorder-mapfit" title="Zoom to fit the whole route">⤢ Fit</button>' +
            '<button type="button" class="reorder-mapfull" title="Fill the screen">⛶ Full screen</button>' +
          '</span>' +
        '</div>' +
      '</div>' +
      '<div class="reorder-slot-foot">' +
        '<button type="button" class="reorder-mapbtn" title="See this route on a map">🗺 Check on Map</button>' +
        '<button type="button" class="reorder-reverse" title="Reverse the stop order">🔁 Reverse</button>' +
        '<button type="button" class="send-route-btn reorder-send">' +
          '<span class="send-route-btn__label">📍 Send Final Route</span></button>' +
      '</div>';
    card.querySelector('.reorder-send').addEventListener('click', function () { sendFinal(rec.slot_key); });
    var rev = card.querySelector('.reorder-reverse');
    if (rev) rev.addEventListener('click', function () { reverseRoute(rec.slot_key); });
    var mapBtn = card.querySelector('.reorder-mapbtn');
    if (mapBtn) mapBtn.addEventListener('click', function () { toggleMap(rec.slot_key); });
    var fitBtn = card.querySelector('.reorder-mapfit');
    if (fitBtn) fitBtn.addEventListener('click', function () {
      var st = slots[rec.slot_key];
      if (st) { try { st.map && st.map.invalidateSize(); fitMap(st); } catch (e) {} }
    });
    var fullBtn = card.querySelector('.reorder-mapfull');
    if (fullBtn) fullBtn.addEventListener('click', function () { toggleFullscreen(rec.slot_key); });
    return card;
  }

  function updateCardMeta(card, rec) {
    var day = card.querySelector('.reorder-day');
    if (day) {
      var stamp = dayStampFor(rec);
      day.textContent = stamp;
      day.hidden = !stamp;
    }
    var at = card.querySelector('.reorder-staged-at');
    if (at) at.textContent = 'staged ' + fmtTime(rec.staged_at) + (rec.last_reordered_by ? ' · edited' : '');
    var skip = card.querySelector('.reorder-skip');
    if (skip) {
      if (rec.skipped && rec.skipped.length) {
        skip.hidden = false;
        skip.textContent = '⚠️ ' + rec.skipped.length + ' not staged: ' +
          rec.skipped.map(function (s) {
            var nm = (s && (s.dog || s.name)) || '?';
            var why = skipReasonLabel(s);
            return why ? (nm + ' (' + why + ')') : nm;
          }).join(', ');
      } else { skip.hidden = true; skip.textContent = ''; }
    }
  }

  function flashUpdated(card) {
    var f = card.querySelector('.reorder-updated-flag');
    if (!f) return;
    f.hidden = false;
    setTimeout(function () { f.hidden = true; }, 2200);
  }

  function renderTiles(st, rec) {
    var ol = st.card.querySelector('.reorder-list');
    if (!ol) return;
    ol.innerHTML = '';
    var ctx = rec.ctx || {};
    var o = ctx.o || [];
    var gg = normSet(ctx.gg || []);
    var aa = normSet(ctx.aa || []);
    var solo = o.length < 2;
    st.stopsById = {};
    o.forEach(function (members, i) {
      members = members || [];
      var id = 's' + i;
      st.stopsById[id] = members;
      var isGroom = members.some(function (m) { return gg[normNm(m)]; });
      var isAlt = members.some(function (m) { return aa[normNm(m)]; });
      var marks = (isGroom ? '✂️' : '') + (isAlt ? '📍' : '');
      var li = document.createElement('li');
      li.className = 'reorder-tile' + (solo ? ' reorder-tile--solo' : '');
      li.setAttribute('data-stop-id', id);
      li.innerHTML =
        '<span class="reorder-pos">' + (i + 1) + '</span>' +
        (solo ? '' : '<span class="reorder-grip" aria-hidden="true">⠿</span>') +
        '<span class="reorder-name"></span>' +
        '<span class="reorder-marks">' + marks + '</span>' +
        '<button type="button" class="reorder-del" title="Remove from route" aria-label="Remove from route">✕</button>';
      var nameEl = li.querySelector('.reorder-name');
      nameEl.textContent = members.join(' & ') || '—';
      nameEl.title = members.join(' & ');
      // ✕ removes this stop. Drag only ever starts on the .reorder-grip handle, so a
      // plain click here can't begin a drag (no pointerdown on the tile body).
      var delBtn = li.querySelector('.reorder-del');
      if (delBtn) delBtn.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        removeStop(st, id);
      });
      ol.appendChild(li);
      if (!solo) wireGrip(st, li.querySelector('.reorder-grip'));
    });
    // Tiles were rebuilt (fresh stage, a remote reorder, or a failed-save rollback)
    // — an open map must follow. No-op when the map is closed.
    syncMap(st);
  }

  function currentOrderIds(ol) {
    return [].slice.call(ol.querySelectorAll('.reorder-tile')).map(function (li) {
      return li.getAttribute('data-stop-id');
    });
  }
  function renumber(ol) {
    [].slice.call(ol.querySelectorAll('.reorder-tile')).forEach(function (li, i) {
      var pos = li.querySelector('.reorder-pos');
      if (pos) pos.textContent = i + 1;
    });
  }

  // ---- vertical grip-drag engine (pointer events) ---------------
  function wireGrip(st, grip) {
    if (!grip) return;
    grip.addEventListener('pointerdown', function (e) { startDrag(st, grip, e); });
  }

  function tileAfterPointer(ol, y) {
    var tiles = [].slice.call(ol.querySelectorAll('.reorder-tile'));
    for (var i = 0; i < tiles.length; i++) {
      var r = tiles[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return tiles[i];
    }
    return null; // append at end
  }
  function autoScroll(y) {
    var edge = 90;
    if (y < edge) window.scrollBy(0, -14);
    else if (y > window.innerHeight - edge) window.scrollBy(0, 14);
  }

  function startDrag(st, grip, e) {
    if (drag) return;
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    var li = grip.closest('.reorder-tile');
    var ol = st.card.querySelector('.reorder-list');
    if (!li || !ol) return;

    st.dragging = true;
    st.preDragOrder = currentOrderIds(ol);

    var rect = li.getBoundingClientRect();
    var clone = li.cloneNode(true);
    clone.classList.add('is-dragging');
    clone.style.position = 'fixed';
    clone.style.margin = '0';
    clone.style.width = rect.width + 'px';
    clone.style.left = rect.left + 'px';
    clone.style.top = rect.top + 'px';
    document.body.appendChild(clone);

    var placeholder = document.createElement('li');
    placeholder.className = 'reorder-placeholder';
    placeholder.style.height = rect.height + 'px';
    ol.insertBefore(placeholder, li);
    ol.removeChild(li);

    drag = {
      st: st, ol: ol, li: li, clone: clone, placeholder: placeholder,
      offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top
    };
    document.addEventListener('pointermove', onDragMove, true);
    document.addEventListener('pointerup', onDragEnd, true);
    document.addEventListener('pointercancel', onDragEnd, true);
  }

  function onDragMove(e) {
    if (!drag) return;
    e.preventDefault();
    drag.clone.style.left = (e.clientX - drag.offsetX) + 'px';
    drag.clone.style.top = (e.clientY - drag.offsetY) + 'px';
    var ref = tileAfterPointer(drag.ol, e.clientY);
    drag.ol.insertBefore(drag.placeholder, ref);
    autoScroll(e.clientY);
  }

  function onDragEnd() {
    if (!drag) return;
    document.removeEventListener('pointermove', onDragMove, true);
    document.removeEventListener('pointerup', onDragEnd, true);
    document.removeEventListener('pointercancel', onDragEnd, true);
    var d = drag; drag = null;
    d.ol.insertBefore(d.li, d.placeholder);
    if (d.placeholder.parentNode) d.placeholder.parentNode.removeChild(d.placeholder);
    if (d.clone.parentNode) d.clone.parentNode.removeChild(d.clone);
    renumber(d.ol);
    var st = d.st;
    st.dragging = false;
    if (st.staleRemove) {
      removeCard(st);
      toast('That route was cleared elsewhere', 'info');
      return;
    }
    syncMap(st);            // map follows the dropped order immediately
    scheduleSave(st);
  }

  // ---- save (debounced, optimistic, rollback) -------------------
  function scheduleSave(st) {
    st.pendingSave = true;
    var sf = st.card && st.card.querySelector('.reorder-sent-flag');
    if (sf) sf.hidden = true;          // route changed since the last send → drop the "sent" flag
    if (st.saveTimer) clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(function () { doSave(st); }, SAVE_DEBOUNCE_MS);
  }
  function doSave(st) {
    var ol = st.card.querySelector('.reorder-list');
    var ids = currentOrderIds(ol);
    var o = ids.map(function (id) { return st.stopsById[id]; });
    postStore({ action: 'saveOrder', token: TOKEN, slot_key: st.record.slot_key, o: o, last_reordered_by: deviceId() })
      .then(function (r) {
        st.pendingSave = false;
        if (r && r.ok) {
          st.record.ctx.o = o;
          if (r.rev != null) st.renderedRev = r.rev;
        } else {
          rollback(st);
          toast('Could not save order — reverted', 'error');
        }
      })
      .catch(function () { st.pendingSave = false; rollback(st); toast('Could not save order — reverted', 'error'); });
  }
  function rollback(st) {
    renderTiles(st, st.record);       // record.ctx.o is the last known-good order
    st.renderedRev = st.record.rev;
  }

  // ---- remove a stop / clear a slot / clear a whole section -----
  // ✕ on a tile: drop that stop. If it was the LAST stop the route is empty, so
  // the whole slot is cleared (card removed); otherwise the reduced order is
  // persisted through the SAME saveOrder plumbing as a drag (optimistic + rollback).
  function removeStop(st, stopId) {
    if (!st || st.dragging) return;
    var ol = st.card && st.card.querySelector('.reorder-list');
    if (!ol) return;
    var remaining = currentOrderIds(ol).filter(function (x) { return x !== stopId; });
    if (!remaining.length) {
      // last dog → removing it empties the route, so the whole slot is cleared.
      if (!window.confirm('Remove the last dog? This clears the whole route from this section.')) return;
      clearOneSlot(st, 'route cleared');
      return;
    }
    var li = ol.querySelector('.reorder-tile[data-stop-id="' + stopId + '"]');
    if (li) ol.removeChild(li);
    renumber(ol);
    syncMap(st);                      // map drops the removed stop immediately
    scheduleSave(st);                 // saves the shortened ctx.o; server keeps the slot STAGED
  }

  // Clear one slot server-side (status CLEARED) and drop its card on confirmed ok.
  function clearOneSlot(st, reason) {
    if (!st || !st.record) return;
    var slotKey = st.record.slot_key;
    st.pendingSave = true;            // keep the poll/reconcile off this slot mid-clear
    if (st.saveTimer) { clearTimeout(st.saveTimer); st.saveTimer = null; }
    postStore({ action: 'clearSlot', token: TOKEN, slot_key: slotKey })
      .then(function (r) {
        if (r && r.ok) {
          removeCard(st);
          toast(vanFromKey(slotKey) + ' ' + (reason || 'route cleared'), 'info');
        } else { st.pendingSave = false; toast('Could not clear route — try again', 'error'); }
      })
      .catch(function () { st.pendingSave = false; toast('Could not clear route — try again', 'error'); });
  }

  // "Clear route" (per section): clear EVERY staged slot in that section only.
  function clearSection(sectionKey) {
    var keys = Object.keys(slots).filter(function (k) {
      return slots[k] && slots[k].record && slots[k].record.section === sectionKey;
    });
    if (!keys.length) { toast('No staged routes in this section', 'info'); return; }
    var label = sectionKey;
    SECTIONS.forEach(function (s) { if (s.key === sectionKey) label = s.title; });
    if (!window.confirm('Clear all staged routes in "' + label +
        '"? They will be removed from the Reorder Routes tab.')) return;
    keys.forEach(function (k) { if (slots[k]) clearOneSlot(slots[k], 'route cleared'); });
  }

  // Show a persistent "✅ sent HH:MM" flag on the card after a successful send.
  function markCardSent(st) {
    if (!st || !st.card) return;
    var f = st.card.querySelector('.reorder-sent-flag');
    if (!f) return;
    f.textContent = '✅ sent ' + fmtTime(new Date().toISOString());
    f.hidden = false;
  }

  // ---- send final route -----------------------------------------
  function flattenWithMarkers(o, gg, aa) {
    var ggS = normSet(gg), aaS = normSet(aa);
    var dogs = [];
    (o || []).forEach(function (stop) {
      (stop || []).forEach(function (name) {
        var out = String(name);
        var k = normNm(name);
        if (ggS[k]) out += ' G.D.';   // append G.D. then ALT — Stage 2 strips ALT then G.D.
        if (aaS[k]) out += ' ALT';
        dogs.push(out);
      });
    });
    return dogs;
  }

  function setBtn(btn, s) {
    if (!btn) return;
    btn.classList.remove('is-sending', 'is-success', 'is-failed');
    var lbl = btn.querySelector('.send-route-btn__label') || btn;
    if (s === 'sending') { btn.disabled = true; btn.classList.add('is-sending'); lbl.textContent = '⏳ Sending…'; }
    else if (s === 'success') { btn.disabled = true; btn.classList.add('is-success'); lbl.textContent = '✅ Sent'; }
    else if (s === 'failed') { btn.disabled = false; btn.classList.add('is-failed'); lbl.textContent = '⚠️ Failed — retry'; }
    else { btn.disabled = false; lbl.textContent = '📍 Send Final Route'; }
  }

  function sendFinal(slotKey) {
    var st = slots[slotKey];
    if (!st) return;
    var btn = st.card.querySelector('.reorder-send');
    if (!btn || btn.disabled) return;
    var ctx = st.record.ctx || {};
    var ol = st.card.querySelector('.reorder-list');
    var o = currentOrderIds(ol).map(function (id) { return st.stopsById[id]; });
    var dogs = flattenWithMarkers(o, ctx.gg || [], ctx.aa || []);
    if (!dogs.length) { toast('Nothing to send', 'error'); return; }

    // EXACTLY the normal first-send payload + skip_optimisation:true so RouteXL
    // returns the staff order WITH ETAs and Format Route renders the byte-identical
    // "🚐 … route ready" message. NO is_reorder / is_update / stage_only.
    var payload = {
      van: ctx.v,
      period: ctx.p,
      run_type: ctx.rt || '',
      departure_time: ctx.t || '',
      start_from_centre: ctx.s !== false,
      start_address: ctx.sa || '',
      return_to_centre: ctx.r !== false,
      end_address: ctx.ea || '',
      return_trip: ctx.r !== false,
      dogs: dogs,
      // Carry the staged day+date stamp so the Telegram message shows the SAME stamp
      // as the tab (Format Route whitelists + reuses it; empty → it computes its own).
      run_stamp: ctx.dt || '',
      // Carry the staged kennel positions (ROUTE_CTX.kp, { <normName(dog)>: <code> })
      // so the delivered message shows each dog's 📦 van spot — the final send is a
      // fresh webhook POST, so without this the positions never reach Format Route.
      positions: ctx.kp || {},
      skip_optimisation: true,
      timestamp: new Date().toISOString()
    };

    // Dogs ADDED via the "Add Dog" panel are off the Master sheet, so they carry
    // their geocoded coords as extra_stops → Stage 2 routes them via the
    // _pre_resolved bypass WITHOUT is_update (the header stays "route ready").
    // Filter ctx.ex to dogs still on the route (a removed added-dog leaves its ex
    // entry behind but must NOT be re-injected).
    var present = {};
    dogs.forEach(function (nm) { present[normNm(nm)] = true; });
    var extra = (ctx.ex || []).filter(function (e) {
      return e && e.lat != null && e.lng != null && present[normNm(e.d)];
    }).map(function (e) {
      return { dog: e.d, address: e.a, lat: Number(e.lat), lng: Number(e.lng) };
    });
    if (extra.length) payload.extra_stops = extra;

    setBtn(btn, 'sending');
    postN8n(payload).then(function (res) {
      return res.json().catch(function () { return {}; });
    }).then(function (body) {
      if (!body || body.ok !== true) throw new Error((body && body.error) || 'route not ok');
      // SENT to Telegram. The route deliberately STAYS in the Reorder Routes tab —
      // it is NOT cleared/removed — so staff can keep reordering and re-send it until
      // end of operations. A slot only leaves when a fresh route is staged to that
      // same slot (overwrite) or someone manually presses ✕ / Clear route.
      setBtn(btn, 'success');
      markCardSent(st);
      toast('✅ ' + ctx.v + ' route sent to Telegram — it stays here so you can reorder & resend', 'success');
      setTimeout(function () { if (slots[slotKey]) setBtn(btn, 'idle'); }, SENT_RESET_MS);
    }).catch(function () {
      setBtn(btn, 'failed');
      setTimeout(function () { setBtn(btn, 'idle'); }, 4000);
      toast('Send failed — route kept, retry', 'error');
    });
  }

  // ---- reconcile (poll) -----------------------------------------
  function removeCard(st) {
    if (st.record) cleared[st.record.slot_key] = Date.now();   // tombstone: block a stale in-flight poll re-adding this card
    destroyMap(st);                                            // release the Leaflet instance with its card
    if (st.card && st.card.parentNode) st.card.parentNode.removeChild(st.card);
    if (st.record) delete slots[st.record.slot_key];
    refreshEmptyStates();
  }
  function refreshEmptyStates() {
    SECTIONS.forEach(function (sec) {
      var mount = document.querySelector('.reorder-slots[data-section="' + sec.key + '"]');
      var empty = document.querySelector('.reorder-empty[data-section="' + sec.key + '"]');
      var has = !!(mount && mount.children.length);
      if (mount && empty) empty.style.display = has ? 'none' : '';
      var clr = document.querySelector('.reorder-clear-section[data-section="' + sec.key + '"]');
      if (clr) clr.disabled = !has;   // Clear route only active when the section has routes
    });
  }
  function vanFromKey(key) { var p = String(key).split('__'); return p[1] || key; }

  function reconcile(incoming) {
    var bySection = {};
    SECTIONS.forEach(function (s) { bySection[s.key] = []; });
    var keys = {};
    (incoming || []).forEach(function (rec) {
      if (!rec || !rec.slot_key) return;
      keys[rec.slot_key] = rec;
      if (bySection[rec.section]) bySection[rec.section].push(rec);
    });

    // remove cards whose slot vanished (cleared/sent elsewhere)
    Object.keys(slots).forEach(function (key) {
      if (keys[key]) return;
      var st = slots[key];
      if (st.dragging || st.pendingSave) { st.staleRemove = true; return; }
      destroyMap(st);
      if (st.card && st.card.parentNode) st.card.parentNode.removeChild(st.card);
      delete slots[key];
      toast(vanFromKey(key) + ' route cleared', 'info');
    });

    // upsert per section in van order
    SECTIONS.forEach(function (sec) {
      var mount = document.querySelector('.reorder-slots[data-section="' + sec.key + '"]');
      if (!mount) return;
      bySection[sec.key].sort(function (a, b) {
        return VAN_ORDER.indexOf(a.van) - VAN_ORDER.indexOf(b.van);
      }).forEach(function (rec) {
        var st = slots[rec.slot_key];
        if (!st) {
          // Suppress a card re-appearing from a poll whose GET was in flight when we
          // just cleared this slot (✕-last / Clear route). A CLEARED slot is never
          // returned by loadStaged, so this only guards that brief race; it expires
          // after a few seconds, after which a genuine (re-staged) slot re-creates.
          var tomb = cleared[rec.slot_key];
          if (tomb && (Date.now() - tomb < CLEAR_TOMBSTONE_MS)) return;
          if (tomb) delete cleared[rec.slot_key];
          st = slots[rec.slot_key] = {
            record: rec, card: null, stopsById: {}, renderedRev: null,
            dragging: false, pendingSave: false, saveTimer: null, staleRemove: false,
            map: null, mapLayer: null, mapBounds: null, mapOpen: false
          };
          st.card = buildCard(rec);
          mount.appendChild(st.card);
          renderTiles(st, rec);
          updateCardMeta(st.card, rec);
          st.renderedRev = rec.rev;
        } else if (!st.dragging && !st.pendingSave) {
          // safe to refresh from server
          st.record = rec;
          if (st.card.parentNode !== mount) mount.appendChild(st.card);
          if (String(rec.rev) !== String(st.renderedRev)) {
            renderTiles(st, rec);
            st.renderedRev = rec.rev;
            flashUpdated(st.card);
            var sf2 = st.card.querySelector('.reorder-sent-flag');
            if (sf2) sf2.hidden = true;   // remote change (reorder / fresh stage) → no longer the sent route
          }
          updateCardMeta(st.card, rec);
        }
        // else: user is mid-drag/mid-save on this slot — leave DOM + record untouched
      });
    });

    refreshEmptyStates();
  }

  // ---- polling ---------------------------------------------------
  function setPollDot(ok) {
    var dot = document.getElementById('reorderPollDot');
    if (!dot) return;
    if (ok) { pollFails = 0; dot.classList.remove('is-bad'); dot.classList.add('is-ok'); }
    else { pollFails++; if (pollFails >= 2) { dot.classList.remove('is-ok'); dot.classList.add('is-bad'); } }
  }
  function poll() {
    getStaged().then(function (r) {
      setPollDot(true);
      if (r && r.ok) reconcile(r.slots || []);
    }).catch(function () { setPollDot(false); });
  }

  // ---- enter / exit (called by the tab switcher) ----------------
  function enter() {
    active = true;
    var view = document.getElementById('reorderView');
    if (!view) return;
    if (!view.__built) { buildSkeleton(); loadStaging(); }
    stagingRender();   // re-render any pending "Add Dog" tiles (persisted per device)
    view.hidden = false;
    var page = document.querySelector('.page');
    if (page) page.style.display = 'none';
    poll();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () { if (active && !document.hidden) poll(); }, POLL_MS);
    // Any map left open when the tab was switched away measured itself against a
    // display:none parent — re-measure now that the view is visible again.
    setTimeout(function () {
      Object.keys(slots).forEach(function (k) {
        var st = slots[k];
        if (st && st.mapOpen && st.map) { try { st.map.invalidateSize(); fitMap(st); } catch (e) {} }
      });
    }, 0);
  }
  function exit() {
    active = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (drag) { try { onDragEnd(); } catch (e) {} }
    // Switching tabs while a map is full screen would leave a position:fixed overlay
    // (and a scroll-locked body) covering the Load Plan. Always come out first.
    if (fullscreenSlot) {
      var fs = slots[fullscreenSlot];
      if (fs) setFullscreen(fs, false);
      else { document.body.classList.remove('reorder-map-open'); fullscreenSlot = null; }
    }
    var view = document.getElementById('reorderView');
    if (view) view.hidden = true;
    var page = document.querySelector('.page');
    if (page) page.style.display = '';
  }

  document.addEventListener('visibilitychange', function () {
    if (active && !document.hidden) poll();
  });

  window.RouteReorder = { enter: enter, exit: exit, toast: toast };
})();
