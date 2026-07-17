/* ==================================================================
 * FT_PAYLOAD — the single source for the `/webhook/van-route` POST
 * payload (ROUTES-PLATFORM-PLAN P5 offline groundwork, 2026-07-17).
 * ------------------------------------------------------------------
 * PROVENANCE — this module unifies the three hand-mirrored builders
 * that previously had to be kept in step by comment-enforced mirror
 * rules:
 *   1. STAGE  — "Full Day Load Plan\route_sender.js" buildPayload()
 *      (per-van "📍 Stage Route" button; stage_only:true; dogs are
 *      the RAW tile strings with G.D./ALT tokens left on; positions
 *      is { <normName(dog)>: <kennel code> }; start/end model incl.
 *      the legacy return_trip alias; NO run_stamp / skip_optimisation
 *      / extra_stops).
 *   2. FINAL  — "Full Day Load Plan\route_reorder.js" sendFinal() +
 *      flattenWithMarkers() ("📍 Send Final Route"; dogs rebuilt from
 *      the staged ROUTE_CTX order ctx.o with " G.D." re-appended THEN
 *      " ALT" (ctx.gg / ctx.aa hold canonical member names);
 *      run_stamp = ctx.dt; positions = ctx.kp; skip_optimisation:true;
 *      extra_stops from ctx.ex ONLY when non-empty after filtering to
 *      dogs still on the route; NO stage_only / is_reorder / is_update).
 *   3. DRIVE  — "Van ETA and Tracking\build\drive\ui\index.html"
 *      queuePayload() (driver app; a faithful port of sendFinal's
 *      build — returns null when the route is empty).
 *
 * Deployed via FT-SHARED marker injection; adopted per-consumer in P5.
 *
 * PARITY — proven offline by shared\tests\_trace_payloadparity.mjs,
 * which extracts and EXECUTES the three real builders against a
 * fixture matrix and deep-compares their payloads with this module's
 * (key-order-insensitive; a missing key vs undefined IS a difference).
 * Re-run it after ANY edit here or to the three source builders.
 *
 * DETERMINISM — no Date.now()/new Date() inside: callers inject the
 * timestamp (`nowIso`). Real consumers pass new Date().toISOString().
 *
 * Dependency-free vanilla JS (ES5-compatible). British English.
 * ================================================================== */

