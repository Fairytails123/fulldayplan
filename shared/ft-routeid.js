/* FT-SHARED — route-id rules: mint / parse / day-stamp / slot rid.
 *
 * Provenance — unifies three live implementations (behaviour replicated exactly):
 *   1. /drive app  — "Van ETA and Tracking\build\drive\ui\index.html" lines ~709–741:
 *      ymdLondon(), stampToYmd(), slotRid() incl. the B24 midnight snap.
 *   2. W1 ingest   — VAN-ETA W1 "Validate & Shape" Code node (workflow sop0phvTHDNB9kEE,
 *      backup "Van ETA and Tracking\backups\workflows\sop0phvTHDNB9kEE.2026-07-17.baseline-p1.json"):
 *      route_id mint (routeType + stampToDate + B24 midnight snap).
 *   3. 889 pipeline — "Full Day Load Plan\stage4_format_route.js" ~line 150:
 *      run_type whitelist FD/HD/'' (so mint's "anything non-HD → PM" matches W1),
 *      and (added 2026-07-17, P3c) fmtDayStamp_ ~line 160 → makeStamp() below.
 *
 * Route ids: YYYY-MM-DD-VAN-TYPE, TYPE ∈ AM | PM | HD (Half-Day split from PM 2026-07-14).
 * All date maths Europe/London. Change the rule here AND in the three sources together.
 *
 * Deployed by FT-SHARED marker injection (tools\vps_n8n.py inject) — do not add
 * markers in this file by hand.
 */
(function (root) {
  'use strict';

  function toMs(now) {
    if (now == null) return Date.now();
    if (now instanceof Date) return now.getTime();
    var n = Number(now);
    return isFinite(n) ? n : Date.now();
  }

  /* London calendar date of (now + offsetDays), as YYYY-MM-DD (en-CA = ISO). */
  function ymdLondon(offsetDays, now) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(toMs(now) + (offsetDays || 0) * 86400000));
  }

  /* Minutes since London midnight at `now` (h23, so 00:xx never reads as 24:xx). */
  function minutesLondon(now) {
    var hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
      .format(new Date(toMs(now)));
    return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  }

  var DEP_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

  /* 'WD DD/MM' staged day-stamp → YYYY-MM-DD resolved to the nearest
     future-or-today date within today..+7 Europe/London, else ''.
     Identical grammar + window as the app's stampToYmd and W1's stampToDate. */
  function stampToYmd(stamp, now) {
    var m = /(?:MON|TUE|WED|THU|FRI|SAT|SUN)\s+(\d{1,2})\/(\d{1,2})/i.exec(String(stamp == null ? '' : stamp));
    if (!m) return '';
    var dd = ('0' + m[1]).slice(-2), mm = ('0' + m[2]).slice(-2);
    for (var k = 0; k <= 7; k++) {
      var c = ymdLondon(k, now);
      if (c.slice(8, 10) === dd && c.slice(5, 7) === mm) return c;
    }
    return '';
  }

  /* stage4_format_route.js's fmtDayStamp_ replicated exactly (889 "Format
     Route", ~line 160): the 'WD DD/MM' day-stamp (e.g. 'MON 28/06') —
     en-GB short weekday sliced to 3 chars + upper-cased, 2-digit day/month,
     Europe/London; '' when any part is missing or the formatter throws.
     Pass a Date (stage4 always does; anything Intl.format accepts behaves
     identically). NOTE: no offset/now defaulting on purpose — the CALLER owns
     the NEXT_AM +1-day shift, exactly as stage4 shifts runDate before calling. */
  function makeStamp(date) {
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London', weekday: 'short', day: '2-digit', month: '2-digit'
      }).formatToParts(date);
      var wd = '', dd = '', mm = '';
      parts.forEach(function (p) {
        if (p.type === 'weekday') wd = p.value;
        else if (p.type === 'day') dd = p.value;
        else if (p.type === 'month') mm = p.value;
      });
      if (!wd || !dd || !mm) return '';
      return wd.slice(0, 3).toUpperCase() + ' ' + dd + '/' + mm;   // MON 28/06
    } catch (e) { return ''; }
  }

  /* W1's mint: TYPE = period 'NEXT_AM' → AM; else run_type 'HD' → HD; else PM.
     (stage4 whitelists run_type to FD/HD/'' upstream, so any non-HD value lands
     on PM — exactly the live behaviour.) */
  function mint(opts) {
    var o = opts || {};
    var van = String(o.van || '').trim().toUpperCase();
    var period = String(o.period || '').trim().toUpperCase();
    var runType = String(o.run_type || '').trim().toUpperCase();
    var type = period === 'NEXT_AM' ? 'AM' : (runType === 'HD' ? 'HD' : 'PM');
    return String(o.date || '') + '-' + van + '-' + type;
  }

  var RID_RE = /^(\d{4}-\d{2}-\d{2})-([A-Z][A-Z0-9]*)-(AM|PM|HD)$/;
  function parse(rid) {
    var m = RID_RE.exec(String(rid == null ? '' : rid));
    return m ? { date: m[1], van: m[2], type: m[3] } : null;
  }

  /* The /drive app's slotRid(), replicated exactly:
     - HD when the slot sits in the HALF_DAY section OR ctx.rt === 'HD' (never for NEXT_AM);
     - date from the staged 'WD DD/MM' stamp (ctx.dt), else today (tomorrow for NEXT_AM);
     - B24 midnight snap: a NEXT_AM dated ahead of today, evaluated 00:00–03:59
       Europe/London BEFORE its departure time (ctx.t; no/invalid time = always
       snap in the window), snaps back to today — same rule W1 applies at ingest. */
  function slotRid(slotCtx, section, van, now) {
    var ctx = slotCtx || {};
    var nextAm = String(ctx.p || '').toUpperCase() === 'NEXT_AM';
    var halfDay = !nextAm && (String(section || '').toUpperCase() === 'HALF_DAY' || String(ctx.rt || '').toUpperCase() === 'HD');
    var date = stampToYmd(ctx.dt, now) || ymdLondon(nextAm ? 1 : 0, now);
    if (nextAm && date > ymdLondon(0, now)) {
      var nowMin = minutesLondon(now);
      var dep = DEP_RE.exec(String(ctx.t || ''));
      var depMin = dep ? (Number(dep[1]) * 60 + Number(dep[2])) : null;
      if (nowMin < 240 && (depMin === null || nowMin < depMin)) { date = ymdLondon(0, now); }
    }
    return date + '-' + String(van || '').trim().toUpperCase() + '-' + (nextAm ? 'AM' : (halfDay ? 'HD' : 'PM'));
  }

  var api = { mint: mint, parse: parse, stampToYmd: stampToYmd, makeStamp: makeStamp, slotRid: slotRid, ymdLondon: ymdLondon };
  root.FT_ROUTEID = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis);
