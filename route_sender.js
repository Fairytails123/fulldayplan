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
  // Write hooks (added 2026-05-30) — let this module push the optimised stop
  // numbers n8n returns straight into the Load Plan kennels. Both are existing
  // index_v6.html functions, reused as-is:
  //   hostSetStopValue(boxId, 'primary'|'secondary', value) → state.stops + localSave
  //   hostHydrate() → re-render the boxes
  var hostSetStopValue = null;
  var hostHydrate = null;

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

  // Full Day (FD) / Half Day (HD) selector — PM plan ONLY. The dropdown is hidden
  // in Next-Day-AM mode (it still exists in the DOM), so we gate on the current
  // period and send '' for AM routes. Whitelisted to FD/HD so only a known token
  // ever reaches the payload.
  function getRunType(van) {
    if (getCurrentPeriod() !== 'PM') return '';
    var el = document.getElementById(String(van).toLowerCase() + '-runtype');
    var v = el && el.value ? String(el.value).toUpperCase().trim() : '';
    return (v === 'FD' || v === 'HD') ? v : '';
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
      // Full Day (FD) / Half Day (HD) — PM-plan routes only ('' on Next-Day-AM).
      run_type: getRunType(van),
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

  // ----------------------------------------------------------------
  // Stop-number write-back (added 2026-05-30)
  // ----------------------------------------------------------------
  // After a Send Route, n8n returns the optimised stops in its response
  // (`{ received, ok, stops:[{name, stop}] }`). We drop each stop number into
  // the kennel holding the matching dog: match the returned name to a placed
  // tile, find its kennel (boxId) + slot (1st tile → primary, 2nd → secondary),
  // and write via the host's setStopValue. The returned name is the master-
  // sheet name (e.g. "Rolo Barnwell"), which may be fuller than the tile text
  // ("Rolo"), so matching is tolerant: exact first, then leading-token.

  // ---- Grooming "G.D." detection (shared canonical rule) ----
  // Canonical regex — byte-identical to stage2_fuzzy_match.js,
  // index_whiteboard.html and white_board.js. Matches a trailing
  // G.D./GD./G.D/GD token (optional dots, case-insensitive). We strip it from a
  // tile's text so "Atom G.D." still matches the response/sheet name "Atom" for
  // the kennel stop write-back. The literal "G.D." the staffer typed stays
  // visible on the tile itself — that's the Load-Plan signifier (the route
  // message + whiteboard carry the ✂️ (grooming) annotation downstream).
  var GROOMING_RE = /(^|\s)G\.?D\.?$/i;
  function stripGroomingToken(s) {
    var t = String(s == null ? '' : s).trim();
    var out = t.replace(GROOMING_RE, '').trim();
    return out || t;   // keep original if stripping empties it (a bare "GD")
  }

  // Second-address marker (added 2026-06-08) — a trailing "ALT" token staff type on
  // a dog's tile (e.g. "Tallulah ALT") to route it to its 2nd address. Stripped
  // here (like G.D.) so the tile still matches the route response's CANONICAL name
  // ("Tallulah") for the kennel stop write-back. The token only flags the address
  // server-side (Stage 2); it never changes the dog's identity. No-op otherwise.
  var ALT_RE = /(^|\s)ALT$/i;
  function stripAltToken(s) {
    var t = String(s == null ? '' : s).trim();
    var out = t.replace(ALT_RE, '').trim();
    return out || t;   // keep original if stripping empties it (a bare "ALT")
  }

  function normName(s) {
    // Strip a trailing ALT (2nd-address) then G.D. (grooming) token so a marked
    // tile matches its clean resolved name. No-op for ordinary names.
    return stripGroomingToken(stripAltToken(s)).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // 3 = exact; 2 = tile name is the leading token of the route name
  // ("rolo" ⊂ "rolo barnwell"); 1 = route name is the leading token of the
  // tile name; 0 = no match.
  function stopMatchScore(tileName, routeName) {
    var a = normName(tileName), b = normName(routeName);
    if (!a || !b) return 0;
    if (a === b) return 3;
    if (b.indexOf(a + ' ') === 0) return 2;
    if (a.indexOf(b + ' ') === 0) return 1;
    return 0;
  }

  function applyReturnedStops(van, stops, sentPeriod) {
    if (!Array.isArray(stops) || !stops.length) return 0;
    if (typeof hostSetStopValue !== 'function') return 0;
    // Don't write into the wrong plan if the user switched tabs mid-send.
    if (sentPeriod && getCurrentPeriod() !== sentPeriod) {
      console.warn('[RouteSender] Plan changed since send (' + sentPeriod +
        ' → ' + getCurrentPeriod() + '); skipping kennel stop write.');
      return 0;
    }
    var st = safeState();
    if (!st || !st.placements || !st.tiles) return 0;
    var prefix = String(van).toLowerCase() + '-';

    // This van's placed tiles, each with its kennel + slot.
    var slots = [];
    Object.keys(st.placements).forEach(function (boxId) {
      if (boxId.indexOf(prefix) !== 0) return;
      var tileIds = st.placements[boxId] || [];
      tileIds.forEach(function (tileId, idx) {
        var tile = st.tiles[tileId];
        if (!tile || !tile.text) return;
        slots.push({
          boxId: boxId,
          slot: idx === 0 ? 'primary' : 'secondary',
          tileId: tileId,
          name: tile.text
        });
      });
    });
    if (!slots.length) return 0;

    // Greedy best-match, each tile claimed once. Process exact (score 3)
    // matches first so a looser leading-token match can't steal an exact
    // tile from another routed dog.
    var ordered = stops.filter(function (s) {
      return s && s.name && s.stop != null && s.stop !== '';
    }).map(function (s) {
      var bestForS = 0;
      slots.forEach(function (slot) {
        var sc = stopMatchScore(slot.name, s.name);
        if (sc > bestForS) bestForS = sc;
      });
      return { stop: s, topScore: bestForS };
    }).sort(function (a, b) { return b.topScore - a.topScore; });

    var claimed = {};
    var applied = 0;
    var unmatched = [];
    ordered.forEach(function (entry) {
      var s = entry.stop;
      var best = null, bestScore = 0;
      slots.forEach(function (slot) {
        if (claimed[slot.tileId]) return;
        var score = stopMatchScore(slot.name, s.name);
        if (score > bestScore) { bestScore = score; best = slot; }
      });
      if (best && bestScore > 0) {
        claimed[best.tileId] = true;
        try {
          hostSetStopValue(best.boxId, best.slot, String(s.stop));
          applied++;
        } catch (e) { console.warn('[RouteSender] setStopValue failed:', e); }
      } else {
        unmatched.push(s.name);
      }
    });

    if (applied && typeof hostHydrate === 'function') {
      try { hostHydrate(); } catch (e) { console.warn('[RouteSender] hydrate failed:', e); }
    }
    console.log('[RouteSender] Applied ' + applied + '/' + stops.length +
      ' stop number(s) to ' + van + ' kennels' +
      (unmatched.length ? ('; unmatched: ' + unmatched.join(', ')) : ''));
    return applied;
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

    // Plan active at send time — used to avoid writing stop numbers into a
    // different plan if the user switches tabs before the response arrives.
    var sentPeriod = payload.period;

    setButtonState(btn, 'sending');
    postToN8n(payload).then(function (res) {
      setButtonState(btn, 'success');
      setTimeout(function () { setButtonState(btn, 'idle'); }, SUCCESS_HOLD_MS);
      console.log('[RouteSender] Sent ' + van + ' route to N8N:', payload);
      // Additive: drop the optimised stop numbers n8n returns into the kennels.
      // Runs independently of the success state above — any parse/match issue
      // is logged, never surfaced to the button.
      if (res && typeof res.json === 'function') {
        res.json().then(function (body) {
          if (body && Array.isArray(body.stops) && body.stops.length) {
            applyReturnedStops(van, body.stops, sentPeriod);
          }
        }).catch(function (e) {
          console.warn('[RouteSender] No stop numbers in response (' + van + '):', e);
        });
      }
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
      hostSetStopValue = typeof opts.setStopValue === 'function' ? opts.setStopValue : null;
      hostHydrate = typeof opts.hydrate === 'function' ? opts.hydrate : null;
      bindButtons();
      bindToggles();
      console.log('[RouteSender] Initialised. State accessor wired:',
        !!hostGetState, '— currentPlan accessor wired:', !!hostGetCurrentPlan,
        '— stop write-back wired:', !!hostSetStopValue);
    },
    // Diagnostics — call from DevTools to verify the payload shape.
    buildPayload: buildPayload,
    getDogsForVan: getDogsForVan,
    getCurrentPeriod: getCurrentPeriod,
    getDepartureTime: getDepartureTime,
    getRunType: getRunType,
    // Stop-number write-back (added 2026-05-30). Call from DevTools to test:
    //   RouteSender.applyReturnedStops('BV', [{name:'Arlo',stop:1}])
    applyReturnedStops: applyReturnedStops,
    // For Stage 2+ when you want to wire the URL in code rather than
    // editing this file.
    setWebhookUrl: function (url) { N8N_WEBHOOK_URL = String(url || ''); }
  };
})();
