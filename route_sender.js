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
  var N8N_WEBHOOK_URL = 'https://auto.thefairytails.co.uk/webhook/van-route';

  // Timing constants — match the plan's state machine.
  var SUCCESS_HOLD_MS = 3000;
  var FAILURE_HOLD_MS = 4000;

  // ----------------------------------------------------------------
  // Double-click / re-stage storm guard (2026-08-04) — see Load Plan BUGS.md #41.
  // ----------------------------------------------------------------
  // REQUEST_TIMEOUT_MS was 30,000 and was the BUG, not the protection: the
  // button disabled itself on click (correct) but the 30 s abort re-enabled
  // it while 889 was still running, so the operator was actively invited to
  // click again mid-job. On 2026-08-03 that produced six presses in three
  // minutes; each press is TWO POSTs (the Stage — Save node retries once), and
  // every one takes the Apps Script script lock, so the presses starved each
  // other out and five of six stages never landed.
  //
  // The ceiling below must exceed the WORST possible 889 stage run.
  //
  // ⚠️ RE-DERIVED 2026-08-04 FROM THE NODES' CONFIGURED MAXIMA, not from observed
  // times. The previous version of this comment was built from a fast day's
  // measurements and understated the total by ~45 s — a ceiling has to be sized
  // against what the config PERMITS, because that is what a bad day produces.
  // Read live from the 889 export, stage_only path:
  //     Fuzzy Match Dogs — bounded by the grooming-feed
  //       timeout it sets itself (stage2_fuzzy_match.js)      25.0 s
  //     HTTP — RouteXL /tour/ — CONFIGURED timeout, not the
  //       ~1 s it usually takes                               30.0 s
  //     Stage — Save — one attempt since fix 2 (was 42 s:
  //       20 s + 2 s wait + 20 s retry)                       60.0 s
  //                                                        ─────────
  //       bounded terms alone                                115.0 s
  //     + Read Master / Coordinates / Alt Address: these have
  //       NO timeout and carry retryOnFail maxTries 3 with a
  //       3 s gap, so they contribute ~18 s of retry WAIT on
  //       top of three unbounded attempts each. Observed
  //       nominal ≈ 3.7 s; a degraded run is far more.        ~20 s+
  //                                                        ─────────
  //                                                          ≈ 135 s
  // Hence 150 s, not 120 s. At 120 s this page would abort a run that was still
  // going to succeed — and losing the response also loses `applyReturnedStops`
  // (kennel stop numbers) and the new `staged` flag.
  //
  // 📌 Two standing constraints for whoever touches this next:
  //   - STAGE_CEILING_MS must stay >= REQUEST_TIMEOUT_MS.
  //   - If Stage — Save ever regains a retry, raise BOTH in the SAME ship:
  //     maxTries 2 with a 60 s timeout and a 15 s gap makes the worst node 135 s
  //     and the worst run ~210 s — the original bug, rebuilt.
  //   - The three unbounded Sheets reads are the one term that cannot be
  //     bounded from here. Giving them an explicit timeout in 889 is the real
  //     cure and is logged as a follow-up, not done in this ship.
  //
  // It is a CEILING, not the normal wait: the store confirmation below — and,
  // since fix 1, the response's own `staged` flag — releases the button the
  // moment the route really lands, typically 5–20 s.
  var REQUEST_TIMEOUT_MS = 150000;
  var STAGE_CEILING_MS   = 150000;  // hard stop; keep >= REQUEST_TIMEOUT_MS
  var STORE_POLL_MS      = 4000;    // how often to ask the store "did it land?"
  var STORE_POLL_DELAY_MS = 3000;   // grace before the first poll (fastest observed stage: 3.5 s)
  var RETRY_COOLDOWN_MS  = 15000;   // after a FAILED stage, before re-arming

  // Button labels.
  // Reorder Routes (2026-06-26): this per-van button now STAGES the optimised
  // route into the "Reorder Routes" tab (it no longer goes straight to Telegram),
  // so the labels read "Stage", not "Send".
  var LABEL_IDLE    = '📍 Stage Route';        // 📍 → Reorder Routes tab
  var LABEL_SENDING = '⏳ Staging route…';      // ⏳ …
  var LABEL_SUCCESS = '✅ Staged';              // ✅ see the Reorder Routes tab
  var LABEL_FAILED  = '⚠️ Failed — retry'; // ⚠️ —
  var LABEL_WAITING = '⏳ Please wait…';        // another van is staging
  var LABEL_NOTLANDED = '⚠️ Not staged — retry';

  // ----------------------------------------------------------------
  // Fleet-wide staging latch (2026-08-04, owner decision).
  // ----------------------------------------------------------------
  // Only ONE stage may be in flight at a time, across ALL vans. Two vans
  // staging concurrently is the same script-lock contention that broke
  // 2026-08-03; serialising them removes the hazard rather than narrowing it.
  // `stagingBtn` is the button that owns the latch — it keeps its own
  // ⏳/✅/⚠️ label while the others simply read "please wait".
  var stagingInFlight = false;
  var stagingBtn = null;

  function allStageButtons() {
    try { return Array.prototype.slice.call(document.querySelectorAll('.send-route-btn')); }
    catch (e) { return []; }
  }

  // Latch/unlatch every OTHER van's button. The owning button is driven by
  // setButtonState as before, so its existing state machine is untouched.
  // Is this button still serving its post-failure anti-storm cooldown?
  //
  // ⚠️ 2026-08-04: without this, the cooldown was cancelled by an UNRELATED van.
  // `setFleetLatch(false)` re-enables every non-owner button, so: BVX misses at
  // t=150 and starts its 15 s countdown → the operator stages SV at t=152 →
  // SV lands at t=156 → SV's unlatch re-enables BVX with ~9 s unserved, straight
  // back into the contention that just made it miss. Worse, the latch had
  // captured BVX's countdown text as its "idle" label, so if the countdown had
  // already finished the restore repainted a stale "⚠️ Not staged — retry (13)"
  // on an ENABLED button, permanently. The cooldown is the anti-storm guard that
  // fix 1 exists to protect, so it has to be per-button and outrank the latch.
  function inCooldown(b) {
    var until = Number(b && b.dataset ? b.dataset.rsCooldownUntil : 0);
    return !!until && Date.now() < until;
  }

  function setFleetLatch(on, owner) {
    stagingInFlight = !!on;
    stagingBtn = on ? (owner || null) : null;
    allStageButtons().forEach(function (b) {
      if (b === owner) return;
      // A button serving its own cooldown is left completely alone in both
      // directions: not re-labelled on latch (so its countdown is never captured
      // as an "idle" label) and not re-enabled on unlatch.
      if (inCooldown(b)) return;
      var lbl = b.querySelector('.send-route-btn__label') || b;
      if (on) {
        if (b.dataset.rsIdleLabel === undefined) b.dataset.rsIdleLabel = lbl.textContent;
        b.disabled = true;
        b.classList.add('is-waiting');
        lbl.textContent = LABEL_WAITING;
      } else {
        b.disabled = false;
        b.classList.remove('is-waiting');
        if (b.dataset.rsIdleLabel !== undefined) {
          lbl.textContent = b.dataset.rsIdleLabel;
          delete b.dataset.rsIdleLabel;
        } else {
          lbl.textContent = LABEL_IDLE;
        }
      }
    });
  }

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
  // Reorder→grid kennel write-back hook (added 2026-07-31):
  //   hostMoveTileToBox(tileId, boxId) → moves a tile into a kennel box
  //   (undo state + remove-from-everywhere + max-2, exactly like a drag).
  var hostMoveTileToBox = null;
  var hostCreateTileInBox = null;
  var hostMoveTileToTray = null;

  function safeState() {
    try { return hostGetState ? hostGetState() : null; } catch (e) { return null; }
  }

  function findTilePlacement(st, tileId) {
    var boxId = '';
    Object.keys((st && st.placements) || {}).some(function (candidateId) {
      if ((st.placements[candidateId] || []).indexOf(tileId) === -1) return false;
      boxId = candidateId;
      return true;
    });
    return {
      boxId: boxId,
      van: boxId ? String(boxId).split('-')[0].toUpperCase().trim() : null
    };
  }

  // Collect every kennel in the target van, not merely the requested kp box.
  // The placement planner needs the full list to choose a safe fallback when
  // a cross-van dog's requested box already contains two dogs.
  function collectTargetVanBoxes(van, st, lane) {
    var targetVan = String(van || '').toUpperCase().trim();
    var prefix = targetVan.toLowerCase() + '-';
    var useLane = getCurrentPeriod() === 'PM' && lane != null;
    var wantedLane = String(lane || '').toUpperCase() === 'HD' ? 'HD' : 'FD';
    var boxes = [];
    Array.prototype.forEach.call(document.querySelectorAll('.box[data-box^="' + prefix + '"]'), function (el) {
      if (!el || !el.dataset || !el.dataset.box) return;
      var occupants = ((st && st.placements && st.placements[el.dataset.box]) || []).slice();
      if (useLane) {
        occupants = occupants.filter(function (tileId) {
          var tile = st && st.tiles && st.tiles[tileId];
          return (tile && tile.rt === 'HD' ? 'HD' : 'FD') === wantedLane;
        });
      }
      boxes.push({
        id: el.dataset.box,
        van: targetVan,
        pos: el.dataset.pos || '',
        occupants: occupants
      });
    });
    return boxes;
  }

  // Pure placement seam used by the store overlay. A valid position wins when
  // its box has room. If that box is full, a dog already in the target van is
  // refused and stays put; only cross-van or unplaced dogs fall back to the
  // first empty, then first half-occupied, target-van box. No full box is ever
  // displaced and this seam never targets the staging tray.
  function planCrossVanPlacement(van, kp, boxes, currentVan) {
    var wantVan = String(van || '').toUpperCase();
    var fromVan = currentVan == null ? '' : String(currentVan).toUpperCase();
    var code = String(kp || '').toUpperCase().trim();
    var validCode = /^[SB][TMB][PMD]$/.test(code);
    var candidates = (Array.isArray(boxes) ? boxes : []).filter(function (box) {
      return box && String(box.van || '').toUpperCase() === wantVan;
    });
    if (validCode) {
      for (var i = 0; i < candidates.length; i++) {
        if (String(candidates[i].pos || '').toUpperCase() === code &&
            (candidates[i].occupants || []).length < 2) {
          return { boxId: candidates[i].id, auto: false };
        }
      }
      if (fromVan === wantVan) {
        return { refused: true, reason: 'requested kennel unavailable in ' + wantVan };
      }
    }
    var firstHalf = null;
    for (var j = 0; j < candidates.length; j++) {
      var count = (candidates[j].occupants || []).length;
      if (count === 0) return { boxId: candidates[j].id, auto: true };
      if (count === 1 && !firstHalf) firstHalf = candidates[j];
    }
    if (firstHalf) return { boxId: firstHalf.id, auto: true };
    return { refused: true, reason: 'no free kennel in ' + wantVan };
  }

  // Pure staged-membership seam. `d` records every dog originally staged;
  // flattened `o` records the dogs still routed after any Reorder-tab removal.
  function classifyOverlayDog(name, slotRecs) {
    function clean(value) {
      var out = String(value == null ? '' : value).trim();
      var before;
      do {
        before = out;
        // Reuse the ONE canonical G.D. literal (GROOMING_RE below) — a second
        // variant copy here is exactly what _trace_dogname_drift.mjs guards
        // against. ALT is a Load-Plan-only token with no canonical regex.
        out = out.replace(GROOMING_RE, '').trim();
        out = out.replace(/(^|\s)ALT$/i, '').trim();
      } while (out && out !== before);
      return out.toLowerCase().replace(/\s+/g, ' ').trim();
    }
    var want = clean(name);
    if (!want) return 'unstaged';
    var inStaged = false, inOrder = false;
    (Array.isArray(slotRecs) ? slotRecs : []).forEach(function (rec) {
      var ctx = (rec && rec.ctx) || {};
      (Array.isArray(ctx.d) ? ctx.d : []).forEach(function (dog) {
        if (clean(dog) === want) inStaged = true;
      });
      (Array.isArray(ctx.o) ? ctx.o : []).forEach(function (members) {
        (Array.isArray(members) ? members : [members]).forEach(function (dog) {
          if (clean(dog) === want) inOrder = true;
        });
      });
    });
    return inOrder ? 'routed' : (inStaged ? 'removed' : 'unstaged');
  }

  function getDogsForVan(van) {
    var st = safeState();
    if (!st || !st.placements || !st.tiles) return [];
    var prefix = String(van).toLowerCase() + '-';
    var useLane = getCurrentPeriod() === 'PM';
    var lane = useLane ? (getRunType(van) || 'FD') : '';
    var dogs = [];
    Object.keys(st.placements).forEach(function (boxId) {
      if (boxId.indexOf(prefix) !== 0) return;
      var tileIds = st.placements[boxId] || [];
      tileIds.forEach(function (tileId) {
        var tile = st.tiles[tileId];
        if (useLane && (tile && tile.rt === 'HD' ? 'HD' : 'FD') !== lane) return;
        if (tile && tile.text) dogs.push(String(tile.text).trim());
      });
    });
    return dogs;
  }

  // Kennel-position map for a van: { <normalised dog name>: <position code> }
  // e.g. { "bluey cat": "SMP", "ned bird": "BBD" }. The position code is the
  // data-pos attribute on the kennel box the dog is placed in (STP/SMP/BBD/…,
  // added with the on-diagram labels 2026-07-02). Sent with the route so the
  // Telegram message can show each dog's spot in the van; keyed by normName
  // (the SAME token-stripping+lowercasing used for the stop write-back) so it
  // joins to the route's canonical dog names server-side. Purely display data.
  function getPositionsForVan(van) {
    var st = safeState();
    var out = {};
    if (!st || !st.placements || !st.tiles) return out;
    var prefix = String(van).toLowerCase() + '-';
    var useLane = getCurrentPeriod() === 'PM';
    var lane = useLane ? (getRunType(van) || 'FD') : '';
    Object.keys(st.placements).forEach(function (boxId) {
      if (boxId.indexOf(prefix) !== 0) return;
      var boxEl = document.querySelector('[data-box="' + boxId + '"]');
      var pos = (boxEl && boxEl.dataset) ? String(boxEl.dataset.pos || '').trim() : '';
      if (!pos) return;
      (st.placements[boxId] || []).forEach(function (tileId) {
        var tile = st.tiles[tileId];
        if (useLane && (tile && tile.rt === 'HD' ? 'HD' : 'FD') !== lane) return;
        if (tile && tile.text) {
          var key = normName(tile.text);
          if (key) out[key] = pos;
        }
      });
    });
    return out;
  }

  // Reorder→grid kennel alignment. It never creates a missing tile or displaces
  // a full two-dog box. The 2026-07-31 direct kennel write-back applies only
  // the requested box and refuses any fallback, so the dog stays where staff
  // placed it when that box is unavailable. Store overlays may move cross-van
  // or unplaced dogs to a free fallback box and visibly mark it auto-placed.
  // Removed dogs are trayed only by moveRemovedDogToTray after positive d/o
  // membership classification; this assignment function itself never trays.
  // The other plan and Add-Dog dogs without a tile remain silent no-ops.
  function applyKennelFromReorder(planKey, van, dogName, posCode, opts) {
    opts = opts || {};
    if (typeof hostMoveTileToBox !== 'function') return false;
    if (String(planKey || '').toUpperCase() !== String(getCurrentPeriod()).toUpperCase()) return false;
    var st = safeState();
    if (!st || !st.tiles || !st.placements) return false;
    var code = String(posCode || '').toUpperCase().trim();
    var want = normName(dogName);
    if (!want) return false;
    var useLane = getCurrentPeriod() === 'PM';
    var lane = String(opts.lane || '').toUpperCase() === 'HD' ? 'HD' : 'FD';
    var tileId = null, otherLaneTileId = null;
    Object.keys(st.tiles).some(function (tid) {
      var t = st.tiles[tid];
      if (!t || !t.text || normName(t.text) !== want) return false;
      if (!useLane || (t.rt === 'HD' ? 'HD' : 'FD') === lane) {
        tileId = tid;
        return true;
      }
      if (!otherLaneTileId) otherLaneTileId = tid;
      return false;
    });
    var adopting = !tileId && !!otherLaneTileId;
    if (adopting) {
      // A strict match in another lane is adoption, never creation. The store
      // overlay suppresses adoption when that tile's own lane also routes it.
      if (opts.allowLaneAdoption === false) return false;
      tileId = otherLaneTileId;
    }
    var targetVan = String(van || '').toUpperCase().trim();
    var prefix = targetVan.toLowerCase() + '-';
    var boxes = collectTargetVanBoxes(targetVan, st, useLane ? lane : undefined);
    if (!tileId) {
      if (opts.createMissing !== true || opts.storeOverlay !== true ||
          typeof hostCreateTileInBox !== 'function') return false;
      // Creation is deliberately more conservative than the strict move path:
      // staged names may be fuller than tile text, or differ only by accents
      // and apostrophe style. Any tolerant match means the tile already exists.
      function foldCreateName(value) {
        return String(value || '').replace(/\u2019/g, "'")
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      }
      var foldedWant = foldCreateName(want);
      var hasTolerantTile = Object.keys(st.tiles).some(function (tid) {
        var t = st.tiles[tid];
        if (useLane && (t && t.rt === 'HD' ? 'HD' : 'FD') !== lane) return false;
        var foldedTile = t && t.text ? foldCreateName(normName(t.text)) : '';
        return !!foldedTile && (foldedTile === foldedWant ||
          foldedTile.indexOf(foldedWant + ' ') === 0 ||
          foldedWant.indexOf(foldedTile + ' ') === 0);
      });
      if (hasTolerantTile) return false;
      var missingDecision = planCrossVanPlacement(targetVan, code, boxes, null);
      if (!missingDecision || missingDecision.refused || !missingDecision.boxId) return false;
      // Preserve the staged display casing while reusing normName's canonical
      // G.D./ALT handling to peel only recognised trailing marker tokens.
      var tileText = String(dogName == null ? '' : dogName).trim();
      var displayParts = tileText.split(/\s+/);
      while (displayParts.length > 1) {
        var withoutLast = displayParts.slice(0, -1).join(' ');
        if (normName(withoutLast) !== want) break;
        displayParts.pop();
        tileText = withoutLast;
      }
      try {
        return typeof hostCreateTileInBox(tileText, missingDecision.boxId,
          { auto: missingDecision.auto === true, rt: useLane ? lane : undefined }) === 'string';
      } catch (createErr) { return false; }
    }
    var placement = findTilePlacement(st, tileId);
    var currentBox = placement.boxId;
    var currentVan = placement.van;
    var validCode = /^[SB][TMB][PMD]$/.test(code);
    // Legacy-lane adoption is deliberately a same-box move when possible: it
    // re-stamps the tile without disturbing the operator's kennel placement.
    if (adopting && currentBox) {
      try {
        return hostMoveTileToBox(tileId, currentBox,
          { overlay: true, auto: false, rt: useLane ? lane : undefined }) === true;
      } catch (adoptErr) { return false; }
    }
    if (!validCode && currentBox.indexOf(prefix) === 0) return false;
    // A tile already in its valid requested box is aligned even when it shares
    // that box with a second dog; do not mistake its own occupancy for fullness.
    if (validCode && currentBox) {
      var currentEl = document.querySelector('[data-box="' + currentBox + '"]');
      if (currentEl && String(currentEl.dataset.pos || '').toUpperCase() === code) {
        try {
          return hostMoveTileToBox(tileId, currentBox,
            { overlay: true, auto: false, rt: useLane ? lane : undefined }) === true;
        }
        catch (sameErr) { return false; }
      }
    }
    var decision = planCrossVanPlacement(targetVan, code, boxes, currentVan);
    if (!decision || decision.refused || !decision.boxId) return false;
    if (decision.auto && opts.storeOverlay !== true) return false;
    try {
      return hostMoveTileToBox(tileId, decision.boxId,
        { overlay: true, auto: decision.auto === true, rt: useLane ? lane : undefined }) === true;
    }
    catch (e) { return false; }
  }

  function moveRemovedDogToTray(planKey, dogName, lane) {
    if (typeof hostMoveTileToTray !== 'function') return false;
    if (String(planKey || '').toUpperCase() !== String(getCurrentPeriod()).toUpperCase()) return false;
    var st = safeState();
    if (!st || !st.tiles) return false;
    var useLane = getCurrentPeriod() === 'PM';
    var wantedLane = String(lane || '').toUpperCase() === 'HD' ? 'HD' : 'FD';
    var want = normName(dogName), tileId = null;
    Object.keys(st.tiles).some(function (tid) {
      var tile = st.tiles[tid];
      if (useLane && (tile && tile.rt === 'HD' ? 'HD' : 'FD') !== wantedLane) return false;
      if (tile && tile.text && normName(tile.text) === want) { tileId = tid; return true; }
      return false;
    });
    if (!tileId) return false;
    try { return hostMoveTileToTray(tileId, 'removed-from-route') === true; }
    catch (e) { return false; }
  }

  function clearVanStops(planKey, van, lane) {
    if (typeof hostSetStopValue !== 'function') return 0;
    if (String(planKey || '').toUpperCase() !== String(getCurrentPeriod()).toUpperCase()) return 0;
    var st = safeState();
    if (!st || !st.placements) return 0;
    var useLane = getCurrentPeriod() === 'PM';
    var wantedLane = String(lane || '').toUpperCase() === 'HD' ? 'HD' : 'FD';
    var prefix = String(van || '').toLowerCase() + '-', cleared = 0;
    Object.keys(st.placements).forEach(function (boxId) {
      if (boxId.indexOf(prefix) !== 0) return;
      try {
        hostSetStopValue(boxId, 'primary', '', useLane ? wantedLane : undefined);
        hostSetStopValue(boxId, 'secondary', '', useLane ? wantedLane : undefined);
        cleared++;
      } catch (e) {}
    });
    if (cleared && typeof hostHydrate === 'function') {
      try { hostHydrate(); } catch (e2) {}
    }
    return cleared;
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

  // Full Day (FD) / Half Day (HD) — PM plan ONLY. state.runTypes is the source
  // of truth shared with hydrate; the dropdown is only a fallback for legacy
  // hosts without a valid state value. PM defaults to FD; AM always sends ''.
  function getRunType(van) {
    if (getCurrentPeriod() !== 'PM') return '';
    var key = String(van).toLowerCase();
    var st = safeState();
    var stateValue = st && st.runTypes ? String(st.runTypes[key] || '').toUpperCase().trim() : '';
    if (stateValue === 'FD' || stateValue === 'HD') return stateValue;
    var el = document.getElementById(String(van).toLowerCase() + '-runtype');
    var v = el && el.value ? String(el.value).toUpperCase().trim() : '';
    return (v === 'FD' || v === 'HD') ? v : 'FD';
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
    // P5-consumer-1 (2026-07-17): delegate to the shared FT_PAYLOAD module
    // when it has loaded (shared/ft-payload.js) — ONE payload source for the
    // STAGE / FINAL / DRIVE builders. The spec is assembled from the SAME
    // state readers the original body uses. The original body below is kept
    // VERBATIM as the fallback so staging still works if the module fails to
    // load.
    if (window.FT_PAYLOAD && window.FT_PAYLOAD.buildStage) {
      var specOpts = (typeof opts === 'boolean' || opts == null)
        ? { returnToCentre: opts !== false } : opts;
      return window.FT_PAYLOAD.buildStage({
        van: van,
        period: getCurrentPeriod(),
        departure_time: getDepartureTime(van),
        run_type: getRunType(van),
        dogs: getDogsForVan(van),
        positions: getPositionsForVan(van),
        start_from_centre: specOpts.startFromCentre,
        start_address: specOpts.startAddress,
        return_to_centre: specOpts.returnToCentre,
        end_address: specOpts.endAddress
      }, new Date().toISOString());
    }
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
      // Kennel position per dog (data-pos of its box: STP/SMP/BBD/…) — shown in
      // the Telegram route message so the driver sees where each dog is in the van.
      positions: getPositionsForVan(van),
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
      // Reorder Routes (2026-06-26): STAGE this route instead of sending it.
      // n8n runs Stage 2+3+4 (fuzzy match + RouteXL optimise + format), then —
      // because stage_only is true — writes the ReorderQueue sheet and responds,
      // SKIPPING the Telegram send + whiteboard write. Staff reorder in the
      // "Reorder Routes" tab and press "Send Final Route" (route_reorder.js) for
      // the real delivery. Only the per-van buttons stage; the final send builds
      // its own payload without stage_only.
      stage_only: true,
      timestamp: new Date().toISOString()
    };
  }

  function setButtonState(btn, st) {
    if (!btn) return;
    btn.classList.remove('is-sending', 'is-success', 'is-failed', 'is-waiting');
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
  // Stage confirmation — ask the STORE, not the response (2026-08-04, Load Plan BUGS.md #41)
  // ----------------------------------------------------------------
  // When this was written (2026-08-04, part 1) neither end of the pipeline could
  // tell the operator whether a stage landed, in EITHER direction:
  //   - the Apps Script returned a lock timeout as HTTP 200 + {error:…}, so
  //     n8n's Stage — Save node reported success;
  //   - 889's "Respond to Van Manager" derived `ok` from Fuzzy Match Dogs /
  //     Build RouteXL Request / Format Route and never referenced Stage — Save.
  // So `ok:true` did NOT mean staged, and a lost/slow response did NOT mean
  // not staged (on 2026-08-03 exec 309727 wrote the row while this page was
  // showing red). The ReorderQueue was the only authority, so we ask it.
  //
  // PART 2 (same bug, backend) added a server-side signal: the response now
  // carries `staged` — true (the store confirmed the row), false (Stage — Save
  // answered without confirming), or null (it never ran). That is used as an
  // ACCELERATOR, not a replacement: `staged:true` settles the button on the spot
  // instead of waiting for the next poll, and `staged:false` shortens the wait
  // to one more poll. The store remains the authority, because a response can
  // still be lost entirely — which is exactly how this bug presented.
  //
  // Matching is by VAN + freshness, never by rebuilding the slot key: the
  // section grammar (period + run_type → HALF_DAY/PM/NEXT_AM) lives in the
  // Apps Script (reorderSection_) and duplicating it here would add another
  // copy of a shared grammar for no gain. A slot whose staged_at is at or
  // after this click can only have come from this click — the fleet latch
  // guarantees no other stage is in flight.
  function readStore() {
    try {
      if (window.RouteReorder && typeof window.RouteReorder.getStaged === 'function') {
        return window.RouteReorder.getStaged();
      }
    } catch (e) {}
    return Promise.reject(new Error('store reader unavailable'));
  }

  // Does the store hold the slot THIS CLICK produced?
  //
  // ⚠️ Matches the EXACT stamp this client sent, not a freshness window.
  // Until 2026-08-04 this accepted any slot for the van with
  // `staged_at >= sinceMs - 1000`, justified by a comment claiming "the fleet
  // latch guarantees no other stage is in flight". **The fleet latch is per
  // PAGE**, and two office devices are a normal morning: A stages BVX at
  // 09:00:00, B stages BVX at 09:00:02, B's row lands last — and A's poll saw
  // B's row as its own, showed ✅, and wrote A's stop numbers into A's grid
  // while the store actually held B's route.
  //
  // The stamp is safe to match exactly because it is this client's own and it
  // survives the whole chain byte-for-byte — verified live 2026-08-04:
  //   payload.timestamp (new Date().toISOString() at click)
  //     → stage2 `payload.timestamp` → stage4 `route_record.ts`
  //     → Apps Script `staged_at` cell → loadStaged `staged_at`
  // e.g. exec 314175 posted "2026-08-04T07:44:21.993Z" and HALF_DAY__SV still
  // reports exactly that. Compared through Date.parse so a future
  // representation change (a Sheets Date coercion) still compares as an
  // instant rather than a string.
  //
  // Tightening this to exact-only is only safe BECAUSE fix 1 shipped alongside
  // it: the response's own `staged:true` is now a second, independent
  // confirmation path, so a store match that somehow failed can no longer
  // strand the button. Do not tighten one without the other.
  function slotLanded(data, van, stampMs) {
    if (!data || !Array.isArray(data.slots)) return false;
    if (isNaN(stampMs)) return false;
    var want = String(van || '').toUpperCase();
    for (var i = 0; i < data.slots.length; i++) {
      var s = data.slots[i] || {};
      var ctx = s.ctx || {};
      if (String(ctx.v || s.van || '').toUpperCase() !== want) continue;
      if (s.status === 'CLEARED') continue;
      if (Date.parse(s.staged_at || '') === stampMs) return true;
    }
    return false;
  }

  // Polls the store until the van's slot appears, or `ceilingMs` elapses.
  // Returns { promise, shortenTo }: the promise resolves true (landed) / false
  // (did not) and NEVER rejects — an unreachable store must not be reported to
  // the operator as a failed stage. `shortenTo(ms)` pulls the deadline in (never
  // pushes it out), so a server-side `staged:false` can stop the operator staring
  // at the full ceiling for an answer that has already arrived.
  function awaitStageLanded(van, stampMs, ceilingMs) {
    var deadline = Date.now() + ceilingMs;
    var promise = new Promise(function (resolve) {
      var stopped = false;
      function attempt() {
        if (stopped) return;
        // Test the deadline HERE as well as in next(): without this, one poll
        // always fires after the deadline and can burn the store's whole abort
        // budget (STORE_TIMEOUT_MS) before resolving — a 150 s ceiling behaved
        // like ~180 s, and a shortenTo() could be swallowed entirely by a poll
        // that was already in flight.
        if (Date.now() >= deadline) { stopped = true; resolve(false); return; }
        readStore().then(function (data) {
          if (stopped) return;
          if (slotLanded(data, van, stampMs)) { stopped = true; resolve(true); return; }
          next();
        }).catch(function () { if (!stopped) next(); });
      }
      function next() {
        if (Date.now() >= deadline) { stopped = true; resolve(false); return; }
        setTimeout(attempt, STORE_POLL_MS);
      }
      setTimeout(attempt, STORE_POLL_DELAY_MS);
    });
    return {
      promise: promise,
      shortenTo: function (ms) {
        var d = Date.now() + ms;
        if (d < deadline) deadline = d;
      }
    };
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

  function applyReturnedStops(van, stops, sentPeriod, opts) {
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
    var useLane = getCurrentPeriod() === 'PM';
    var lane = String(opts && opts.lane || '').toUpperCase() === 'HD' ? 'HD' : 'FD';

    // This van's placed tiles, each with its kennel + slot.
    var slots = [];
    Object.keys(st.placements).forEach(function (boxId) {
      if (boxId.indexOf(prefix) !== 0) return;
      var tileIds = (st.placements[boxId] || []).filter(function (tileId) {
        if (!useLane) return true;
        var tile = st.tiles[tileId];
        return (tile && tile.rt === 'HD' ? 'HD' : 'FD') === lane;
      });
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
          hostSetStopValue(best.boxId, best.slot, String(s.stop), useLane ? lane : undefined);
          applied++;
        } catch (e) { console.warn('[RouteSender] setStopValue failed:', e); }
      } else {
        unmatched.push(s.name);
      }
    });

    // Overlay mode (2026-08-02, store→grid alignment): stale stop numbers on
    // this van's tiles that matched NO routed dog are cleared — a dog pulled
    // off the route must not keep last stage's number. Guarded on applied>0
    // so a grid that matched nothing (wrong plan/day) is never blanked.
    if (opts && opts.clearUnmatched && applied) {
      slots.forEach(function (slot) {
        if (claimed[slot.tileId]) return;
        try { hostSetStopValue(slot.boxId, slot.slot, '', useLane ? lane : undefined); } catch (e) {}
      });
    }

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
    // Load Plan BUGS.md #41 (2026-08-04) — the latch is the authority, not `btn.disabled`. A
    // button rendered (or re-bound) AFTER the latch went on would not carry
    // the disabled attribute, and concurrent stages are exactly the script-lock
    // contention this guard exists to prevent.
    if (stagingInFlight) {
      console.warn('[RouteSender] Ignored click: a stage is already in flight.');
      return;
    }
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

    // Staging-tray nudge (2026-07-19) — non-blocking, never stops the send.
    warnTrayDogs();

    // Load Plan BUGS.md #41 (2026-08-04): reference time for the store confirmation, and the
    // fleet latch. Taken BEFORE the POST so a stage that lands unusually fast
    // still compares as "after this click".
    // The store is matched on the payload's OWN timestamp, which is what
    // becomes `staged_at` end to end — not on the click's wall-clock, which
    // only ever supported the old (cross-device-unsafe) freshness window.
    var clickedAtMs = Date.now();
    var stampMs = Date.parse(payload && payload.timestamp ? payload.timestamp : '');
    if (isNaN(stampMs)) stampMs = clickedAtMs;   // belt and braces; buildPayload always stamps
    setButtonState(btn, 'sending');
    setFleetLatch(true, btn);

    // Everything below settles through ONE of these two helpers, so the latch
    // can never be left on. `landed` is the authority; the n8n response only
    // decides which WORDING the operator sees.
    // Additive: drop the optimised stop numbers n8n returns into the kennels.
    // Any match issue is logged, never surfaced to the button. ONE copy — the
    // response and the store can settle in either order, and before this was
    // factored out both orders carried their own duplicate of it.
    function applyStops(body) {
      try {
        if (body && Array.isArray(body.stops) && body.stops.length) {
          applyReturnedStops(van, body.stops, sentPeriod, { lane: payload.run_type });
        }
      } catch (e) {
        console.warn('[RouteSender] Could not apply stop numbers (' + van + '):', e);
      }
    }

    function finishStaged(body) {
      setButtonState(btn, 'success');
      try {
        if (window.RouteReorder && window.RouteReorder.toast) {
          window.RouteReorder.toast('Staged in Reorder Routes — drag to reorder, then Send Final', 'info');
        }
      } catch (e) {}
      setFleetLatch(false, btn);
      setTimeout(function () { setButtonState(btn, 'idle'); }, SUCCESS_HOLD_MS);
      console.log('[RouteSender] Staged ' + van + ' (confirmed).');
      applyStops(body);
    }

    // A genuine miss. The button stays DEAD for RETRY_COOLDOWN_MS: an Apps
    // Script execution abandoned by n8n keeps running and keeps the script
    // lock, so an instant retry lands straight back into the contention that
    // caused the miss. Counting down is deliberate — a button that is merely
    // dead reads as broken and gets clicked anyway.
    function finishNotStaged(reason, hard) {
      var labelEl = btn.querySelector('.send-route-btn__label') || btn;
      btn.classList.remove('is-sending', 'is-success');
      btn.classList.add('is-failed');
      btn.disabled = true;
      try {
        if (window.RouteReorder && window.RouteReorder.toast) {
          window.RouteReorder.toast(van + ' was NOT staged — ' + reason, 'warning');
        }
      } catch (e) {}
      console.error('[RouteSender] Stage did not land for ' + van + ': ' + reason);
      setFleetLatch(false, btn);
      // Claim the cooldown BEFORE releasing the latch reaches anyone else, so
      // no other van's unlatch can cut it short (see inCooldown).
      btn.dataset.rsCooldownUntil = String(Date.now() + RETRY_COOLDOWN_MS);
      var left = Math.ceil(RETRY_COOLDOWN_MS / 1000);
      labelEl.textContent = (hard ? LABEL_FAILED : LABEL_NOTLANDED) + ' (' + left + ')';
      var tick = setInterval(function () {
        left -= 1;
        if (left > 0) {
          labelEl.textContent = (hard ? LABEL_FAILED : LABEL_NOTLANDED) + ' (' + left + ')';
          return;
        }
        clearInterval(tick);
        delete btn.dataset.rsCooldownUntil;
        setButtonState(btn, 'idle');
      }, 1000);
    }

    // THE STORE OWNS THE OUTCOME. The watcher runs in PARALLEL with the
    // request and settles the button on its own, so the UI no longer depends
    // on the response arriving at all — which is the whole point: on
    // 2026-08-03 the response was lost and the write had landed. It also
    // releases the button the moment the route appears (typically 5–20 s)
    // instead of waiting out the ceiling.
    //
    // The request contributes exactly two things: a FAST FAIL when the engine
    // itself failed, and the stop numbers to write back. It never declares
    // success — `ok` does not include Stage — Save.
    var settled = false;
    var succeeded = false;
    var lastBody = null;

    function settle(fn) {
      if (settled) return;
      settled = true;
      fn();
    }

    var watcher = awaitStageLanded(van, stampMs, STAGE_CEILING_MS);
    var notStagedReason = 'it has not appeared in the Reorder tab. The staging store may be busy — wait for the countdown, then try ONCE.';

    watcher.promise.then(function (landed) {
      if (landed) settle(function () { succeeded = true; finishStaged(lastBody); });
      else settle(function () { finishNotStaged(notStagedReason, false); });
    });

    postToN8n(payload).then(function (res) {
      var parseBody = (res && typeof res.json === 'function')
        ? res.json().catch(function () { return null; })
        : Promise.resolve(null);
      return parseBody.then(function (body) {
        lastBody = body;
        // `ok:false` is n8n telling us the ENGINE failed (dog not found,
        // ambiguous name, RouteXL down, every dog skipped). That is the ONE
        // case where "check the dog names" is the right advice, and it is
        // decisive — no route was built, so nothing can ever land. Fail now
        // rather than making the operator watch out the whole ceiling.
        if (body && body.ok === false) {
          settle(function () {
            finishNotStaged('the route could not be built. Check the dog names against the master sheet, then try again.', true);
          });
          return;
        }
        // If the store already confirmed before the response arrived, the
        // stop numbers still have to be written back — finishStaged ran with
        // a null body, so do it here.
        if (settled && succeeded) { applyStops(body); return; }

        // `staged` — the server-side storage result (889 "Respond to Van
        // Manager", added 2026-08-04 with BUGS.md #41 fix 1). Absent on any
        // pre-fix 889, which is why nothing below treats "not true" as failure.
        //   true  → the ReorderQueue confirmed the row. Settle now instead of
        //           waiting up to STORE_POLL_MS for the next poll to say so.
        //   false → Stage — Save answered and did not confirm. Under fix 3 the
        //           store refuses BEFORE it writes anything, so this is
        //           decisive — but the store stays the authority, so give it one
        //           more poll rather than settling straight off a response.
        if (body && body.staged === true) {
          settle(function () { succeeded = true; finishStaged(body); });
          return;
        }
        if (body && body.staged === false) {
          notStagedReason = 'the staging store was busy and did not take it. Wait for the countdown, then try ONCE.';
          watcher.shortenTo(STORE_POLL_MS + 1000);
          return;
        }
        // Otherwise: say nothing. The store watcher owns the verdict.
      });
    }).catch(function (err) {
      // A failed or timed-out request is NOT evidence that the stage failed
      // (2026-08-03: the browser gave up at 30 s on a stage already written).
      // Log it and leave the verdict to the store.
      console.warn('[RouteSender] Stage request did not return cleanly for ' + van +
        ' — deferring to the staging store:', err);
    });
  }

  // ------------------------------------------------------------------
  // Staging-tray nudge (added 2026-07-19). Dogs left in the tray (a tile
  // with no kennel placement — XV priority pickups land there by design
  // since the whiteboard transfer stopped auto-vanning them) ride NO
  // route. Non-blocking warning every time a route is staged while the
  // tray still holds dogs, so nobody is silently left behind.
  // ------------------------------------------------------------------
  function getTrayDogs() {
    var st = safeState();
    if (!st || !st.tiles) return [];
    var placed = {};
    Object.keys(st.placements || {}).forEach(function (boxId) {
      (st.placements[boxId] || []).forEach(function (id) { placed[id] = true; });
    });
    return Object.keys(st.tiles)
      .filter(function (id) { return !placed[id]; })
      .map(function (id) { return String((st.tiles[id] && st.tiles[id].text) || '').trim(); })
      .filter(Boolean);
  }

  function warnTrayDogs() {
    try {
      var tray = getTrayDogs();
      if (!tray.length) return;
      var msg = '🔴 ' + tray.length + ' dog' + (tray.length === 1 ? '' : 's') +
        ' still in the staging tray (on no route): ' + tray.join(', ');
      if (window.RouteReorder && window.RouteReorder.toast) {
        window.RouteReorder.toast(msg, 'warning');
      } else {
        console.warn('[RouteSender] ' + msg);
      }
    } catch (e) { /* nudge only — never block a send */ }
  }

  // Tray check for a SPECIFIC plan, read from the page's saved localStorage
  // snapshot (van_v5_<planId>) rather than the live state — the Reorder tab's
  // Send Final Route may commit a slot belonging to a plan that is NOT the one
  // currently loaded in the page. The page localSaves on every mutation, so
  // the snapshot is current. Used by route_reorder.js sendFinal (2026-07-19).
  function getTrayDogsForPlan(planId) {
    try {
      var raw = localStorage.getItem('van_v5_' + String(planId || ''));
      if (!raw) return [];
      var st = JSON.parse(raw);
      if (!st || !st.tiles) return [];
      var placed = {};
      Object.keys(st.placements || {}).forEach(function (boxId) {
        (st.placements[boxId] || []).forEach(function (id) { placed[id] = true; });
      });
      return Object.keys(st.tiles)
        .filter(function (id) { return !placed[id]; })
        .map(function (id) { return String((st.tiles[id] && st.tiles[id].text) || '').trim(); })
        .filter(Boolean);
    } catch (e) { return []; }
  }

  function bindButtons(root) {
    var scope = root || document;
    var buttons = scope.querySelectorAll('.send-route-btn');
    buttons.forEach(function (btn) {
      if (btn.dataset.routeSenderBound === '1') return;
      btn.addEventListener('click', handleSendClick);
      btn.dataset.routeSenderBound = '1';
      // Load Plan BUGS.md #41 (2026-08-04): a button that appears mid-stage joins the latch,
      // so the fleet-wide "one stage at a time" rule survives a re-render.
      if (stagingInFlight && btn !== stagingBtn) {
        var lbl = btn.querySelector('.send-route-btn__label') || btn;
        if (btn.dataset.rsIdleLabel === undefined) btn.dataset.rsIdleLabel = lbl.textContent;
        btn.disabled = true;
        btn.classList.add('is-waiting');
        lbl.textContent = LABEL_WAITING;
      }
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
      hostMoveTileToBox = typeof opts.moveTileToBox === 'function' ? opts.moveTileToBox : null;
      hostCreateTileInBox = typeof opts.createTileInBox === 'function' ? opts.createTileInBox : null;
      hostMoveTileToTray = typeof opts.moveTileToTray === 'function' ? opts.moveTileToTray : null;
      bindButtons();
      bindToggles();
      console.log('[RouteSender] Initialised. State accessor wired:',
        !!hostGetState, '— currentPlan accessor wired:', !!hostGetCurrentPlan,
        '— stop write-back wired:', !!hostSetStopValue,
        '— kennel write-back wired:', !!hostMoveTileToBox);
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
    // Kennel write-back (added 2026-07-31) — called by route_reorder.js when a
    // dog's kennel is changed on the Reorder tab (one-way, assignments only).
    applyKennelFromReorder: applyKennelFromReorder,
    planCrossVanPlacement: planCrossVanPlacement,
    classifyOverlayDog: classifyOverlayDog,
    moveRemovedDogToTray: moveRemovedDogToTray,
    clearVanStops: clearVanStops,
    // Staging-tray nudge helpers (2026-07-19) — getTrayDogsForPlan is read by
    // route_reorder.js sendFinal (plan-matched left-behind guard).
    getTrayDogs: getTrayDogs,
    getTrayDogsForPlan: getTrayDogsForPlan,
    // For Stage 2+ when you want to wire the URL in code rather than
    // editing this file.
    setWebhookUrl: function (url) { N8N_WEBHOOK_URL = String(url || ''); }
  };
})();
