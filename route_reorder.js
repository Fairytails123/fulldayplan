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
 * or "✕ Exit" returns it to the card.
 *
 * Backend contract (all on the EXISTING Apps Script web app the page already
 * uses for Share/Fetch):
 *   GET  ?action=loadStaged&token=…        -> { ok, slots:[ {slot_key, section,
 *        van, ctx:{v,p,t,rt,r,s,sa,ea,d,o,aa,gg,c,sc,ec,ex}, skipped, staged_at, rev, …} ] }
 *   POST { action:'saveOrder', token, slot_key, o, last_reordered_by }
 *   POST { action:'savePositions', token, slot_key, kp, rev, last_reordered_by }
 *   POST { action:'clearSlot', token, slot_key }
 * Final send goes to the EXISTING n8n webhook, not the Apps Script.
 *
 * Kennel dropdowns + live van mockup (added 2026-07-31): every dog tile
 * carries one dropdown per dog, defaulting to the kennel position staged from
 * the Load Plan grid (ROUTE_CTX.kp); a per-van mockup above the stops re-draws
 * on every change and IS the final word — Send Final Route forwards ctx.kp as
 * `positions` (unchanged plumbing), so the codes confirmed in the mockup are
 * exactly what the Telegram message renders after each ETA. Staff-only display
 * (C10) — kennel codes never reach customer output.
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
  // postN8n's abort for the FINAL SEND — the path with real customer side-effects.
  //
  // ⚠️ Raised 30 s → 150 s on 2026-08-04 (BUGS.md #41, found by the review and then
  // confirmed by live traffic the same morning). 30 s was shorter than the send
  // itself: execs 315496 and 315498, two real final sends three seconds apart at
  // 09:43Z, took **42.1 s and 38.2 s**. Both would have aborted here, painted
  // "Send failed — route kept, retry", and re-enabled the button after 4 s — on
  // sends that had SUCCEEDED. A re-press then produces a SECOND Telegram route
  // message to the drivers, a second Whiteboard — Update and a second W1 ingest,
  // and unlike /drive's sendQueueSlot there is no idempotency backstop here.
  //
  // That is the same mis-sizing #41 diagnosed on the staging path, sitting on the
  // higher-consequence caller. Bounded maxima on the final-send path, read from
  // the 889 export: grooming feed 25 s + RouteXL 30 s + VAN-ETA Forward 25 s +
  // Whiteboard — Update 20 s = 100 s, plus ~18 s of Sheets retry wait ≈ 118 s.
  // 150 s matches route_sender.js's ceiling and leaves headroom.
  //
  // It is a CEILING, not the normal wait — a healthy send still resolves in
  // seconds. Sizing it from observed times is what produced 30 s; size it from
  // what the backend config PERMITS.
  var REQUEST_TIMEOUT_MS = 150000;
  var SENT_RESET_MS = 2500;   // after a send: hold "✅ Sent", then re-enable so the (persisting) route can be re-sent
  var CLEAR_TOMBSTONE_MS = 6000;   // ignore a just-cleared slot for this long so an in-flight poll can't re-add its card

  var SECTIONS = [
    { key: 'HALF_DAY', title: '☀️ Today — Half Day' },
    { key: 'PM',       title: '🌆 Today — PM' },
    { key: 'NEXT_AM',  title: '📅 Next Day — AM' }
  ];
  var VAN_ORDER = ['BV', 'SV', 'BVX'];
  // Deep per-van fills (AA on white text) — the JS-side twin of the CSS
  // --van-deep custom property, for Leaflet inline styles (polyline, tethers).
  var VAN_DEEP = { BV: '#0074A6', SV: '#1E7B36', BVX: '#8F5000' };
  function vanDeepOf(van) { return VAN_DEEP[String(van || '').toUpperCase()] || '#0074A6'; }

  // "Add Dog" — section → route defaults used ONLY when creating a brand-new slot
  // (an add to a van+route that has nothing staged). period + run_type + a sensible
  // default departure; mirrors the Load Plan's own defaults + the Half-Day 12:30.
  var SECTION_DEFAULTS = {
    HALF_DAY: { p: 'PM',      rt: 'HD', t: '12:30' },
    PM:       { p: 'PM',      rt: 'FD', t: '15:00' },
    NEXT_AM:  { p: 'NEXT_AM', rt: '',   t: '08:00' }
  };
  var NEXT_AM_DEPART = { BV: '08:30', BVX: '07:30', SV: '08:30' }; // NEXT_AM default depart per van
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
  var currentReorderSectionTab = 'HALF_DAY';
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
      .replace(/[‘’ʼ′]/g, "'")
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
    if (!c) {
      c = document.createElement('div');
      c.className = 'toast-container';
      c.setAttribute('role', 'status');
      c.setAttribute('aria-live', 'polite');
      document.body.appendChild(c);
    }
    var t = document.createElement('div');
    t.className = 'toast toast-' + (type || 'info');
    // Warnings hold ~8 s (2026-07-19): they carry name lists (staging-tray
    // nudge) that can't be read inside the default 4.2 s / 3.9 s CSS fade.
    // .toast-hold overrides the baked-in fadeOut (CSS in index_v6.html).
    var hold = (type === 'warning') ? 8000 : 4200;
    if (hold > 4200) t.className += ' toast-hold';
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, hold);
  }

  // ---- network (preflight-free idiom, mirrors the page's Share/Fetch) -----
  //
  // 2026-08-04, BUGS.md #41 fix 4. Until now these two had NO timeout and NO
  // AbortController — unlike postN8n, which has had both since it was written.
  // That asymmetry is #41's own leading hypothesis for what pinned an in-flight
  // saver flag (and, through the savers' mutual defer chain, everything behind
  // it) during the 2026-08-03 staging failure: a stalled request never settles,
  // so `kpInFlight`/`noteInFlight` never clear and every other saver waits on
  // them for ever.
  //
  // ⚠️ STORE_TIMEOUT_MS is its OWN constant and must stay STRICTLY GREATER than
  // the Apps Script's REORDER_LOCK_WAIT_MS (15 s). The whole point of #41 fix 3
  // is that a busy store now ANSWERS `{ok:false, error:'busy', retryable:true}`
  // instead of throwing; an abort set at or below the lock wait would cancel
  // exactly the honest answer it was added to receive — the same mistake the old
  // 30 s REQUEST_TIMEOUT_MS made against a 45–66 s backend. Do NOT reuse
  // REQUEST_TIMEOUT_MS here: that constant belongs to postN8n, and coupling them
  // means a future n8n tune silently retunes the store abort.
  var STORE_TIMEOUT_MS = 30000;   // > the Apps Script's 15 s lock wait, with margin
  var STORE_RETRIES = 1;          // one extra attempt, ONLY on an explicit retryable refusal
  var STORE_RETRY_GAP_MS = 1200;

  function fetchWithTimeout(url, init, ms) {
    var controller = new AbortController();
    var t = setTimeout(function () { controller.abort(); }, ms);
    init = init || {};
    init.signal = controller.signal;
    return fetch(url, init).then(function (r) {
      clearTimeout(t);
      return r;
    }).catch(function (err) {
      clearTimeout(t);
      throw err;
    });
  }

  function getStaged() {
    return fetchWithTimeout(REORDER_URL + '?action=loadStaged&token=' + encodeURIComponent(TOKEN),
      { method: 'GET', cache: 'no-cache', redirect: 'follow' }, STORE_TIMEOUT_MS)
      .then(function (r) { return r.json(); });
  }

  // Retrying a `retryable` refusal happens HERE, in the one place every store
  // write passes through, and deliberately NOT in the six callers. The callers
  // are the house's classic "updated M of N sites" trap: `saveOrder`,
  // `savePositions`, `saveMessage`, `moveStop`, `clearSlot` and `addStagedDog`
  // each interpret a refusal their own way, and two of them (doSave, commitMove)
  // respond by ROLLING BACK the user's edit on screen. A busy store would have
  // read to them as "unknown failure" and visibly undone a drag — the same
  // symptom as the 2026-08-03 S2 bug, from a new cause.
  //
  // A retry is safe for every action precisely because the refusal happens
  // BEFORE the lock is held, so nothing was written and no `rev` moved: the
  // identical body is still valid. That is a property of fix 3's `reorderLock_`,
  // not a general licence — if the server ever refuses AFTER a partial write,
  // this retry must go.
  function postStore(body) {
    var attempt = 0;
    function once() {
      // No Content-Type header => simple request, no CORS preflight (Apps Script).
      return fetchWithTimeout(REORDER_URL,
        { method: 'POST', body: JSON.stringify(body), redirect: 'follow' }, STORE_TIMEOUT_MS)
        .then(function (r) { return r.text(); })
        .then(function (t) { try { return JSON.parse(t); } catch (e) { return { ok: false, error: 'bad json' }; } })
        .then(function (res) {
          if (res && res.retryable === true && attempt < STORE_RETRIES) {
            attempt++;
            return new Promise(function (resolve) {
              setTimeout(function () { resolve(once()); }, STORE_RETRY_GAP_MS);
            });
          }
          return res;
        });
    }
    return once();
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
      // 2026-08-01 redesign: this injected sheet is restyled to the Fairy
      // Tails Design System. Class names are contracts (tests + this module's
      // own lookups) -- colours/radii only. Structural rules (fullscreen
      // overlay, drop marks, .reorder-main sizing) carried over verbatim.
      '.reorder-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 10px;}' +
      '.reorder-section-head .reorder-section-title{margin:0;}' +
      '.reorder-clear-section{flex:0 0 auto;border:none;background:rgba(255,59,48,0.08);color:#FF3B30;' +
        'font-size:12px;font-weight:700;padding:6px 12px;border-radius:9999px;cursor:pointer;line-height:1.2;}' +
      '.reorder-clear-section:hover:not(:disabled){background:rgba(255,59,48,0.16);}' +
      '.reorder-clear-section:disabled{opacity:.4;cursor:default;}' +
      '.reorder-tile .reorder-del{flex:0 0 auto;width:28px;height:28px;display:inline-flex;' +
        'align-items:center;justify-content:center;border:none;border-radius:50%;background:rgba(255,59,48,0.08);' +
        'color:#FF3B30;font-size:13px;font-weight:700;line-height:1;cursor:pointer;padding:0;}' +
      '.reorder-tile .reorder-del:hover{background:rgba(255,59,48,0.16);}' +
      '.reorder-sent-flag{background:#1E7B36;color:#fff;font-size:11px;font-weight:700;padding:3px 9px;border-radius:9999px;}' +
      '.reorder-section-note{font-size:12px;font-weight:600;color:#8E8E93;padding:2px 4px 0;}' +
      '.reorder-day{background:rgba(118,118,128,0.12);color:#1C1C1E;font-size:11px;font-weight:700;padding:3px 9px;border-radius:9999px;letter-spacing:.02em;font-variant-numeric:tabular-nums;}' +
      // ---- Add Dog panel ----
      '.reorder-add{background:#fff;border-radius:18px;padding:14px;box-shadow:0 0.5px 0 rgba(0,0,0,0.04),0 1px 3px rgba(0,0,0,0.04);}' +
      '.reorder-add-head{font-weight:700;font-size:15px;letter-spacing:-0.01em;margin:0 0 10px;color:#1C1C1E;}' +
      '.reorder-add-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}' +
      '.reorder-add-form input,.reorder-add-form select{font-size:16px;font-weight:500;padding:0 12px;border:none;' +
        'border-radius:11px;background:#F2F2F7;color:#1C1C1E;min-height:44px;box-sizing:border-box;}' +
      '.reorder-add-form select{font-weight:600;font-size:14px;}' +
      '.reorder-add-name{flex:1 1 140px;min-width:120px;}' +
      '.reorder-add-addr{flex:2 1 240px;min-width:160px;}' +
      '.reorder-add-van,.reorder-add-route{flex:0 0 auto;cursor:pointer;}' +
      '.reorder-add-btn{flex:0 0 auto;border:none;border-radius:11px;background:#0074A6;color:#fff;font-size:14px;' +
        'font-weight:700;padding:0 16px;cursor:pointer;min-height:44px;}' +
      '.reorder-add-btn:hover{background:#0090C8;}' +
      // ---- staging tiles ----
      '.reorder-staging{display:flex;flex-direction:column;gap:8px;margin-top:12px;}' +
      '.reorder-stage-tile{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;' +
        'padding:10px 12px;border-radius:13px;background:#F2F2F7;}' +
      '.reorder-stage--checking{background:#F2F2F7;}' +
      '.reorder-stage--valid{background:rgba(52,199,89,0.12);}' +
      '.reorder-stage--invalid{background:rgba(255,59,48,0.08);}' +
      '.reorder-stage-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 200px;}' +
      '.reorder-stage-name{font-weight:700;font-size:14px;color:#1C1C1E;}' +
      '.reorder-stage-meta{font-size:11px;color:#8E8E93;font-weight:600;}' +
      '.reorder-stage-addr{font-size:12px;color:#8E8E93;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}' +
      '.reorder-stage-side{display:flex;align-items:center;gap:10px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end;}' +
      '.reorder-stage-status{font-size:12px;font-weight:700;}' +
      '.reorder-stage--valid .reorder-stage-status{color:#248A3D;}' +
      '.reorder-stage--invalid .reorder-stage-status{color:#FF3B30;}' +
      '.reorder-stage--checking .reorder-stage-status{color:#8E8E93;}' +
      '.reorder-stage-actions{display:flex;gap:6px;align-items:center;}' +
      '.reorder-stage-add{border:none;border-radius:9px;background:#1E7B36;color:#fff;font-size:12px;' +
        'font-weight:700;padding:8px 12px;cursor:pointer;}' +
      '.reorder-stage-recheck{border:none;border-radius:9px;background:#fff;color:#1C1C1E;font-size:12px;' +
        'font-weight:600;padding:8px 10px;cursor:pointer;box-shadow:0 0.5px 0 rgba(0,0,0,0.04),0 1px 3px rgba(0,0,0,0.06);}' +
      '.reorder-stage-x{border:none;border-radius:50%;width:26px;height:26px;background:rgba(255,59,48,0.08);color:#FF3B30;' +
        'font-size:13px;font-weight:700;cursor:pointer;line-height:1;padding:0;}' +
      '.reorder-stage-x:hover{background:rgba(255,59,48,0.16);}' +
      // ---- per-card foot (Map + Reverse row; Send is a separate card child) ----
      '.reorder-slot-foot{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;}' +
      '.reorder-slot-foot .reorder-send{grid-column:1/-1;}' +
      '.reorder-reverse,.reorder-mapbtn{min-width:0;min-height:46px;border:none;border-radius:11px;' +
        'font-size:14px;font-weight:700;padding:0 12px;cursor:pointer;transition:background 200ms ease;}' +
      '.reorder-reverse{background:rgba(0,175,241,0.10);color:#006A94;}' +
      '.reorder-reverse:hover{background:rgba(0,175,241,0.18);}' +
      '.reorder-mapbtn{background:rgba(0,175,241,0.10);color:#006A94;}' +
      '.reorder-mapbtn:hover{background:rgba(0,175,241,0.18);}' +
      '.reorder-mapbtn.is-open{background:var(--van-deep,#0074A6);color:#fff;}' +
      // ---- map panel ----
      '.reorder-mapwrap{border:0.5px solid rgba(60,60,67,0.18);border-radius:12px;overflow:hidden;background:#F8FBFE;}' +
      '.reorder-map{height:260px;width:100%;background:#E8EEF3;}' +
      '@media (max-width:600px){.reorder-map{height:280px;}}' +
      '.reorder-mapbar{display:flex;align-items:center;justify-content:space-between;gap:8px;' +
        'padding:7px 8px 7px 12px;font-size:11px;font-weight:600;color:#8E8E93;border-top:0.5px solid rgba(60,60,67,0.12);background:#F8FBFE;}' +
      '.reorder-mapnote{flex:1 1 auto;min-width:0;color:#A85B00;font-weight:600;}' +
      // Full-screen header title "<pill> <Van> route map" — hidden inline,
      // swaps in for the note when the map fills the screen (spec: dc v2).
      '.reorder-maptitle{display:none;align-items:center;gap:8px;flex:1 1 auto;min-width:0;' +
        'font-size:13px;font-weight:700;color:#1C1C1E;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.reorder-mapwrap.is-full .reorder-maptitle{display:flex;}' +
      '.reorder-mapwrap.is-full .reorder-mapnote{display:none;}' +
      '.reorder-mapbtns{flex:0 0 auto;display:flex;gap:6px;align-items:center;}' +
      '.reorder-mapfit,.reorder-mapfull{flex:0 0 auto;border:0.5px solid rgba(60,60,67,0.18);background:#fff;color:#006A94;' +
        'font-size:11px;font-weight:700;padding:0 11px;border-radius:8px;cursor:pointer;min-height:32px;}' +
      '.reorder-mapfit:hover,.reorder-mapfull:hover{background:#F2F2F7;}' +
      // ---- full-screen overlay ----
      // A CSS overlay, NOT the Fullscreen API: iOS Safari refuses requestFullscreen on
      // anything but <video>, so the API would silently do nothing on half the devices.
      // position:fixed + inset:0 fills the layout viewport on every engine we ship to.
      '.reorder-mapwrap.is-full{position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;margin:0;' +
        'border:0;border-radius:0;display:flex;flex-direction:column;background:#fff;}' +
      '.reorder-mapwrap.is-full .reorder-map{flex:1 1 auto;height:auto;min-height:0;}' +
      // bar to the TOP in full screen so Close is always reachable (thumb-friendly on mobile)
      '.reorder-mapwrap.is-full .reorder-mapbar{order:-1;border-top:0;border-bottom:0.5px solid rgba(60,60,67,0.12);' +
        'padding:10px 12px;padding-top:calc(10px + env(safe-area-inset-top,0px));background:rgba(249,249,249,0.94);}' +
      '.reorder-mapwrap.is-full .reorder-mapfull{background:var(--van-deep,#0074A6);border-color:var(--van-deep,#0074A6);color:#fff;min-height:36px;}' +
      'body.reorder-map-open{overflow:hidden;}' +
      // numbered stop markers -- mirror the .reorder-pos tile badge so map == list
      '.reorder-pin{background:transparent;border:0;}' +
      '.reorder-pin span{display:flex;align-items:center;justify-content:center;width:26px;height:26px;' +
        'border-radius:50%;background:var(--van-deep,#0074A6);color:#fff;font-weight:700;font-size:13px;' +
        'font-variant-numeric:tabular-nums;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);}' +
      '.reorder-pin--start span{background:#1E7B36;font-size:14px;}' +
      '.reorder-pin--end span{background:#1C1C1E;font-size:14px;}' +
      '.reorder-pop{font-size:13px;line-height:1.45;}' +
      '.reorder-pop b{display:block;margin-bottom:2px;}' +
      // stop numbers pop when the ORDER changes, so a reorder is visibly acknowledged
      '@keyframes reorderPinPop{0%{transform:scale(1);}45%{transform:scale(1.45);}100%{transform:scale(1);}}' +
      '.reorder-map.is-repinned .reorder-pin span{animation:reorderPinPop .36s ease-out;}' +
      // direction arrow along each leg of the route
      '.reorder-arrow{background:transparent;border:0;}' +
      '.reorder-arrow i{display:block;width:0;height:0;border-left:6px solid var(--van-deep,#0074A6);' +
        'border-top:4.5px solid transparent;border-bottom:4.5px solid transparent;' +
        'filter:drop-shadow(0 0 1px #fff) drop-shadow(0 0 1px #fff);}' +
      // ---- per-tile address line (2026-07-19; the per-tile Map Check button
      // was removed 2026-08-02 on Kam's request — the card-level "Check on
      // map" covers it and the rows read cleaner) ----
      // The name+address column takes the flex slot .reorder-name held alone;
      // .reorder-name keeps its base ellipsis styling but stops flexing itself.
      // Cross-van move (2026-07-20): while a tile is dragged, every OTHER run in
      // the same section is a live drop target. A same-section card lights up
      // green under the pointer; a different-section card is refused (red, plus
      // a "not allowed" cursor) because a move there would change the dog's
      // departure time/day.
      '.reorder-slot.is-drop-target{outline:2px dashed #34C759;outline-offset:2px;background:#F4FCF6;}' +
      '.reorder-slot.is-drop-blocked{outline:2px dashed #FF3B30;outline-offset:2px;background:rgba(255,59,48,0.04);' +
        'cursor:not-allowed;}' +
      '.reorder-slot.is-drop-source{opacity:0.97;}' +
      // Sizing rationale (2026-07-31, kennel dropdowns): basis 150px (NOT auto)
      // so the wrap decision uses a compact hypothetical size -- controls stay
      // on one line whenever they fit and the name/address GROW into the
      // leftover (ellipsis beyond); basis auto made long-address tiles wrap
      // their controls even when shrinking would fit. The min-width floor
      // stops the name crushing to one letter beside two dropdowns; the tile
      // wraps instead (flex-wrap since the same date).
      '.reorder-tile .reorder-main{flex:1 1 150px;min-width:min(150px,55%);display:flex;flex-direction:column;gap:2px;}' +
      '.reorder-tile .reorder-main .reorder-name{flex:none;}' +
      '.reorder-tile .reorder-addr{font-size:12px;color:#8E8E93;overflow:hidden;text-overflow:ellipsis;' +
        'white-space:nowrap;max-width:100%;}' +
      '@media (max-width:600px){' +
        '.reorder-tile{gap:6px;}' +
        '.reorder-up,.reorder-down{width:34px;height:34px;}' +
      '}';
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
    head.innerHTML = '<div class="reorder-headtext">' +
        '<span class="reorder-title">Staged routes</span>' +
        '<span class="reorder-subtitle" id="reorderStatus">Reorder the stops, check the map, then send to the driver — syncs across devices</span>' +
      '</div>' +
      '<span class="reorder-live-pill"><span class="reorder-poll-dot" id="reorderPollDot"></span>Live</span>';
    view.appendChild(head);
    view.appendChild(buildAddPanel());
    var tabStrip = document.createElement('div');
    tabStrip.className = 'reorder-plan-tabs';
    reorderSectionTabLabels().forEach(function (tab) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'nav-tab reorder-plan-tab';
      button.setAttribute('data-section', tab.key);
      button.setAttribute('role', 'button');
      button.setAttribute('tabindex', '0');
      button.textContent = tab.label;
      button.addEventListener('click', function () { setReorderSectionTab(tab.key); });
      button.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setReorderSectionTab(tab.key);
        }
      });
      tabStrip.appendChild(button);
    });
    view.appendChild(tabStrip);
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
    setReorderSectionTab('HALF_DAY');
    view.__built = true;
  }

  function reorderSectionTabLabels() {
    return [
      { key: 'HALF_DAY', label: 'Today Half Day' },
      { key: 'PM', label: 'Today PM' },
      { key: 'NEXT_AM', label: 'Next Day AM' }
    ];
  }

  function getReorderSectionTab() {
    return currentReorderSectionTab;
  }

  function setReorderSectionTab(key) {
    var sections = document.querySelectorAll('.reorder-section');
    var tabs = document.querySelectorAll('.reorder-plan-tab');
    var valid = false;
    sections.forEach(function (section) {
      if (section.getAttribute('data-section') === key) valid = true;
    });
    if (!valid) return;
    currentReorderSectionTab = key;
    sections.forEach(function (section) {
      section.hidden = section.getAttribute('data-section') !== key;
    });
    tabs.forEach(function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-section') === key);
    });
    if (typeof slots === 'undefined') return;
    setTimeout(function () {
      Object.keys(slots).forEach(function (slotKey) {
        var st = slots[slotKey];
        if (st && st.record && st.record.section === key && st.mapOpen && st.map) {
          try { st.map.invalidateSize(); fitMap(st); } catch (e) {}
        }
      });
    }, 0);
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
        toast((r && r.retryable)
          ? 'The staging store is busy — the dog was not added. Try again in a moment.'
          : ((r && r.error) || 'Could not add dog — try again'),
          (r && r.retryable) ? 'warning' : 'error');
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

  // { <normKey(dog)>: address } — the ROUTED address per member (ctx.ad, staged
  // by Format Route since 2026-07-19; twin of ctx.c). An added dog's ctx.ex
  // address wins, mirroring coordIndexFor's ex-over-c precedence. Routes staged
  // BEFORE the ctx.ad rollout simply have no entries — those tiles show no
  // address line until the route is re-staged (same as the ctx.c precedent).
  function addrIndexFor(ctx) {
    var idx = {};
    var ad = (ctx && ctx.ad && typeof ctx.ad === 'object' && !Array.isArray(ctx.ad)) ? ctx.ad : {};
    Object.keys(ad).forEach(function (k) {
      var a = String(ad[k] || '').trim();
      if (a) idx[normKey(k)] = a;
    });
    ((ctx && ctx.ex) || []).forEach(function (e) {
      if (!e) return;
      var k = normKey(e.d);
      var a = String((e && e.a) || '').trim();
      if (k && a) idx[k] = a;
    });
    return idx;
  }
  function stopAddr(members, idx) {
    for (var i = 0; i < (members || []).length; i++) {
      var a = idx[normKey(members[i])];
      if (a) return a;
    }
    return '';
  }

  // ---- kennel positions (per-dog dropdowns + live van mockup, 2026-07-31) --
  // ctx.kp = { <normKey(dog)>: <CODE> }, written by Format Route at stage time
  // from the Load Plan grid and EDITABLE here. Layouts come from
  // shared/ft-kennels.js (window.FT_KENNELS, loaded by index_v6.html: BV/BVX 15
  // kennels, SV 10 with wheel-arch back-bottom boxes). Module absent or van
  // unknown ⇒ the whole feature degrades silently (no dropdowns, no mockup) —
  // the same fail-safe posture as the /drive kennel board.
  var KENNEL_CODE_RE = /^[SB][TMB][PMD]$/;   // byte-sync: savePositions_ (Apps Script) + /drive kennelAssignments
  var KB_COLLAPSE_LS = 'reorder_kb_collapsed';

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }
  function firstNameOf(n) {
    return String(n == null ? '' : n).trim().split(/\s+/)[0] || '';
  }
  function kennelLayoutFor(van) {
    var K = (typeof window !== 'undefined' && window.FT_KENNELS) || null;
    return (K && K[String(van || '').toUpperCase()]) || null;
  }
  function kennelCodesFor(layout) {
    if (!layout) return [];
    var out = [];
    (layout.side || []).concat(layout.back || []).forEach(function (row) {
      (row || []).forEach(function (c) { out.push(c); });
    });
    return out;
  }
  // "STP" → "side · top · passenger" (option tooltips). Positional maps — the
  // letters are ambiguous otherwise (B = Back grid AND Bottom row, M = Middle
  // row AND Middle column).
  function kennelWords(code) {
    if (!KENNEL_CODE_RE.test(code)) return '';
    var ROW = { T: 'top', M: 'middle', B: 'bottom' };
    var COL = { P: 'passenger', M: 'middle', D: 'driver' };
    return (code.charAt(0) === 'S' ? 'side' : 'back') + ' · ' + ROW[code.charAt(1)] + ' · ' + COL[code.charAt(2)];
  }
  // { <normKey(dog)>: CODE } from ctx.kp — grammar-filtered, keys re-normalised
  // (idempotent), mirroring coordIndexFor's defensive shape checks.
  function kennelIndexFor(ctx) {
    var idx = {};
    var kp = (ctx && ctx.kp && typeof ctx.kp === 'object' && !Array.isArray(ctx.kp)) ? ctx.kp : {};
    Object.keys(kp).forEach(function (k) {
      var code = String(kp[k] || '').toUpperCase().trim();
      var nk = normKey(k);
      if (nk && KENNEL_CODE_RE.test(code)) idx[nk] = code;
    });
    return idx;
  }
  // Present (non-salon) dogs in CURRENT tile order → { layout, dogs:[{name,
  // key, stop, code|''}] }. code '' also when the staged code isn't a kennel
  // of THIS van (those dogs count as unassigned). null ⇒ feature off.
  function kennelRoster(st) {
    var ctx = (st && st.record && st.record.ctx) || {};
    var layout = kennelLayoutFor(ctx.v);
    if (!layout) return null;
    var valid = {};
    kennelCodesFor(layout).forEach(function (c) { valid[c] = true; });
    var idx = kennelIndexFor(ctx);
    var dogs = [];
    var ol = st.card && st.card.querySelector('.reorder-list');
    if (ol) {
      currentOrderIds(ol).forEach(function (id, i) {
        (st.stopsById[id] || []).forEach(function (m) {
          if (isSalonName(m)) return;          // the salon is a stop, not a dog in a kennel
          var key = normKey(m);
          var code = idx[key] || '';
          dogs.push({ name: m, key: key, stop: i + 1, code: valid[code] ? code : '' });
        });
      });
    }
    return { layout: layout, dogs: dogs };
  }

  // Re-derive every piece of kennel UI on a card (selects + mockup) from the
  // current DOM order + ctx.kp. Cheap (≤15 codes × ≤a dozen selects), so it
  // simply rebuilds rather than diffing.
  function refreshKennelUi(st) {
    if (!st || !st.card) return;
    var board = st.card.querySelector('.reorder-kboard');
    var ol = st.card.querySelector('.reorder-list');
    var r = kennelRoster(st);
    if (!r) {
      if (board) { board.hidden = true; board.innerHTML = ''; }
      if (ol) [].slice.call(ol.querySelectorAll('.reorder-kennels')).forEach(function (s) { s.innerHTML = ''; });
      return;
    }
    var occ = {};                              // code -> [{name, key, stop, code}]
    r.dogs.forEach(function (d) { if (d.code) (occ[d.code] = occ[d.code] || []).push(d); });
    renderKennelSelects(st, r, occ);
    renderKennelBoard(st, r, occ);
  }

  function renderKennelSelects(st, r, occ) {
    var ol = st.card.querySelector('.reorder-list');
    if (!ol) return;
    var byKey = {};
    r.dogs.forEach(function (d) { if (!byKey[d.key]) byKey[d.key] = d; });
    var codes = kennelCodesFor(r.layout);
    [].slice.call(ol.querySelectorAll('.reorder-tile')).forEach(function (li) {
      var span = li.querySelector('.reorder-kennels');
      if (!span) return;
      span.innerHTML = '';
      var members = st.stopsById[li.getAttribute('data-stop-id')] || [];
      var dogMembers = members.filter(function (m) { return !isSalonName(m); });
      dogMembers.forEach(function (m) {
        var d = byKey[normKey(m)];
        if (!d) return;
        if (dogMembers.length > 1) {
          var who = document.createElement('span');
          who.className = 'reorder-kennel-who';
          who.textContent = firstNameOf(m);
          span.appendChild(who);
        }
        var sel = document.createElement('select');
        sel.className = 'reorder-kennel' + (d.code ? '' : ' is-un');
        sel.title = 'Kennel position for ' + m;
        var opt0 = document.createElement('option');
        opt0.value = '';
        opt0.textContent = '—';
        sel.appendChild(opt0);
        codes.forEach(function (code) {
          var others = (occ[code] || []).filter(function (x) { return x.key !== d.key; });
          var opt = document.createElement('option');
          opt.value = code;
          opt.title = kennelWords(code);
          // Visible label "CODE · side/rear" (spec); occupant hint / full marker kept.
          var side = code.charAt(0) === 'S' ? 'side' : 'rear';
          if (others.length >= 2) { opt.disabled = true; opt.textContent = code + ' · ' + side + ' (full)'; }
          else if (others.length === 1) { opt.textContent = code + ' · ' + side + ' · ' + firstNameOf(others[0].name); }
          else { opt.textContent = code + ' · ' + side; }
          sel.appendChild(opt);
        });
        sel.value = d.code || '';
        sel.addEventListener('change', function () { onKennelChange(st, m, sel); });
        span.appendChild(sel);
      });
    });
  }

  function kbGrid(rows, label, layout, occ) {
    var html = '<div class="reorder-kb-grid"><div class="reorder-kb-doorlbl">' + escapeHtml(label) + '</div>';
    (rows || []).forEach(function (row) {
      html += '<div class="reorder-kb-row" style="grid-template-columns:repeat(' + row.length + ',minmax(0,1fr))">';
      row.forEach(function (code) {
        var dogs = occ[code] || [];
        var arch = (layout.arches || []).indexOf(code) !== -1;
        html += '<div class="reorder-kb-box' + (dogs.length ? ' is-occ' : '') + (arch ? ' has-arch' : '') +
          '" data-code="' + code + '"><span class="reorder-kb-pos">' + code + '</span>';
        dogs.forEach(function (d) {
          html += '<span class="reorder-kb-dog" title="' + escapeAttr(d.name + ' — stop ' + d.stop) + '">' +
            escapeHtml(firstNameOf(d.name)) + '<em>' + d.stop + '</em></span>';
        });
        html += '</div>';
      });
      html += '</div>';
    });
    return html + '</div>';
  }

  function renderKennelBoard(st, r, occ) {
    var board = st.card.querySelector('.reorder-kboard');
    if (!board) return;
    var collapsed = false;
    try { collapsed = localStorage.getItem(KB_COLLAPSE_LS) === '1'; } catch (e) {}
    var un = r.dogs.filter(function (d) { return !d.code; });
    board.innerHTML =
      '<div class="reorder-kb-head" role="button" tabindex="0" title="Show/hide the van kennel layout">' +
        '<span class="reorder-kb-title">Kennel layout</span>' +
        '<span class="reorder-kb-count">' + r.dogs.length + ' dog' + (r.dogs.length === 1 ? '' : 's') +
          ' · ' + kennelCodesFor(r.layout).length + ' kennels</span>' +
        (un.length ? '<span class="reorder-kb-un" title="' +
          escapeAttr(un.map(function (d) { return d.name; }).join(', ')) + '">' +
          un.length + ' unassigned</span>' : '') +
        '<span class="reorder-kb-caret">▾</span>' +
      '</div>' +
      '<div class="reorder-kb-body">' +
        kbGrid(r.layout.side, 'Side · side door', r.layout, occ) +
        kbGrid(r.layout.back, 'Rear · back doors', r.layout, occ) +
      '</div>' +
      '<span class="reorder-kb-note">Kennel positions follow the load plan — badge numbers show each kennel’s stop</span>';
    board.hidden = false;
    board.classList.toggle('collapsed', collapsed);
    var head = board.querySelector('.reorder-kb-head');
    if (head) head.addEventListener('click', function () {
      var c = board.classList.toggle('collapsed');
      try { localStorage.setItem(KB_COLLAPSE_LS, c ? '1' : '0'); } catch (e) {}
    });
  }

  function onKennelChange(st, member, sel) {
    var code = sel.value;
    var ctx = (st.record && st.record.ctx) || {};
    var key = normKey(member);
    if (code) {
      // Belt-and-braces: options render disabled when full, but the roster may
      // have moved under a slow tap — the Load Plan's "max 2 dogs" rule holds.
      var r = kennelRoster(st);
      var others = 0;
      ((r && r.dogs) || []).forEach(function (d) { if (d.code === code && d.key !== key) others++; });
      if (others >= 2) {
        toast('Box is full (max 2 dogs) — ' + code, 'error');
        refreshKennelUi(st);
        return;
      }
    }
    if (!ctx.kp || typeof ctx.kp !== 'object' || Array.isArray(ctx.kp)) ctx.kp = {};
    if (code) ctx.kp[key] = code; else delete ctx.kp[key];
    st.record.ctx = ctx;
    refreshKennelUi(st);        // mockup + every select's occupant hints follow immediately
    scheduleKpSave(st);
    // One-way write-back to the Load Plan grid (owner request 2026-07-31):
    // the seed grid follows the final word. Assignments only — never trays a
    // tile (a trayed dog silently drops off the route at the next re-stage).
    // Silent no-op when the other plan is loaded, the dog has no tile
    // (Add-Dog), or the grid box is full. Cosmetic courtesy; never surfaces.
    try {
      if (code && window.RouteSender && RouteSender.applyKennelFromReorder) {
        var wbPlan = (String(ctx.p || '').toUpperCase() === 'NEXT_AM') ? 'NEXT_AM' : 'PM';
        var wbLane = wbPlan === 'PM' &&
          (st.record.section === 'HALF_DAY' || String(ctx.rt || '').toUpperCase() === 'HD') ? 'HD' : 'FD';
        RouteSender.applyKennelFromReorder(wbPlan, ctx.v, member, code,
          { lane: wbPlan === 'PM' ? wbLane : undefined });
      }
    } catch (eWb) { /* cosmetic only — never break a kennel edit on it */ }
  }

  // Debounced persist of ctx.kp via the new savePositions action — the same
  // optimistic + rollback discipline as scheduleSave/doSave, kept SEPARATE so
  // a kennel edit can never rewrite ctx.o (and vice versa). Ordering: a kennel
  // save defers to any order save fully (schedule OR flight); an order save
  // defers only to a kennel POST actually in flight — one-way priority, so the
  // two can never mutually defer forever.
  function scheduleKpSave(st) {
    st.pendingKpSave = true;
    st.kpSaveFailed = false;
    var sf = st.card && st.card.querySelector('.reorder-sent-flag');
    if (sf) sf.hidden = true;              // positions changed since the last send
    if (st.kpSaveTimer) clearTimeout(st.kpSaveTimer);
    st.kpSaveTimer = setTimeout(function () { doKpSave(st); }, SAVE_DEBOUNCE_MS);
  }
  function doKpSave(st) {
    if (st.kpInFlight) return;
    if (st.pendingSave || st.noteInFlight) {
      // An order save is queued/in flight, or a driver-note POST is mid-air
      // (it bumps the same rev) — let it land first. Note defer is on
      // noteInFlight ONLY, never pendingNoteSave: doNoteSave yields to
      // pendingKpSave, so waiting on the un-sent note debounce would deadlock.
      if (st.kpSaveTimer) clearTimeout(st.kpSaveTimer);
      st.kpSaveTimer = setTimeout(function () { doKpSave(st); }, 400);
      return;
    }
    var r = kennelRoster(st);
    if (!r) { st.pendingKpSave = false; return; }
    var kp = {};
    r.dogs.forEach(function (d) { if (d.code) kp[d.key] = d.code; });
    st.kpInFlight = true;
    st.kpSaveTimer = null;
    return postStore({ action: 'savePositions', token: TOKEN, slot_key: st.record.slot_key, kp: kp,
                rev: st.record.rev, last_reordered_by: deviceId() })
      .then(function (res) {
        st.kpInFlight = false;
        st.pendingKpSave = false;
        if (res && res.ok) {
          st.kpSaveFailed = false;
          if (res.rev != null) { st.record.rev = res.rev; st.renderedRev = res.rev; }
        } else if (res && res.stale) {
          st.kpSaveFailed = true;
          markReorderSaveFailure(st);
          st.renderedRev = null;           // force the next poll to re-render from server truth
          toast('That route changed on another device — reloaded', 'warning');
          poll();
        } else if (res && res.retryable) {
          st.kpSaveFailed = true;
          markReorderSaveFailure(st);
          // #41 fix 3/4: the store was busy and postStore already retried once.
          // Nothing was written and no rev moved, so KEEP the operator's edit on
          // screen: do NOT null renderedRev and do NOT poll() (either would repaint
          // server truth over an edit that is still perfectly valid).
          toast('The staging store is busy — the kennel change was not saved. Try again in a moment.', 'warning');
        } else {
          st.kpSaveFailed = true;
          markReorderSaveFailure(st);
          st.renderedRev = null;
          toast('Could not save kennel positions — reloaded', 'error');
          poll();
        }
      })
      .catch(function () {
        st.kpInFlight = false;
        st.pendingKpSave = false;
        st.kpSaveFailed = true;
        markReorderSaveFailure(st);
        st.renderedRev = null;
        toast('Could not save kennel positions — reloaded', 'error');
        poll();
      });
  }

  // OFFICE-NOTE (2026-08-02): debounced persist of ctx.dm via the C5
  // saveMessage action — the scheduleKpSave/doKpSave discipline exactly.
  // Strict one-way priority (order save > kennel save > note save) so no two
  // savers can mutually defer forever; a stale rev refusal re-polls, same as
  // the kennel path.
  var NOTE_SAVE_DEBOUNCE_MS = 900;
  function scheduleNoteSave(st) {
    st.pendingNoteSave = true;
    var sEl = st.card && st.card.querySelector('.reorder-note-state');
    if (sEl) { sEl.hidden = false; sEl.textContent = 'saving…'; }
    if (st.noteSaveTimer) clearTimeout(st.noteSaveTimer);
    st.noteSaveTimer = setTimeout(function () { doNoteSave(st); }, NOTE_SAVE_DEBOUNCE_MS);
  }
  function doNoteSave(st) {
    if (st.noteInFlight) return;
    if (st.pendingSave || st.pendingKpSave || st.kpInFlight) {
      if (st.noteSaveTimer) clearTimeout(st.noteSaveTimer);
      st.noteSaveTimer = setTimeout(function () { doNoteSave(st); }, 500);
      return;
    }
    var note = st.card && st.card.querySelector('.reorder-note-input');
    if (!note) { st.pendingNoteSave = false; return; }
    var dm = String(note.value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    st.noteInFlight = true;
    st.noteSaveTimer = null;
    return postStore({ action: 'saveMessage', token: TOKEN, slot_key: st.record.slot_key, dm: dm,
                rev: st.record.rev, last_reordered_by: deviceId() })
      .then(function (res) {
        st.noteInFlight = false;
        st.pendingNoteSave = false;
        var sEl = st.card && st.card.querySelector('.reorder-note-state');
        if (res && res.ok) {
          if (res.rev != null) { st.record.rev = res.rev; st.renderedRev = res.rev; }
          if (st.record.ctx) st.record.ctx.dm = dm;
          if (sEl) { sEl.textContent = 'saved ✓'; setTimeout(function () { sEl.hidden = true; }, 1800); }
        } else if (res && res.stale) {
          if (sEl) sEl.hidden = true;
          st.renderedRev = null;
          toast('That route changed on another device — reloaded', 'warning');
          poll();
        } else if (res && res.retryable) {
          // #41 fix 3/4: busy store, already retried once by postStore. Nothing
          // was written and no rev moved — keep the typed note on screen.
          if (sEl) { sEl.textContent = 'not saved — store busy'; }
          toast('The staging store is busy — the driver note was not saved. Try again in a moment.', 'warning');
        } else {
          if (sEl) sEl.hidden = true;
          st.renderedRev = null;
          toast('Could not save the driver note — reloaded', 'error');
          poll();
        }
      })
      .catch(function () {
        st.noteInFlight = false;
        st.pendingNoteSave = false;
        var sEl2 = st.card && st.card.querySelector('.reorder-note-state');
        if (sEl2) sEl2.hidden = true;
        st.renderedRev = null;
        toast('Could not save the driver note — reloaded', 'error');
        poll();
      });
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
  // and mobile alike. Escape or "✕ Exit" returns it to the card.
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
      if (btn) { btn.textContent = '✕ Exit'; btn.title = 'Back to the route card'; }
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
        L.polyline(line, { color: vanDeepOf(st.record && st.record.van), weight: 3, opacity: 0.55, lineCap: 'round' })
          .addTo(st.mapLayer);
        addArrows(L, st.map, st.mapLayer, line);
      }

      // Fan out any pins that would sit on top of each other, and tether them home.
      var placed = spreadPins(L, st.map, plot.stops);
      placed.forEach(function (p, i) {
        if (!p.tether) return;
        L.polyline([p.tether, p.pin], { color: vanDeepOf(st.record && st.record.van), weight: 1, opacity: 0.35, interactive: false })
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
    if (btn) { btn.classList.remove('is-open'); btn.textContent = '🗺 Check on map'; }
  }

  function toggleMap(slotKey) {
    var st = slots[slotKey];
    if (!st || !st.card) return;
    if (st.mapOpen) closeMap(st); else openMap(st);
  }

  // (The per-tile "🗺 Map Check" single-stop focus — focusStop/mapCheckStop/
  // st.pendingFocus, 2026-07-19 — was removed 2026-08-02 on Kam's request:
  // the card-level "Check on map" + tappable pins cover it.)

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
    refreshKennelUi(st);    // mockup stop numbers follow too
    scheduleSave(st);
    toast('Route reversed', 'info');
  }

  // Day+date stamp ("MON 28/06") for a card. Prefer the server-computed ctx.dt
  // (set by Format Route at stage time, so it matches the Telegram message exactly);
  // fall back to computing from staged_at + section for routes staged before this
  // feature (today for PM/Half-Day, the next day for NEXT_AM). Europe/London.
  function stampFromDate(d) {
    try {
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

  function dayStampFor(rec) {
    if (rec && rec.ctx && rec.ctx.dt) return String(rec.ctx.dt);
    var d = (rec && rec.staged_at) ? new Date(rec.staged_at) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    if (rec && rec.section === 'NEXT_AM') d = new Date(d.getTime() + 86400000);
    return stampFromDate(d);
  }

  // Overlay day guard with an injectable clock for deterministic checks. A
  // NEXT_AM route staged the previous evening legitimately carries today's
  // stamp on run morning; accept that crossover only before noon in London
  // and inside a 36-hour belt. From noon, NEXT_AM belongs to tomorrow's plan.
  function slotDayAccepted(rec, nowMs) {
    var now = new Date(nowMs == null ? Date.now() : nowMs);
    if (isNaN(now.getTime())) now = new Date();
    var stamp = dayStampFor(rec);
    var today = stampFromDate(now);
    var expectedDate = new Date(now.getTime());
    if (rec && rec.section === 'NEXT_AM') expectedDate = new Date(expectedDate.getTime() + 86400000);
    var expected = stampFromDate(expectedDate);
    if (stamp === expected) return true;
    if (!rec || rec.section !== 'NEXT_AM' || stamp !== today) return false;
    var hourParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(now);
    var londonHour = 0;
    hourParts.forEach(function (part) {
      if (part.type === 'hour') londonHour = Number(part.value);
    });
    if (londonHour >= 12) return false;
    var stagedMs = Date.parse(rec.staged_at || '');
    var updatedMs = Date.parse(rec.updated_at || '');
    var latest = Math.max(isFinite(stagedMs) ? stagedMs : 0, isFinite(updatedMs) ? updatedMs : 0);
    var age = now.getTime() - latest;
    return latest > 0 && age >= 0 && age <= 36 * 60 * 60 * 1000;
  }

  // ---- Load-Plan overlay from the staged store (2026-08-02, Kam) ----------
  // The ReorderQueue is the always-current shared truth for stop ORDER and
  // KENNEL positions (every drag persists via saveOrder, every kennel edit
  // via savePositions, and Send Final sends exactly that state). The Load
  // Plan's cloud snapshot, by contrast, is only as fresh as the last manual
  // Share. So on plan load / Fetch (and after a Send Final) the grid is
  // aligned READ-SIDE from the store: kennel assignments through the existing
  // one-way write-back (RouteSender.applyKennelFromReorder — never trays,
  // never creates a tile, max-2 refusal) and stop numbers through
  // RouteSender.applyReturnedStops with clearUnmatched (a dog pulled off the
  // route sheds its stale number). The overlay itself never writes the cloud
  // store; Share and the post-send pin publish an aligned snapshot separately.
  function overlayFromStore(planId, opts) {
    opts = opts || {};
    planId = String(planId || '').toUpperCase() === 'NEXT_AM' ? 'NEXT_AM' : 'PM';
    if (!window.RouteSender || !window.RouteSender.applyKennelFromReorder ||
        !window.RouteSender.applyReturnedStops) {
      return Promise.resolve({ ok: false, reason: 'sender-unwired' });
    }
    return Promise.resolve().then(function () {
      return getStaged();
    }).then(function (body) {
      if (!body || body.ok !== true || !Array.isArray(body.slots)) {
        return { ok: false, reason: 'store-unavailable' };
      }
      return { ok: true, result: applyStoreOverlay(planId, body.slots, body.cleared, opts) };
    }).catch(function () {
      return { ok: false, reason: 'store-error' };
    });
  }

  function applyStoreOverlay(planId, slotRecs, clearedKeys, opts) {
    opts = opts || {};
    var kennelMoves = 0, stopWrites = 0, vansAligned = 0, removedMoves = 0;
    var purged = 0, purgeOk = true, purgeRefused = 0, purgedNames = [];
    var claimedTileIds = {};
    function laneForRec(rec) {
      if (planId !== 'PM') return null;
      return rec && (rec.section === 'HALF_DAY' || (rec.ctx && rec.ctx.rt === 'HD')) ? 'HD' : 'FD';
    }
    var eligible = (slotRecs || []).filter(function (rec) {
      if (!rec || !rec.ctx || !rec.van) return false;
      var slotPlan = (rec.section === 'NEXT_AM') ? 'NEXT_AM' : 'PM';   // HALF_DAY rides the PM plan
      return slotPlan === planId && slotDayAccepted(rec, Date.now());
    });
    // Record routed ownership before moving anything so legacy adoption is
    // independent of store order and never steals a dog from its own lane.
    var routedLanesByDog = {};
    eligible.forEach(function (rec) {
      var lane = laneForRec(rec) || 'FD';
      var o = Array.isArray(rec.ctx.o) ? rec.ctx.o : [];
      o.forEach(function (members) {
        (members || []).forEach(function (m) {
          if (isSalonName(m)) return;
          var key = normKey(m);
          if (!key) return;
          if (!routedLanesByDog[key]) routedLanesByDog[key] = {};
          routedLanesByDog[key][lane] = true;
        });
      });
    });
    var stopsByVanLane = {};
    var alignedVans = {};
    eligible.forEach(function (rec) {
      var van = String(rec.van || '').toUpperCase();
      var lane = laneForRec(rec);
      var laneKey = van + '__' + (lane || 'FD');
      if (!stopsByVanLane[laneKey]) stopsByVanLane[laneKey] = { van: van, lane: lane, stops: [] };
      if (!alignedVans[van]) {
        alignedVans[van] = true;
        vansAligned++;
      }
      var o = Array.isArray(rec.ctx.o) ? rec.ctx.o : [];
      var kidx = kennelIndexFor(rec.ctx);
      o.forEach(function (members, i) {
        (members || []).forEach(function (m) {
          if (isSalonName(m)) return;          // rides the route, has no grid tile
          var code = kidx[normKey(m)];
          var owners = routedLanesByDog[normKey(m)] || {};
          if (RouteSender.applyKennelFromReorder(planId, rec.van, m, code || '',
              { storeOverlay: true, createMissing: opts.rebuild === true, lane: lane || undefined,
                allowLaneAdoption: planId !== 'PM' || Object.keys(owners).length === 1,
                onClaim: function (tileId) { if (tileId) claimedTileIds[String(tileId)] = true; } })) kennelMoves++;
          stopsByVanLane[laneKey].stops.push({ name: m, stop: i + 1 });
        });
      });
    });

    // Send Final is authoritative for every active staged van/lane. The keep
    // set is plan-wide so a routed tile survives even when a cross-van move is
    // refused and leaves it sitting in another staged van's kennel.
    if (opts.rebuild === true) {
      var purgeUnavailable = typeof RouteSender.purgeUnroutedTiles !== 'function';
      if (purgeUnavailable) purgeOk = false;
      Object.keys(stopsByVanLane).forEach(function (key) {
        if (purgeUnavailable) return;
        var group = stopsByVanLane[key];
        try {
          var purgeResult = RouteSender.purgeUnroutedTiles(planId, group.van,
            group.lane || undefined, Object.keys(claimedTileIds));
          purgeResult = purgeResult || {};
          purged += Number(purgeResult.purged) || 0;
          purgeRefused += Number(purgeResult.refused) || 0;
          if (Array.isArray(purgeResult.names)) {
            purgedNames = purgedNames.concat(purgeResult.names);
          }
        } catch (purgeErr) {
          purgeOk = false;
        }
      });
      if (!purgeOk) {
        try {
          toast('Could not purge stale tiles — the load plan may not be re-aligned to the sent route.', 'error');
        } catch (purgeToastErr) {}
      }
      if (purgeRefused > 0) {
        try {
          toast('Could not remove ' + purgeRefused + ' stale tile(s) — the load plan may still contain dogs not on the sent route.', 'error');
        } catch (refusedToastErr) {}
      }
      if (purged > 0) {
        try {
          toast('Removed ' + purged + ' dog(s) not on the sent route: ' + purgedNames.join(', '), 'warning');
        } catch (removedToastErr) {}
      }
    }

    Object.keys(stopsByVanLane).forEach(function (key) {
      var group = stopsByVanLane[key];
      if (!group.stops.length) return;
      stopWrites += RouteSender.applyReturnedStops(group.van, group.stops, planId,
        { clearUnmatched: true, lane: group.lane || undefined });
    });

    // Tray only dogs positively identified as removed from these staged slots.
    // A never-staged grid dog is not enumerated and remains untouched.
    var seenDogs = {};
    eligible.forEach(function (rec) {
      var lane = laneForRec(rec);
      var order = Array.isArray(rec.ctx.o) ? rec.ctx.o : [];
      if (!order.length) return;
      var laneEligible = eligible.filter(function (candidate) {
        return laneForRec(candidate) === lane;
      });
      (Array.isArray(rec.ctx.d) ? rec.ctx.d : []).forEach(function (dog) {
        var key = normKey(dog);
        var seenKey = (lane || 'FD') + '__' + key;
        if (!key || seenDogs[seenKey]) return;
        seenDogs[seenKey] = true;
        if (RouteSender.classifyOverlayDog(dog, laneEligible) === 'removed' &&
            RouteSender.moveRemovedDogToTray(planId, dog, lane || undefined)) removedMoves++;
      });
    });

    // CLEARED rows are omitted from slots and supplied additively as keys.
    // Do not blank a lane if another active slot still owns that van+lane.
    var activeVanLanes = {};
    eligible.forEach(function (rec) {
      activeVanLanes[String(rec.van || '').toUpperCase() + '__' + (laneForRec(rec) || 'FD')] = true;
    });
    (Array.isArray(clearedKeys) ? clearedKeys : []).forEach(function (slotKey) {
      var parts = String(slotKey || '').split('__');
      if (parts.length !== 2) return;
      var clearedPlan = parts[0] === 'NEXT_AM' ? 'NEXT_AM' : 'PM';
      var clearedLane = clearedPlan === 'PM' && parts[0] === 'HALF_DAY' ? 'HD' : 'FD';
      var van = String(parts[1] || '').toUpperCase();
      if (clearedPlan === planId && van && !activeVanLanes[van + '__' + clearedLane]) {
        stopWrites += RouteSender.clearVanStops(planId, van, planId === 'PM' ? clearedLane : undefined);
      }
    });
    if (vansAligned) {
      console.log('[RouteReorder] Grid aligned to the staged store (' + planId + '): ' +
        vansAligned + ' van(s), ' + stopWrites + ' stop write(s), ' + kennelMoves +
        ' kennel move(s), ' + removedMoves + ' removed dog(s) trayed, ' + purged +
        ' stale tile(s) purged.');
    }
    return { vans: vansAligned, stops: stopWrites, kennels: kennelMoves, removed: removedMoves,
      purged: purged, purgeOk: purgeOk, purgeRefused: purgeRefused };
  }

  function buildCard(rec) {
    var card = document.createElement('div');
    card.className = 'reorder-slot';
    card.setAttribute('data-slot', rec.slot_key);
    // Per-van palette hook for the design-system CSS (2026-08-01 redesign).
    card.setAttribute('data-van', String(rec.van).toLowerCase());
    var VAN_NAMES = { BV: 'Big van', BVX: 'Big van X-ray', SV: 'Small van' };
    var vanName = VAN_NAMES[String(rec.van).toUpperCase()] || '';
    var vanCls = 'van-badge--' + String(rec.van).toLowerCase();
    // Child order follows the design: head → kennel board → stop list →
    // Map/Reverse row → map panel → Send. All lookups are class-based, so
    // the order is presentation-only.
    card.innerHTML =
      '<div class="reorder-slot-head">' +
        '<span class="van-badge ' + vanCls + '">' + escapeHtml(rec.van) + '</span>' +
        (vanName ? '<span class="reorder-van-name">' + escapeHtml(vanName) + '</span>' : '') +
        '<span class="reorder-day" hidden></span>' +
        '<span class="reorder-staged-at"></span>' +
        '<span class="reorder-updated-flag" hidden>updated</span>' +
        '<span class="reorder-sent-flag" hidden></span>' +
        '<span class="reorder-skip" hidden></span>' +
      '</div>' +
      '<div class="reorder-kboard" hidden></div>' +
      '<div class="reorder-seq-label">Route sequence</div>' +
      '<ol class="reorder-list"></ol>' +
      '<div class="reorder-note">' +
        '<label class="reorder-note-label">Note to driver<span class="reorder-note-state" hidden></span></label>' +
        '<textarea class="reorder-note-input" maxlength="500" rows="2"' +
          ' placeholder="Optional — shows as an Office note in the driver’s app until they acknowledge it"></textarea>' +
      '</div>' +
      '<div class="reorder-slot-foot">' +
        '<button type="button" class="reorder-mapbtn" title="See this route on a map">🗺 Check on map</button>' +
        '<button type="button" class="reorder-reverse" title="Reverse the stop order">🔁 Reverse order</button>' +
      '</div>' +
      '<div class="reorder-mapwrap" hidden>' +
        '<div class="reorder-map"></div>' +
        '<div class="reorder-mapbar">' +
          '<span class="reorder-maptitle"><span class="van-badge ' + vanCls + '">' + escapeHtml(rec.van) + '</span>' +
            escapeHtml(vanName ? vanName + ' route map' : 'Route map') + '</span>' +
          '<span class="reorder-mapnote"></span>' +
          '<span class="reorder-mapbtns">' +
            '<button type="button" class="reorder-mapfit" title="Zoom to fit the whole route">⤢ Fit</button>' +
            '<button type="button" class="reorder-mapfull" title="Fill the screen">⛶ Full screen</button>' +
          '</span>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="send-route-btn reorder-send">' +
        '<span class="send-route-btn__label">📍 Send Final Route</span></button>';
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
    // OFFICE-NOTE (2026-08-02): free-text note to the driver, persisted as
    // ROUTE_CTX.dm via the C5 saveMessage action (debounced, rev-guarded).
    var noteEl = card.querySelector('.reorder-note-input');
    if (noteEl) noteEl.addEventListener('input', function () {
      var stN = slots[rec.slot_key];
      if (stN) scheduleNoteSave(stN);
    });
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
    if (at) {
      var dep = (rec.ctx && rec.ctx.t) ? ' · departs ' + rec.ctx.t : '';
      at.textContent = 'Staged ' + fmtTime(rec.staged_at) + dep + (rec.last_reordered_by ? ' · edited' : '');
    }
    // OFFICE-NOTE: follow server truth on poll — but never clobber live typing
    // or a save still in flight on this device.
    var noteSync = card.querySelector('.reorder-note-input');
    if (noteSync) {
      var stNote = slots[rec.slot_key];
      var noteBusy = stNote && (stNote.pendingNoteSave || stNote.noteInFlight);
      if (document.activeElement !== noteSync && !noteBusy) {
        var dmNow = String((rec.ctx && rec.ctx.dm) || '');
        if (noteSync.value !== dmNow) noteSync.value = dmNow;
      }
    }
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
    // A one-stop run used to render NO grip (there was nothing to reorder within
    // it). Since 2026-07-20 a tile can also be dragged to another van's run in
    // the same section, so the grip is always rendered — otherwise a lone dog
    // would be the one dog you could never move. Dragging a solo tile within its
    // own list is still a harmless no-op.
    var solo = o.length < 2;
    // Per-tile address line + Map Check (2026-07-19): the routed address per
    // member (ctx.ad, ex wins). Empty for routes staged before the rollout.
    var addrIdx = addrIndexFor(ctx);
    st.stopsById = {};
    o.forEach(function (members, i) {
      members = members || [];
      var id = 's' + i;
      st.stopsById[id] = members;
      var isGroom = members.some(function (m) { return gg[normNm(m)]; });
      var isAlt = members.some(function (m) { return aa[normNm(m)]; });
      var marks = (isGroom ? '✂️' : '') + (isAlt ? '📍' : '');
      // "Same house" pill (design): two dogs sharing one stop.
      var dogCount = members.filter(function (m) { return !isSalonName(m); }).length;
      var li = document.createElement('li');
      li.className = 'reorder-tile' + (solo ? ' reorder-tile--solo' : '');
      li.setAttribute('data-stop-id', id);
      li.innerHTML =
        '<span class="reorder-pos">' + (i + 1) + '</span>' +
        '<span class="reorder-grip" aria-hidden="true">⠿</span>' +
        '<span class="reorder-main"><span class="reorder-name"></span>' +
          '<span class="reorder-addr" hidden></span></span>' +
        '<span class="reorder-marks">' + marks + '</span>' +
        (dogCount > 1 ? '<span class="reorder-share">Same house</span>' : '') +
        '<span class="reorder-kennels"></span>' +
        '<button type="button" class="reorder-up" title="Move stop earlier" aria-label="Move stop earlier">▲</button>' +
        '<button type="button" class="reorder-down" title="Move stop later" aria-label="Move stop later">▼</button>' +
        '<button type="button" class="reorder-del" title="Remove from route" aria-label="Remove from route">✕</button>';
      var nameEl = li.querySelector('.reorder-name');
      nameEl.textContent = members.join(' & ') || '—';
      nameEl.title = members.join(' & ');
      // Address in small text under the name (textContent — address strings are
      // free text and must never be interpolated into innerHTML). Hidden when
      // this stop has no staged address (pre-rollout stage) — never "undefined".
      var addrEl = li.querySelector('.reorder-addr');
      var addrText = stopAddr(members, addrIdx);
      if (addrEl && addrText) {
        addrEl.textContent = addrText;
        addrEl.title = addrText;
        addrEl.hidden = false;
      }
      // ✕ removes this stop. Drag only ever starts on the .reorder-grip handle, so a
      // plain click here can't begin a drag (no pointerdown on the tile body).
      var delBtn = li.querySelector('.reorder-del');
      if (delBtn) delBtn.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        removeStop(st, id);
      });
      // ▲/▼ arrow reordering (2026-08-01 design): moves the li in the DOM and
      // persists through the SAME renumber → syncMap → refreshKennelUi →
      // scheduleSave path as a grip-drag / Reverse. DOM order stays the truth.
      var upBtn = li.querySelector('.reorder-up');
      if (upBtn) upBtn.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        moveStopBy(st, li, -1);
      });
      var downBtn = li.querySelector('.reorder-down');
      if (downBtn) downBtn.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        moveStopBy(st, li, 1);
      });
      ol.appendChild(li);
      // The Grooming Salon is derived state, not a dog: it belongs to whichever
      // runs carry grooming dogs, so it must not be dragged between vans (the
      // server refuses it too). It stays reorderable WITHIN its own run — where
      // it sits in the route is exactly what staff need to adjust.
      wireGrip(st, li.querySelector('.reorder-grip'), members.every(isSalonName));
    });
    renumber(ol);   // sets the ▲/▼ end-of-list disabled states on first render
    // Tiles were rebuilt (fresh stage, a remote reorder, or a failed-save rollback)
    // — an open map must follow. No-op when the map is closed.
    syncMap(st);
    // Kennel dropdowns need the WHOLE tile list (occupant hints), so they are
    // populated here, after the loop — along with the van mockup above the stops.
    refreshKennelUi(st);
  }

  function currentOrderIds(ol) {
    return [].slice.call(ol.querySelectorAll('.reorder-tile')).map(function (li) {
      return li.getAttribute('data-stop-id');
    });
  }
  function renumber(ol) {
    var tiles = [].slice.call(ol.querySelectorAll('.reorder-tile'));
    tiles.forEach(function (li, i) {
      var pos = li.querySelector('.reorder-pos');
      if (pos) pos.textContent = i + 1;
      // ▲/▼ end-of-list states ride every renumber (drag, arrows, Reverse, ✕).
      var up = li.querySelector('.reorder-up');
      var down = li.querySelector('.reorder-down');
      if (up) up.disabled = (i === 0);
      if (down) down.disabled = (i === tiles.length - 1);
    });
  }

  // ▲/▼ arrow move — mirrors reverseRoute's persistence path exactly.
  function moveStopBy(st, li, dir) {
    if (!st || st.dragging) return;
    var ol = li.parentNode;
    if (!ol) return;
    if (dir < 0) {
      var prev = li.previousElementSibling;
      if (!prev) return;
      ol.insertBefore(li, prev);
    } else {
      var next = li.nextElementSibling;
      if (!next) return;
      ol.insertBefore(next, li);
    }
    renumber(ol);
    syncMap(st);            // map follows the new order immediately
    refreshKennelUi(st);    // mockup stop numbers follow too
    scheduleSave(st);
  }

  // ---- vertical grip-drag engine (pointer events) ---------------
  // The Grooming Salon calling point — must stay byte-identical to
  // grooming-feature/feed_core.js GF.SALON.label and the Apps Script's
  // REORDER_SALON.label.
  var SALON_LABEL = 'Grooming Salon';
  function isSalonName(n) { return normKey(n) === normKey(SALON_LABEL); }

  // ownRunOnly: the tile may be reordered inside its own list but never dropped
  // onto another van's run.
  function wireGrip(st, grip, ownRunOnly) {
    if (!grip) return;
    grip.addEventListener('pointerdown', function (e) { startDrag(st, grip, e, ownRunOnly); });
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

  // The card (slot) whose box contains the pointer, or null. Cards never nest, so
  // the first hit is the answer. A card mid-removal is not a drop target.
  function slotUnderPointer(x, y) {
    var hit = null;
    Object.keys(slots).forEach(function (k) {
      var s = slots[k];
      if (hit || !s || !s.card || !s.record || s.staleRemove) return;
      if (s.card.hidden || !s.card.offsetParent) return;
      var r = s.card.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hit = s;
    });
    return hit;
  }

  function clearDropMarks() {
    [].slice.call(document.querySelectorAll(
      '.reorder-slot.is-drop-target, .reorder-slot.is-drop-blocked, .reorder-slot.is-drop-source'
    )).forEach(function (el) {
      el.classList.remove('is-drop-target', 'is-drop-blocked', 'is-drop-source');
    });
  }

  function startDrag(st, grip, e, ownRunOnly) {
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
      st: st,                 // source slot
      srcOl: ol,              // source list
      ol: ol,                 // list currently holding the placeholder
      targetSt: st,           // slot the placeholder currently sits in
      // Member names identify the stop across the wire — tile ids are positional
      // ('s0','s1',…) and are regenerated on every render.
      members: (st.stopsById && st.stopsById[li.getAttribute('data-stop-id')]) || [],
      section: st.record && st.record.section,
      ownRunOnly: !!ownRunOnly,
      li: li, clone: clone, placeholder: placeholder,
      offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top
    };
    st.card.classList.add('is-drop-source');
    document.addEventListener('pointermove', onDragMove, true);
    document.addEventListener('pointerup', onDragEnd, true);
    // pointercancel is an ABORT, not a drop. Before cross-van moves both went to
    // onDragEnd harmlessly (the tile could only land back in its own list); now
    // a cancel would COMMIT a move the user never completed — iOS fires
    // pointercancel on a scroll/gesture takeover, and exit() calls the same
    // teardown when the tab is switched mid-drag.
    document.addEventListener('pointercancel', onDragCancel, true);
  }

  function unbindDrag() {
    document.removeEventListener('pointermove', onDragMove, true);
    document.removeEventListener('pointerup', onDragEnd, true);
    document.removeEventListener('pointercancel', onDragCancel, true);
  }

  // Abort: put the tile back where it came from and send NOTHING.
  function onDragCancel() {
    if (!drag) return;
    unbindDrag();
    var d = drag; drag = null;
    clearDropMarks();
    if (d.placeholder.parentNode) d.placeholder.parentNode.removeChild(d.placeholder);
    if (d.clone.parentNode) d.clone.parentNode.removeChild(d.clone);
    if (d.li.parentNode) d.li.parentNode.removeChild(d.li);
    var src = d.st, dst = d.targetSt || d.st;
    src.dragging = false;
    if (dst !== src) dst.dragging = false;
    // Re-render from the last known-good records, so both cards are exactly as
    // they were before the drag started.
    if (!src.staleRemove && src.record) renderTiles(src, src.record);
    if (dst !== src && !dst.staleRemove && dst.record) renderTiles(dst, dst.record);
  }

  function onDragMove(e) {
    if (!drag) return;
    e.preventDefault();
    drag.clone.style.left = (e.clientX - drag.offsetX) + 'px';
    drag.clone.style.top = (e.clientY - drag.offsetY) + 'px';

    // Cross-van move (2026-07-20): the placeholder follows the pointer INTO
    // another run's list when that run is in the same section. Over a
    // different-section card the placeholder stays where it is and the card is
    // marked refused, so releasing there is a no-op rather than a surprise move.
    var over = slotUnderPointer(e.clientX, e.clientY);
    var dest = drag.targetSt;
    var blocked = null;
    if (over && over !== drag.st) {
      // ownRunOnly (the salon stop) can be reordered in place but never dropped
      // on another van — every foreign card reads as refused.
      if (drag.ownRunOnly) blocked = over;
      else if (over.record.section === drag.section) dest = over;
      else blocked = over;
    } else if (over === drag.st) {
      dest = drag.st;
    }

    var destOl = dest.card.querySelector('.reorder-list');
    if (destOl) {
      if (destOl !== drag.ol) {
        // Leaving one list for another. The slot holding the placeholder MUST be
        // marked dragging: reconcile refreshes any slot that is not
        // (`!st.dragging && !st.pendingSave`), and renderTiles wipes the list —
        // which would delete the placeholder from under the drag and leave the
        // tile planted in the wrong card on drop. The source keeps its flag for
        // the whole drag; a card merely passed over must NOT be left frozen.
        var leftOl = drag.ol;
        var leftSt = drag.targetSt;
        if (leftSt && leftSt !== drag.st) leftSt.dragging = false;
        if (dest !== drag.st) dest.dragging = true;
        drag.ol = destOl;
        drag.targetSt = dest;
        if (leftOl && leftOl.contains(drag.placeholder)) leftOl.removeChild(drag.placeholder);
        renumber(leftOl);
      }
      var ref = tileAfterPointer(destOl, e.clientY);
      destOl.insertBefore(drag.placeholder, ref);
    }

    clearDropMarks();
    drag.st.card.classList.add('is-drop-source');
    // Releasing over a refused card must CANCEL, not fall back to whichever run
    // the pointer happened to cross on the way there — cards sit side by side, so
    // a drag aimed at another section always passes over a valid one first, and
    // that silently moved the dog to the wrong van (caught in testing 2026-07-20).
    drag.blocked = !!blocked;
    if (blocked) blocked.card.classList.add('is-drop-blocked');
    else if (drag.targetSt !== drag.st) drag.targetSt.card.classList.add('is-drop-target');
    autoScroll(e.clientY);
  }

  function onDragEnd() {
    if (!drag) return;
    unbindDrag();
    var d = drag; drag = null;
    clearDropMarks();

    // A card can be cleared/re-staged elsewhere mid-drag. The tile must NOT be
    // planted into a list belonging to a card that is going away (or that the
    // drag no longer owns) — it would sit there aliasing an unrelated stop's
    // positional id until the next render, and a save or Send Final in that
    // window would duplicate one dog and drop another.
    var staleEnd = d.st.staleRemove || (d.targetSt !== d.st && d.targetSt.staleRemove);
    if (staleEnd || d.placeholder.parentNode !== d.ol) {
      if (d.placeholder.parentNode) d.placeholder.parentNode.removeChild(d.placeholder);
      if (d.clone.parentNode) d.clone.parentNode.removeChild(d.clone);
      if (d.li.parentNode) d.li.parentNode.removeChild(d.li);
      d.st.dragging = false;
      if (d.targetSt !== d.st) d.targetSt.dragging = false;
      if (d.st.staleRemove) { removeCard(d.st); toast('That route was cleared elsewhere', 'info'); }
      else if (d.st.record) renderTiles(d.st, d.st.record);
      if (d.targetSt !== d.st) {
        if (d.targetSt.staleRemove) removeCard(d.targetSt);
        else if (d.targetSt.record) renderTiles(d.targetSt, d.targetSt.record);
      }
      return;
    }

    d.ol.insertBefore(d.li, d.placeholder);
    if (d.placeholder.parentNode) d.placeholder.parentNode.removeChild(d.placeholder);
    if (d.clone.parentNode) d.clone.parentNode.removeChild(d.clone);
    renumber(d.ol);
    if (d.srcOl !== d.ol) renumber(d.srcOl);

    var src = d.st;
    var dst = d.targetSt || src;
    src.dragging = false;
    if (dst !== src) dst.dragging = false;

    // Released over a different-section run — cancel outright. Both cards are
    // re-rendered from their last known-good records, so the tile snaps back to
    // exactly where it started and nothing is sent to the server.
    if (d.blocked) {
      renderTiles(src, src.record);
      if (dst !== src) renderTiles(dst, dst.record);
      toast(d.ownRunOnly
        ? 'The 🏪 Grooming Salon stop follows the grooming dogs — move a dog and the salon comes with it'
        : 'A dog can only move between vans in the same run — not to another section', 'warning');
      return;
    }

    if (dst === src) {
      syncMap(src);           // map follows the dropped order immediately
      refreshKennelUi(src);   // mockup stop numbers follow too
      scheduleSave(src);
      return;
    }
    // Dropped onto another van's run in the same section.
    commitMove(src, dst, d.members, d.li);
  }

  // ---- cross-van move (2026-07-20) ------------------------------------------
  // The DOM already shows the move (the tile is sitting in the target list). Both
  // runs are persisted in ONE server call so the dog can never end up on both
  // runs or on neither — see moveStop_ in the Apps Script. On any failure both
  // cards are re-rendered from their last known-good records, which puts the tile
  // straight back where it came from.
  function commitMove(src, dst, members, movedLi) {
    var srcOl = src.card && src.card.querySelector('.reorder-list');
    var dstOl = dst.card && dst.card.querySelector('.reorder-list');
    if (!srcOl || !dstOl) { rollback(src); rollback(dst); return; }

    // A debounced save on either card would race this write with a now-stale
    // order — the move payload carries both full orders, so drop them.
    [src, dst].forEach(function (s) {
      if (s.saveTimer) { clearTimeout(s.saveTimer); s.saveTimer = null; }
      s.pendingSave = true;
      var sf = s.card && s.card.querySelector('.reorder-sent-flag');
      if (sf) sf.hidden = true;   // both routes changed since their last send
    });

    // Build both resulting orders from what the user is actually looking at.
    // Tiles are matched by ELEMENT, never by data-stop-id: ids are positional
    // ('s0','s1',…) and scoped to their own card, so the tile that just arrived
    // carries the SOURCE run's id and would collide with an unrelated stop of
    // the same index in the target (that collision duplicated one dog and
    // dropped another — caught in browser testing 2026-07-20).
    var tilesOf = function (ol) { return [].slice.call(ol.querySelectorAll('.reorder-tile')); };
    var fromO = tilesOf(srcOl).map(function (li) {
      return src.stopsById[li.getAttribute('data-stop-id')];
    });
    var toO = tilesOf(dstOl).map(function (li) {
      if (li === movedLi) return members;      // the tile that just arrived
      return dst.stopsById[li.getAttribute('data-stop-id')];
    });

    // A hole here would silently drop a dog from a route, so refuse to send.
    if (fromO.some(function (m) { return !m; }) || toO.some(function (m) { return !m; })) {
      src.pendingSave = false; dst.pendingSave = false;
      rollback(src); rollback(dst);
      toast('Could not move — route out of sync, reverted', 'error');
      return;
    }

    // The destination's DOM now holds a tile whose positional id belongs to the
    // SOURCE card, so dst.stopsById disagrees with the DOM until renderTiles
    // runs after the POST resolves. Re-stamp both now so anything reading the
    // card mid-flight (a save, Send Final, a map redraw) sees a consistent map.
    dst.stopsById = {};
    tilesOf(dstOl).forEach(function (li, i) {
      var id = 's' + i;
      li.setAttribute('data-stop-id', id);
      dst.stopsById[id] = toO[i];
    });
    src.stopsById = {};
    tilesOf(srcOl).forEach(function (li, i) {
      var id = 's' + i;
      li.setAttribute('data-stop-id', id);
      src.stopsById[id] = fromO[i];
    });

    syncMap(src);
    syncMap(dst);
    // Both mockups follow at once. The moved dog still shows its OLD van's code
    // from the stale local ctx for a beat — the server DROPS kp on a cross-van
    // move (owner decision 2026-07-20: the code names a kennel in the van the
    // dog is leaving), so the renderTiles below adopts it as unassigned and
    // staff give it a kennel in the NEW van via its dropdown.
    refreshKennelUi(src);
    refreshKennelUi(dst);

    // A kennel or driver-note POST in flight on EITHER card bumps that card's
    // rev, so a moveStop fired across it arrives with a stale from_rev/to_rev,
    // the server refuses it, and the rollback below snaps the dog back to the
    // van it came from (2026-08-03, the cross-van face of the S2 bug — the same
    // collision that made a plain reorder undo itself). Wait for the in-flight
    // write to land and adopt its rev first.
    //   Defer on IN-FLIGHT flags ONLY, never on pendingKpSave/pendingNoteSave:
    // both savers yield to pendingSave, which is already true on both cards
    // here, so waiting on their un-sent debounces would deadlock. An in-flight
    // POST always settles (both .then and .catch clear its flag), so this
    // always drains.
    var fire = function () {
      if (src.kpInFlight || src.noteInFlight || dst.kpInFlight || dst.noteInFlight) {
        setTimeout(fire, 400);
        return;
      }
      postStore({
      action: 'moveStop', token: TOKEN,
      from_slot_key: src.record.slot_key, to_slot_key: dst.record.slot_key,
      from_rev: src.record.rev, to_rev: dst.record.rev,
      members: members, from_o: fromO, to_o: toO,
      last_reordered_by: deviceId()
    }).then(function (r) {
      src.pendingSave = false; dst.pendingSave = false;
      if (!r || !r.ok) {
        rollback(src); rollback(dst);
        // A `busy` refusal (#41 fix 3) is the one error here that is nobody's
        // mistake and is worth retrying by hand; postStore has already retried
        // it once. Everything else keeps the server's own wording.
        toast(
          (r && r.retryable)
            ? 'The staging store is busy — the move was not saved. Try again in a moment.'
            : ((r && r.error) ? ('Could not move — ' + r.error) : 'Could not move — reverted'),
          (r && r.retryable) ? 'warning' : 'error');
        return;
      }
      // Adopt the orders the SERVER actually stored — it may have added or
      // removed the Grooming Salon calling point, so the client's optimistic
      // order is not the last word.
      // Adopt the server's STORED context wholesale. The move migrated per-dog
      // data this client has never held (the moved dog's coords/address, and the
      // salon's), so taking only the order would leave the tile with no address
      // and the map with no point for it until some later poll happened to
      // re-render. r.to_ctx makes the response self-sufficient; the order-only
      // fallback keeps an older server working.
      if (r.to_ctx) dst.record.ctx = r.to_ctx;
      else dst.record.ctx.o = Array.isArray(r.to_o) ? r.to_o : toO;
      if (r.to_rev != null) { dst.record.rev = r.to_rev; dst.renderedRev = r.to_rev; }
      renderTiles(dst, dst.record);
      if (r.from_cleared) {
        // The dog was the source run's last stop, so that run is gone.
        removeCard(src);
      } else {
        if (r.from_ctx) src.record.ctx = r.from_ctx;
        else src.record.ctx.o = Array.isArray(r.from_o) ? r.from_o : fromO;
        if (r.from_rev != null) { src.record.rev = r.from_rev; src.renderedRev = r.from_rev; }
        renderTiles(src, src.record);
      }

      var msg = (members.join(' & ') || 'Stop') + ' moved to ' + dst.record.van;
      if (r.salon_added) msg += ' · 🏪 Grooming Salon added to ' + dst.record.van + ' — check its position';
      toast(msg, r.salon_added ? 'warning' : 'success');
    }).catch(function () {
      src.pendingSave = false; dst.pendingSave = false;
      rollback(src); rollback(dst);
      toast('Could not move — reverted', 'error');
    });
    };
    fire();
  }

  // ---- save (debounced, optimistic, rollback) -------------------
  function scheduleSave(st) {
    st.pendingSave = true;
    st.orderSaveFailed = false;
    var sf = st.card && st.card.querySelector('.reorder-sent-flag');
    if (sf) sf.hidden = true;          // route changed since the last send → drop the "sent" flag
    if (st.saveTimer) clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(function () { doSave(st); }, SAVE_DEBOUNCE_MS);
  }
  function doSave(st) {
    if (st.orderInFlight) return;
    if (st.kpInFlight || st.noteInFlight) {
      // A kennel-positions or driver-note POST is mid-air; all three writes bump
      // the SAME rev, so let it land and adopt its rev first (a note POST that
      // lands second would otherwise make THIS save refuse as stale → visible
      // undo / ✕-delete re-add, the 2026-08-03 S2 bug). Defer to IN-FLIGHT
      // posts only, never to pending debounces (doKpSave/doNoteSave wait on
      // pendingSave) — never both ways, or they would defer forever.
      if (st.saveTimer) clearTimeout(st.saveTimer);
      st.saveTimer = setTimeout(function () { doSave(st); }, 400);
      return;
    }
    var ol = st.card.querySelector('.reorder-list');
    var ids = currentOrderIds(ol);
    var o = ids.map(function (id) { return st.stopsById[id]; });
    // `rev` added 2026-07-20: the server now refuses a save whose rev is stale
    // or whose membership differs from the stored route, so a plain reorder can
    // no longer silently undo a cross-van move made on another device.
    st.orderInFlight = true;
    st.saveTimer = null;
    return postStore({ action: 'saveOrder', token: TOKEN, slot_key: st.record.slot_key, o: o,
                rev: st.record.rev, last_reordered_by: deviceId() })
      .then(function (r) {
        st.orderInFlight = false;
        st.pendingSave = false;
        if (r && r.ok) {
          st.orderSaveFailed = false;
          st.record.ctx.o = o;
          // record.rev is the optimistic-concurrency token a later move sends.
          // Leaving it stale here made the NEXT cross-van move fail as
          // "changed elsewhere" after any ordinary reorder.
          if (r.rev != null) { st.record.rev = r.rev; st.renderedRev = r.rev; }
        } else if (r && r.stale) {
          st.orderSaveFailed = true;
          markReorderSaveFailure(st);
          rollback(st);
          toast('That route changed on another device — reloaded', 'warning');
          poll();
        } else if (r && r.retryable) {
          st.orderSaveFailed = true;
          markReorderSaveFailure(st);
          // postStore already retried this once. The store is genuinely busy, so
          // the edit is reverted as before — but say WHY, because "could not
          // save" sent staff hunting for a dog-name problem on 2026-08-03.
          rollback(st);
          toast('The staging store is busy — the new order was not saved. Try again in a moment.', 'warning');
        } else {
          st.orderSaveFailed = true;
          markReorderSaveFailure(st);
          rollback(st);
          toast('Could not save order — reverted', 'error');
        }
      })
      .catch(function () {
        st.orderInFlight = false;
        st.pendingSave = false;
        st.orderSaveFailed = true;
        markReorderSaveFailure(st);
        rollback(st);
        toast('Could not save order — reverted', 'error');
      });
  }
  function markReorderSaveFailure(st) {
    st.saveFailureSeq = Number(st.saveFailureSeq || 0) + 1;
  }
  function rollback(st) {
    st.orderSaveFailed = false;
    st.kpSaveFailed = false;
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
    refreshKennelUi(st);              // the dog vacates its kennel in the mockup too
    scheduleSave(st);                 // saves the shortened ctx.o; server keeps the slot STAGED
  }

  // Clear one slot server-side (status CLEARED) and drop its card on confirmed ok.
  function clearOneSlot(st, reason) {
    if (!st || !st.record) return;
    var slotKey = st.record.slot_key;
    st.pendingSave = true;            // keep the poll/reconcile off this slot mid-clear
    if (st.saveTimer) { clearTimeout(st.saveTimer); st.saveTimer = null; }
    if (st.kpSaveTimer) { clearTimeout(st.kpSaveTimer); st.kpSaveTimer = null; }
    st.pendingKpSave = false;         // a queued kennel save must not fire at a cleared slot
    // Same for the driver note (2026-08-03): without this a queued note save
    // POSTs at a slot that no longer exists, and — because the reconcile guards
    // now also watch pendingNoteSave — a note left pending would pin this slot
    // out of reconcile permanently. doNoteSave's defer loop self-reschedules, so
    // the timer must be cleared as well as the flag.
    if (st.noteSaveTimer) { clearTimeout(st.noteSaveTimer); st.noteSaveTimer = null; }
    st.pendingNoteSave = false;
    postStore({ action: 'clearSlot', token: TOKEN, slot_key: slotKey })
      .then(function (r) {
        if (r && r.ok) {
          removeCard(st);
          toast(vanFromKey(slotKey) + ' ' + (reason || 'route cleared'), 'info');
        } else if (r && r.retryable) {
          // busy store; postStore already retried. The slot is untouched, so the
          // card correctly stays where it is.
          st.pendingSave = false;
          toast('The staging store is busy — the route was not cleared. Try again in a moment.', 'warning');
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

  // Force every queued order/kennel/note debounce through the existing saver
  // functions and wait for their bounded network calls to settle. The final
  // payload is built only after this promise resolves, so ctx.o/ctx.kp and the
  // visible route cannot diverge at the Send Final boundary.
  function flushPendingReorderSaves(sendingSlotKey) {
    return new Promise(function (resolve, reject) {
      var sending = slots[sendingSlotKey];
      var failureSeqAtStart = sending ? Number(sending.saveFailureSeq || 0) : 0;
      function step() {
        var waiting = false;
        Object.keys(slots).forEach(function (key) {
          var st = slots[key];
          if (!st) return;
          if (st.pendingSave && !st.orderInFlight && !st.kpInFlight && !st.noteInFlight) {
            if (st.saveTimer) { clearTimeout(st.saveTimer); st.saveTimer = null; }
            doSave(st);
          } else if (st.pendingKpSave && !st.kpInFlight && !st.pendingSave && !st.noteInFlight) {
            if (st.kpSaveTimer) { clearTimeout(st.kpSaveTimer); st.kpSaveTimer = null; }
            doKpSave(st);
          } else if (st.pendingNoteSave && !st.noteInFlight && !st.pendingSave && !st.pendingKpSave && !st.kpInFlight) {
            if (st.noteSaveTimer) { clearTimeout(st.noteSaveTimer); st.noteSaveTimer = null; }
            doNoteSave(st);
          }
          if (st.pendingSave || st.pendingKpSave || st.pendingNoteSave ||
              st.orderInFlight || st.kpInFlight || st.noteInFlight) waiting = true;
        });
        if (waiting) {
          setTimeout(step, 25);
        } else {
          var failed = sending && Number(sending.saveFailureSeq || 0) !== failureSeqAtStart;
          if (failed) reject(new Error('pending reorder changes were not saved'));
          else resolve();
        }
      }
      step();
    });
  }

  // Best-effort pin seam. A failed photograph cannot retroactively fail a
  // Telegram send that has already returned ok.
  function autoPinAfterSend(planId, deps) {
    deps = deps || {};
    try {
      var snapshot = typeof deps.getState === 'function' ? deps.getState() : {};
      var payload = { action: 'savePlan', planId: planId, state: snapshot, source: 'final-send' };
      function attempt() {
        return Promise.resolve().then(function () { return deps.postPlan(payload); });
      }
      return attempt().catch(function () { return attempt(); }).then(function () {
        return { pinned: true };
      }).catch(function () { return { pinned: false }; });
    } catch (e) { return Promise.resolve({ pinned: false }); }
  }

  function overlayRestoreFailed(outcome) {
    return !outcome || outcome.ok !== true || !outcome.result || outcome.result.vans === 0;
  }

  function announceOverlayOutcome(outcome, toastFn) {
    if (!overlayRestoreFailed(outcome)) return false;
    try {
      toastFn('Load Plan NOT re-aligned — check the grid, then use Stage Route or Send Final.', 'error');
    } catch (e) { /* the warning must never fail a completed send */ }
    return true;
  }

  // ⚠️ MIRROR RULE (2026-07-11): the VAN-ETA driver app (fulldayplan repo,
  // drive/index.html, queuePayload()) carries a faithful PORT of this payload
  // build so drivers can send-and-open a staged route themselves. Any change to
  // the payload contract below must be applied there too.
  function sendFinal(slotKey) {
    var st = slots[slotKey];
    if (!st) return;
    var btn = st.card.querySelector('.reorder-send');
    if (!btn || btn.disabled) return;
    if (st.finalFlushInFlight) return;
    st.finalFlushInFlight = true;
    return flushPendingReorderSaves(slotKey).then(function () {
    var ctx = st.record.ctx || {};
    var ol = st.card.querySelector('.reorder-list');
    var o = currentOrderIds(ol).map(function (id) { return st.stopsById[id]; });
    var dogs = flattenWithMarkers(o, ctx.gg || [], ctx.aa || []);
    if (!dogs.length) { toast('Nothing to send', 'error'); return; }

    // Staging-tray guard (2026-07-19): dogs left in the Load Plan's staging
    // tray ride NO route, and the tray is hidden (display:none) while this
    // tab is open — so ask before committing the send. Plan-matched via the
    // slot's period (NEXT_AM slots → the Next Day AM plan; PM + Half-Day
    // slots → the PM plan), read from the page's saved plan snapshot so the
    // currently-loaded plan tab doesn't matter. Errors never block the send.
    try {
      if (window.RouteSender && window.RouteSender.getTrayDogsForPlan) {
        var trayPlan = (String(ctx.p || '').toUpperCase() === 'NEXT_AM') ? 'NEXT_AM' : 'PM';
        var trayDogs = window.RouteSender.getTrayDogsForPlan(trayPlan);
        if (trayDogs.length) {
          var trayMsg = '🔴 ' + trayDogs.length + ' dog' + (trayDogs.length === 1 ? '' : 's') +
            ' still in the Load Plan staging tray (on no route):\n' + trayDogs.join(', ') +
            '\n\nSend this route anyway?';
          if (!window.confirm(trayMsg)) return;
        }
      }
    } catch (e) { /* nudge only — never block a send on error */ }

    // Kennel guard (2026-07-31): the mockup's positions are the FINAL van
    // spots, so warn — never block — when dogs are still unassigned (owner
    // decision: warn-don't-block, mirroring the staging-tray nudge above).
    // The payload itself is untouched: ctx.kp rides as `positions` exactly as
    // before, and an unassigned dog simply renders no code in Telegram.
    try {
      var kr = kennelRoster(st);
      if (kr) {
        var unassigned = kr.dogs.filter(function (d) { return !d.code; }).map(function (d) { return d.name; });
        if (unassigned.length) {
          var kMsg = '📦 ' + unassigned.length + ' dog' + (unassigned.length === 1 ? ' has' : 's have') +
            ' no kennel position:\n' + unassigned.join(', ') +
            '\n\nSend this route anyway?';
          if (!window.confirm(kMsg)) return;
        }
      }
    } catch (e2) { /* nudge only — never block a send on error */ }

    // P5c (2026-07-17): delegate the payload-object CONSTRUCTION to the shared
    // FT_PAYLOAD module when it has loaded (shared/ft-payload.js) — one payload
    // rule, one source. Only the object build is delegated; the surrounding
    // flow (button state, currentOrderIds read, postN8n, toasts, card marking)
    // is untouched. The staged ctx.o is overridden with the CURRENT drag order
    // o read from the DOM above — the send must reflect what staff see, not
    // the staged order. The original construction below is kept VERBATIM as
    // the fallback and runs whenever the module is missing or built nothing.
    // OFFICE-NOTE (2026-08-02): the send reflects what staff SEE — the note
    // textarea's current text wins over the (possibly still-debouncing) staged
    // ctx.dm, exactly as the DOM drag order o overrides ctx.o below.
    var noteNow = (function () {
      var el = st.card.querySelector('.reorder-note-input');
      return el ? String(el.value || '') : String(ctx.dm || '');
    })();
    var payload = null;
    if (typeof window !== 'undefined' && window.FT_PAYLOAD && FT_PAYLOAD.buildFinal) {
      var dctx = {};
      Object.keys(ctx).forEach(function (k) { dctx[k] = ctx[k]; });
      dctx.o = o;
      dctx.dm = noteNow;
      payload = FT_PAYLOAD.buildFinal(dctx, { nowIso: new Date().toISOString() });
    }
    if (!payload) {
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

    // OFFICE-NOTE (2026-08-02): the Reorder tab's note to the driver rides the
    // FINAL send only; key ABSENT when empty. noteNow = the textarea's current
    // text (falls back to ctx.dm). Mirrors FT_PAYLOAD.buildFinal — keep in step.
    var dm = String(noteNow || '').trim();
    if (dm) payload.driver_message = dm.slice(0, 500);
    } // P5c: end of the verbatim fallback construction (a module-built payload skips it)

    setBtn(btn, 'sending');
    return postN8n(payload).then(function (res) {
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
      // Align this device's Load Plan grid with what was just sent (store →
      // grid, 2026-08-02). Self-guards: applyKennelFromReorder /
      // applyReturnedStops skip when the sent slot's plan isn't the loaded
      // one — the next plan load overlays it then.
      var sentPlan = (st.record && st.record.section === 'NEXT_AM') ? 'NEXT_AM' : 'PM';
      try {
        if (window.VanPlanSync && window.VanPlanSync.preparePlanForFinalSync) {
          window.VanPlanSync.preparePlanForFinalSync(sentPlan);
        }
      } catch (prepareErr) { /* redraw remains best-effort */ }
      return Promise.resolve().then(function () {
        return overlayFromStore(sentPlan, { rebuild: true });
      }).catch(function () {
        return { ok: false, reason: 'store-error' };
      }).then(function (overlayOutcome) {
        try {
          announceOverlayOutcome(overlayOutcome, toast);
        } catch (overlayToastErr) { /* warning remains best-effort */ }
        return autoPinAfterSend(sentPlan, {
          getState: function () {
            return window.VanPlanSync && window.VanPlanSync.getPlanState
              ? window.VanPlanSync.getPlanState(sentPlan) : {};
          },
          postPlan: function (pinPayload) {
            return fetch(REORDER_URL, {
              method: 'POST', body: JSON.stringify(pinPayload), redirect: 'follow'
            }).then(function (pinRes) {
              if (!pinRes.ok) throw new Error('pin responded ' + pinRes.status);
              return pinRes.text();
            }).then(function (pinText) {
              if (!pinText || /^Error\b/i.test(pinText)) throw new Error(pinText || 'empty pin response');
              return pinText;
            });
          }
        });
      }).then(function (pinResult) {
        try {
          if (pinResult && pinResult.pinned && window.VanPlanSync &&
              window.VanPlanSync.refreshPinWitness) {
            Promise.resolve(window.VanPlanSync.refreshPinWitness(sentPlan))
              .catch(function () { return null; });
          }
        } catch (witnessErr) {}
        if (!pinResult || pinResult.pinned !== true) {
          try {
            toast('Final plan NOT saved to cloud — other devices will not see it. It will publish on the next Stage or Send Final press.', 'error');
          } catch (pinToastErr) {}
        }
        setTimeout(function () { if (slots[slotKey]) setBtn(btn, 'idle'); }, SENT_RESET_MS);
      });
    }).catch(function () {
      setBtn(btn, 'failed');
      setTimeout(function () { setBtn(btn, 'idle'); }, 4000);
      toast('Send failed — route kept, retry', 'error');
    });
    }).catch(function () {
      setBtn(btn, 'failed');
      setTimeout(function () { if (slots[slotKey]) setBtn(btn, 'idle'); }, 4000);
      toast('Pending route changes could not be saved — route not sent', 'error');
    }).finally(function () { st.finalFlushInFlight = false; });
  }

  // ---- reconcile (poll) -----------------------------------------
  function removeCard(st) {
    if (st.record) cleared[st.record.slot_key] = Date.now();   // tombstone: block a stale in-flight poll re-adding this card
    if (st.kpSaveTimer) { clearTimeout(st.kpSaveTimer); st.kpSaveTimer = null; }
    st.pendingKpSave = false;                                  // a queued kennel save must not fire for a removed card
    if (st.noteSaveTimer) { clearTimeout(st.noteSaveTimer); st.noteSaveTimer = null; }
    st.pendingNoteSave = false;                                // ditto the driver note (2026-08-03) — see clearOneSlot
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
      // Per-section footer note naming vans with nothing staged (Kam 2026-08-02:
      // note only — no dimmed placeholder cards; three sections would triple them).
      var note = document.querySelector('.reorder-section-note[data-section="' + sec.key + '"]');
      if (!note && mount && mount.parentNode) {
        note = document.createElement('div');
        note.className = 'reorder-section-note';
        note.setAttribute('data-section', sec.key);
        mount.parentNode.appendChild(note);
      }
      if (note) {
        if (!has) { note.hidden = true; }
        else {
          var staged = {};
          Array.prototype.forEach.call(mount.children, function (c) {
            var v = (c.getAttribute('data-van') || '').toUpperCase();
            if (v) staged[v] = true;
          });
          var missing = VAN_ORDER.filter(function (v) { return !staged[v]; });
          note.hidden = false;
          note.textContent = missing.length
            ? missing.join(' and ') + (missing.length === 1 ? ' has' : ' have') + ' no staged route yet'
            : 'All three routes are staged';
        }
      }
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
      if (st.dragging || st.pendingSave || st.pendingKpSave || st.pendingNoteSave || st.noteInFlight) { st.staleRemove = true; return; }
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
            dragging: false, pendingSave: false, saveTimer: null, orderInFlight: false,
            orderSaveFailed: false, kpSaveFailed: false, saveFailureSeq: 0, staleRemove: false,
            pendingKpSave: false, kpSaveTimer: null, kpInFlight: false,
            pendingNoteSave: false, noteSaveTimer: null, noteInFlight: false,
            map: null, mapLayer: null, mapBounds: null, mapOpen: false
          };
          st.card = buildCard(rec);
          mount.appendChild(st.card);
          renderTiles(st, rec);
          updateCardMeta(st.card, rec);
          st.renderedRev = rec.rev;
        } else if (!st.dragging && !st.pendingSave && !st.pendingKpSave && !st.pendingNoteSave && !st.noteInFlight) {
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
    setReorderSectionTab(getReorderSectionTab());
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

  window.RouteReorder = { enter: enter, exit: exit, toast: toast,
    // Store→grid alignment (2026-08-02): called by the page on plan load /
    // Fetch (deferred a tick so RouteSender.init has wired the hooks).
    overlayFromStore: overlayFromStore,
    // Staged-store read (2026-08-04) — exported so route_sender.js can CONFIRM
    // a stage actually landed instead of trusting the n8n response. Exported
    // rather than duplicated deliberately: REORDER_URL + TOKEN already have
    // three copies in the tree (here, index_v6.html, apps\drive\ui\index.html)
    // and the house rule is to count N before adding another. `loadStaged` is
    // a doGet — it takes NO script lock — so polling it adds no lock pressure
    // to the very contention this confirmation exists to survive.
    getStaged: getStaged };
})();
