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
 * Backend contract (all on the EXISTING Apps Script web app the page already
 * uses for Share/Fetch):
 *   GET  ?action=loadStaged&token=…        -> { ok, slots:[ {slot_key, section,
 *        van, ctx:{v,p,t,rt,r,s,sa,ea,d,o,aa,gg}, skipped, staged_at, rev, …} ] }
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
      // ---- per-card foot (Reverse + Send) ----
      '.reorder-slot-foot{display:flex;gap:8px;align-items:stretch;margin-top:4px;}' +
      '.reorder-slot-foot .reorder-send{flex:1 1 auto;}' +
      '.reorder-reverse{flex:0 0 auto;border:1px solid #c7d2fe;background:#eef2ff;color:#3730a3;font-size:13px;' +
        'font-weight:700;padding:0 14px;border-radius:8px;cursor:pointer;}' +
      '.reorder-reverse:hover{background:#e0e7ff;}';
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
      '<div class="reorder-slot-foot">' +
        '<button type="button" class="reorder-reverse" title="Reverse the stop order">🔁 Reverse</button>' +
        '<button type="button" class="send-route-btn reorder-send">' +
          '<span class="send-route-btn__label">📍 Send Final Route</span></button>' +
      '</div>';
    card.querySelector('.reorder-send').addEventListener('click', function () { sendFinal(rec.slot_key); });
    var rev = card.querySelector('.reorder-reverse');
    if (rev) rev.addEventListener('click', function () { reverseRoute(rec.slot_key); });
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
            dragging: false, pendingSave: false, saveTimer: null, staleRemove: false
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
  }
  function exit() {
    active = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (drag) { try { onDragEnd(); } catch (e) {} }
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
