/* ==================================================================
 * Stage 1 — Van Route Automation: per-van Send Route module
 * ------------------------------------------------------------------
 * Additive companion to index_v6.html. Loaded BEFORE the existing
 * inline <script>. Exposes window.RouteSender. The inline IIFE in
 * index_v6.html calls RouteSender.init({getState, getCurrentPlan})
 * at the very end so this module can read state.placements,
 * state.tiles, and currentPlan via the supplied closures
 * (read-only — never mutated).
 *
 * Protocols honoured:
 *   - Additive only (no edits to existing functions / handlers).
 *   - British English throughout.
 *   - Debounce + 30s timeout per van_route_automation_plan.md.
 *   - Master Google Sheet is never touched by this module.
 *
 * To revert Stage 1 entirely:
 *   cp index_v6.html.bak index_v6.html && rm route_sender.js
 * ================================================================== */

(function () {
  'use strict';

  // ----------------------------------------------------------------
  // CUSTOMISE: paste your N8N production webhook URL here.
  // (Create the workflow first — see Stage 1 integration guide.)
  // ----------------------------------------------------------------
  var N8N_WEBHOOK_URL = 'https://ftmanager.app.n8n.cloud/webhook/van-route';

  // Timing constants — match the plan's state machine.
  var SUCCESS_HOLD_MS = 3000;
  var FAILURE_HOLD_MS = 4000;
  var REQUEST_TIMEOUT_MS = 30000;

  // Button labels.
  var LABEL_IDLE    = '📍 Send Route';        // 📍
  var LABEL_SENDING = '⏳ Sending route…';     // ⏳ …
  var LABEL_SUCCESS = '✅ Route sent';              // ✅
  var LABEL_FAILED  = '⚠️ Failed — retry'; // ⚠️ —

  // Closures supplied by the host page at init time.
  var hostGetState = null;
  var hostGetCurrentPlan = null;

  function safeState() {
    try { return hostGetState ? hostGetState() : null; } catch (e) { return null; }
  }

  function getDogsForVan(van) {
    var st = safeState();
    if (!st || !st.placements || !st.tiles) return [];
    var prefix = String(van).toLowerCase() + '-';
    var dogs = [];
    Object.keys(st.placements).forEach(function (boxId) {
      if (boxId.indexOf(prefix) !== 0) return;
      var tileIds = st.placements[boxId] || [];
      tileIds.forEach(function (tileId) {
        var tile = st.tiles[tileId];
        if (tile && tile.text) dogs.push(String(tile.text).trim());
      });
    });
    return dogs;
  }

  function getCurrentPeriod() {
    try {
      var p = hostGetCurrentPlan ? hostGetCurrentPlan() : null;
      return typeof p === 'string' && p ? p : 'PM';
    } catch (e) { return 'PM'; }
  }

  function normaliseDeparture(raw) {
    if (!raw) return '';
    // Existing values look like "07:30 am" — convert to 24h HH:MM.
    var m = String(raw).trim().match(/^(\d{1,2}):(\d{2})\s*([ap]m)?$/i);
    if (!m) return String(raw).trim();
    var h = parseInt(m[1], 10);
    var min = m[2];
    var ampm = (m[3] || '').toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    return (h < 10 ? '0' + h : String(h)) + ':' + min;
  }

  function getDepartureTime(van) {
    var el = document.getElementById(String(van).toLowerCase() + '-departure');
    return normaliseDeparture(el && el.value);
  }

  // Accepts either an options object (preferred) or a legacy boolean
  // `returnTrip` (old diagnostic call shape `buildPayload('BV', true)`).
  //   opts = {
  //     startFromCentre: bool   // default true
  //     startAddress:    string // used only when startFromCentre === false
  //     returnToCentre:  bool   // default true
  //     endAddress:      string // used only when returnToCentre === false
  //   }
  function buildPayload(van, opts) {
    if (typeof opts === 'boolean' || opts == null) {
      opts = { returnToCentre: opts !== false };
    }
    var startFromCentre = opts.startFromCentre !== false;     // default true
    var returnToCentre  = opts.returnToCentre  !== false;     // default true
    var startAddress = startFromCentre ? '' : String(opts.startAddress || '').trim();
    var endAddress   = returnToCentre  ? '' : String(opts.endAddress   || '').trim();
    return {
      van: String(van).toUpperCase(),
      period: getCurrentPeriod(),
      departure_time: getDepartureTime(van),
      dogs: getDogsForVan(van),
      // New start/end model. start_from_centre / return_to_centre are the
      // booleans; *_address carry the manually-typed address when the
      // matching checkbox is unchecked (empty string otherwise).
      start_from_centre: startFromCentre,
      start_address: startAddress,
      return_to_centre: returnToCentre,
      end_address: endAddress,
      // Backward-compatible alias: older workflow versions read return_trip
      // to decide whether the route ends at the Centre.
      return_trip: returnToCentre,
      timestamp: new Date().toISOString()
    };
  }

  function setButtonState(btn, st) {
    if (!btn) return;
    btn.classList.remove('is-sending', 'is-success', 'is-failed');
    var labelEl = btn.querySelector('.send-route-btn__label') || btn;
    if (st === 'sending') {
      btn.disabled = true;
      btn.classList.add('is-sending');
      labelEl.textContent = LABEL_SENDING;
    } else if (st === 'success') {
      btn.disabled = true;
      btn.classList.add('is-success');
      labelEl.textContent = LABEL_SUCCESS;
    } else if (st === 'failed') {
      btn.disabled = false;
      btn.classList.add('is-failed');
      labelEl.textContent = LABEL_FAILED;
    } else {
      btn.disabled = false;
      labelEl.textContent = LABEL_IDLE;
    }
  }

  function postToN8n(payload) {
    if (!N8N_WEBHOOK_URL || N8N_WEBHOOK_URL.indexOf('PASTE_') === 0) {
      return Promise.reject(new Error('N8N webhook URL is not configured.'));
    }
    var controller = new AbortController();
    var t = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    return fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    }).then(function (res) {
      clearTimeout(t);
      if (!res.ok) throw new Error('Webhook responded ' + res.status);
      return res;
    }).catch(function (err) {
      clearTimeout(t);
      throw err;
    });
  }

  function handleSendClick(ev) {
    var btn = ev.currentTarget;
    if (!btn || btn.disabled) return;
    var van = btn.getAttribute('data-van');
    if (!van) {
      console.error('[RouteSender] Send Route button missing data-van.');
      return;
    }
    var controls = btn.closest('.route-controls');
    var startCb   = controls ? controls.querySelector('.start-trip-cb') : null;
    var endCb     = controls ? controls.querySelector('.return-trip-cb') : null;
    var startEl   = controls ? controls.querySelector('.start-address-input') : null;
    var endEl     = controls ? controls.querySelector('.end-address-input') : null;
    var startFromCentre = startCb ? !!startCb.checked : true;
    var returnToCentre  = endCb ? !!endCb.checked : true;
    var startAddress = (!startFromCentre && startEl) ? String(startEl.value || '').trim() : '';
    var endAddress   = (!returnToCentre  && endEl)   ? String(endEl.value   || '').trim() : '';

    var failMsg = null;
    if (!startFromCentre && !startAddress) failMsg = '⚠️ Enter start address';
    else if (!returnToCentre && !endAddress) failMsg = '⚠️ Enter end address';
    if (failMsg) {
      console.warn('[RouteSender] ' + van + ': ' + failMsg);
      setButtonState(btn, 'failed');
      var lblA = btn.querySelector('.send-route-btn__label') || btn;
      lblA.textContent = failMsg;
      setTimeout(function () { setButtonState(btn, 'idle'); }, FAILURE_HOLD_MS);
      return;
    }

    var payload = buildPayload(van, {
      startFromCentre: startFromCentre,
      startAddress: startAddress,
      returnToCentre: returnToCentre,
      endAddress: endAddress
    });
    if (!payload.dogs || payload.dogs.length === 0) {
      console.warn('[RouteSender] No dogs assigned to ' + van + '.');
      setButtonState(btn, 'failed');
      var lbl = btn.querySelector('.send-route-btn__label') || btn;
      lbl.textContent = '⚠️ No dogs assigned';
      setTimeout(function () { setButtonState(btn, 'idle'); }, FAILURE_HOLD_MS);
      return;
    }

    setButtonState(btn, 'sending');
    postToN8n(payload).then(function () {
      setButtonState(btn, 'success');
      setTimeout(function () { setButtonState(btn, 'idle'); }, SUCCESS_HOLD_MS);
      console.log('[RouteSender] Sent ' + van + ' route to N8N:', payload);
    }).catch(function (err) {
      console.error('[RouteSender] Send failed for ' + van + ':', err);
      setButtonState(btn, 'failed');
      setTimeout(function () { setButtonState(btn, 'idle'); }, FAILURE_HOLD_MS);
    });
  }

  function bindButtons(root) {
    var scope = root || document;
    var buttons = scope.querySelectorAll('.send-route-btn');
    buttons.forEach(function (btn) {
      if (btn.dataset.routeSenderBound === '1') return;
      btn.addEventListener('click', handleSendClick);
      btn.dataset.routeSenderBound = '1';
    });
  }

  // Show the sibling custom-address text box when a "Start from Centre" /
  // "Return to Centre" checkbox is UNCHECKED; hide it again when re-checked.
  function syncAddressInput(cb) {
    if (!cb) return;
    var row = cb.closest('.toggle-row');
    var input = row ? row.querySelector('.addr-input') : null;
    if (!input) return;
    if (cb.checked) {
      input.hidden = true;            // centre used → address not needed
    } else {
      input.hidden = false;           // custom address required
      try { input.focus(); } catch (e) {}
    }
  }

  function handleToggleChange(ev) {
    syncAddressInput(ev.currentTarget);
  }

  function bindToggles(root) {
    var scope = root || document;
    var toggles = scope.querySelectorAll('.start-trip-cb, .return-trip-cb');
    toggles.forEach(function (cb) {
      if (cb.dataset.toggleBound === '1') return;
      cb.addEventListener('change', handleToggleChange);
      cb.dataset.toggleBound = '1';
      // Reflect the initial checkbox state (handles any pre-unchecked boxes).
      syncAddressInput(cb);
    });
  }

  // Public surface.
  window.RouteSender = {
    init: function (opts) {
      opts = opts || {};
      hostGetState = typeof opts.getState === 'function' ? opts.getState : null;
      hostGetCurrentPlan = typeof opts.getCurrentPlan === 'function' ? opts.getCurrentPlan : null;
      bindButtons();
      bindToggles();
      console.log('[RouteSender] Initialised. State accessor wired:',
        !!hostGetState, '— currentPlan accessor wired:', !!hostGetCurrentPlan);
    },
    // Diagnostics — call from DevTools to verify the payload shape.
    buildPayload: buildPayload,
    getDogsForVan: getDogsForVan,
    getCurrentPeriod: getCurrentPeriod,
    getDepartureTime: getDepartureTime,
    // For Stage 2+ when you want to wire the URL in code rather than
    // editing this file.
    setWebhookUrl: function (url) { N8N_WEBHOOK_URL = String(url || ''); }
  };
})();
