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
  var N8N_WEBHOOK_URL = 'https://ftmanager.app.n8n.cloud/webhook/van-route';
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

  // ---- state -----------------------------------------------------
  var active = false;
  var pollTimer = null;
  var pollFails = 0;
  var slots = {};   // slot_key -> { record, card, stopsById, renderedRev, dragging, pendingSave, saveTimer, staleRemove, preDragOrder }
  var cleared = {}; // slot_key -> Date.now() tombstone: a slot we just removed (so a stale in-flight poll can't re-add its card)
  var drag = null;  // active drag context

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
      '.reorder-sent-flag{background:var(--success);color:#fff;font-size:11px;padding:1px 8px;border-radius:999px;}';
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

  function buildCard(rec) {
    var card = document.createElement('div');
    card.className = 'reorder-slot';
    card.setAttribute('data-slot', rec.slot_key);
    var vanCls = 'van-badge--' + String(rec.van).toLowerCase();
    card.innerHTML =
      '<div class="reorder-slot-head">' +
        '<span class="van-badge ' + vanCls + '">' + escapeHtml(rec.van) + '</span>' +
        '<span class="reorder-staged-at"></span>' +
        '<span class="reorder-updated-flag" hidden>updated</span>' +
        '<span class="reorder-sent-flag" hidden></span>' +
        '<span class="reorder-skip" hidden></span>' +
      '</div>' +
      '<ol class="reorder-list"></ol>' +
      '<button type="button" class="send-route-btn reorder-send">' +
        '<span class="send-route-btn__label">📍 Send Final Route</span></button>';
    card.querySelector('.reorder-send').addEventListener('click', function () { sendFinal(rec.slot_key); });
    return card;
  }

  function updateCardMeta(card, rec) {
    var at = card.querySelector('.reorder-staged-at');
    if (at) at.textContent = 'staged ' + fmtTime(rec.staged_at) + (rec.last_reordered_by ? ' · edited' : '');
    var skip = card.querySelector('.reorder-skip');
    if (skip) {
      if (rec.skipped && rec.skipped.length) {
        skip.hidden = false;
        skip.textContent = '⚠️ ' + rec.skipped.length + ' not staged: ' +
          rec.skipped.map(function (s) { return (s && (s.dog || s.name)) || '?'; }).join(', ');
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
      skip_optimisation: true,
      timestamp: new Date().toISOString()
    };

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
    if (!view.__built) buildSkeleton();
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