(function (root) {
  'use strict';

  // ---- shared name normaliser --------------------------------------
  // Byte-identical semantics to route_reorder.js normNm() and the
  // drive app's normNm(): lowercase, collapse whitespace, trim.
  // (NOT normKey — no accent folding, no punctuation stripping.)
  function normNm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function normSet(arr) {
    var m = {};
    (arr || []).forEach(function (n) { m[normNm(n)] = true; });
    return m;
  }

  // ---- FINAL: flatten the staged stop order, re-applying markers ----
  // o  = ctx.o — array of stops, each stop an ARRAY of member names
  //      (households share one stop, e.g. ["Hugo","Milo"]).
  // gg = ctx.gg — canonical names of grooming dogs (get " G.D." back).
  // aa = ctx.aa — canonical names of second-address dogs (get " ALT").
  // Order matters: append G.D. then ALT — Stage 2 strips ALT then G.D.
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

  // ---- STAGE: departure-time normaliser -----------------------------
  // Byte-identical semantics to route_sender.js normaliseDeparture():
  // legacy "07:30 am" values convert to 24h HH:MM; already-24h values
  // pass through; anything unparseable passes through trimmed; falsy
  // input returns ''.
  function normaliseDeparture(raw) {
    if (!raw) return '';
    var m = String(raw).trim().match(/^(\d{1,2}):(\d{2})\s*([ap]m)?$/i);
    if (!m) return String(raw).trim();
    var h = parseInt(m[1], 10);
    var min = m[2];
    var ampm = (m[3] || '').toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    return (h < 10 ? '0' + h : String(h)) + ':' + min;
  }

  // ---- STAGE builder ------------------------------------------------
  // spec = {
  //   van,                // 'BV' | 'SV' | 'DV' (any case — uppercased here)
  //   period,             // 'AM' | 'PM' | 'NEXT_AM'; non-string/empty → 'PM'
  //   departure_time,     // raw dropdown value ('15:00' or legacy '03:00 pm')
  //   run_type,           // raw dropdown value; whitelisted FD/HD, PM-only
  //   dogs,               // RAW tile strings, G.D./ALT tokens left ON
  //   positions,          // { <normName(dog)>: <kennel code> } (already built)
  //   start_from_centre,  // default true (only literal false unsets it)
  //   start_address,      // used only when start_from_centre === false
  //   return_to_centre,   // default true (only literal false unsets it)
  //   end_address         // used only when return_to_centre === false
  // }
  // nowIso — the timestamp string (caller passes new Date().toISOString()).
  function buildStage(spec, nowIso) {
    spec = spec || {};
    // period: route_sender getCurrentPeriod() falls back to 'PM'.
    var period = (typeof spec.period === 'string' && spec.period) ? spec.period : 'PM';
    // run_type: PM-plan only ('' on AM/NEXT_AM), whitelisted to FD/HD.
    var runType = '';
    if (period === 'PM') {
      var v = spec.run_type ? String(spec.run_type).toUpperCase().trim() : '';
      runType = (v === 'FD' || v === 'HD') ? v : '';
    }
    // dogs: raw tile strings — truthy entries only, trimmed (tokens kept).
    var dogs = [];
    (Array.isArray(spec.dogs) ? spec.dogs : []).forEach(function (d) {
      if (d) dogs.push(String(d).trim());
    });
    // positions: fresh object (route_sender builds one per call).
    var positions = {};
    if (spec.positions && typeof spec.positions === 'object') {
      Object.keys(spec.positions).forEach(function (k) { positions[k] = spec.positions[k]; });
    }
    // start/end model — identical defaulting to route_sender buildPayload().
    var startFromCentre = spec.start_from_centre !== false;   // default true
    var returnToCentre  = spec.return_to_centre  !== false;   // default true
    var startAddress = startFromCentre ? '' : String(spec.start_address || '').trim();
    var endAddress   = returnToCentre  ? '' : String(spec.end_address   || '').trim();
    return {
      van: String(spec.van).toUpperCase(),
      period: period,
      departure_time: normaliseDeparture(spec.departure_time),
      run_type: runType,
      dogs: dogs,
      positions: positions,
      start_from_centre: startFromCentre,
      start_address: startAddress,
      return_to_centre: returnToCentre,
      end_address: endAddress,
      // Backward-compatible alias: older workflow versions read return_trip.
      return_trip: returnToCentre,
      // STAGE the route (write ReorderQueue + respond; NO Telegram send).
      stage_only: true,
      timestamp: String(nowIso || '')
    };
  }

  // ---- FINAL builder ------------------------------------------------
  // ctx  = the staged ROUTE_CTX: { v, p, t, rt, r, s, sa, ea, o, gg,
  //        aa, kp, dt, ex } (ex entries: { d, a, lat, lng }).
  // opts = { nowIso } — the timestamp string.
  // Returns the payload, or null when the flattened route is empty
  // (mirrors queuePayload(); sendFinal() aborts with a toast there).
  function buildFinal(ctx, opts) {
    ctx = ctx || {};
    opts = opts || {};
    var dogs = flattenWithMarkers(ctx.o || [], ctx.gg || [], ctx.aa || []);
    if (!dogs.length) return null;

    // EXACTLY the normal first-send payload + skip_optimisation:true so
    // RouteXL returns the staff order WITH ETAs and Format Route renders
    // the byte-identical "🚐 … route ready" message.
    // NO is_reorder / is_update / stage_only.
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
      // Staged day+date stamp — Format Route whitelists + reuses it
      // (empty → it computes its own).
      run_stamp: ctx.dt || '',
      // Staged kennel positions (ROUTE_CTX.kp) — the final send is a
      // fresh webhook POST, so without this they never reach Format Route.
      positions: ctx.kp || {},
      skip_optimisation: true,
      timestamp: String(opts.nowIso || '')
    };

    // Dogs ADDED via the "Add Dog" panel are off the Master sheet, so
    // they carry their geocoded coords as extra_stops → Stage 2 routes
    // them via the _pre_resolved bypass WITHOUT is_update. Filter ctx.ex
    // to dogs still on the route (a removed added-dog leaves its ex
    // entry behind but must NOT be re-injected). Key ABSENT when empty.
    var present = {};
    dogs.forEach(function (nm) { present[normNm(nm)] = true; });
    var extra = (ctx.ex || []).filter(function (e) {
      return e && e.lat != null && e.lng != null && present[normNm(e.d)];
    }).map(function (e) {
      return { dog: e.d, address: e.a, lat: Number(e.lat), lng: Number(e.lng) };
    });
    if (extra.length) payload.extra_stops = extra;

    return payload;
  }

  // ---- public surface ----------------------------------------------
  var FT_PAYLOAD = {
    buildStage: buildStage,
    buildFinal: buildFinal,
    flattenWithMarkers: flattenWithMarkers,   // exposed for reuse
    normNm: normNm,                           // exposed for reuse (present[...] keys etc.)
    normaliseDeparture: normaliseDeparture    // exposed for reuse (STAGE dropdown values)
  };

  root.FT_PAYLOAD = FT_PAYLOAD;
  // Two-line CommonJS guard so Node's require() (parity harness) works too.
  if (typeof module !== 'undefined' && module.exports) { module.exports = FT_PAYLOAD; }
})(typeof globalThis !== 'undefined' ? globalThis
  : (typeof window !== 'undefined' ? window : this));
