/* FT-SHARED — dog-name primitives + the THREE incident-hardened matching policies.
 *
 * ⚠️ ONE SOURCE, THREE BEHAVIOURS — do NOT merge the policies. Each policy below
 * closed a real production incident; collapsing them into one "smart" matcher
 * would re-open closed incidents:
 *   - 2026-06-16: fuzzy Levenshtein ≥0.70 cross-matched "Millie Carter" with
 *     "Millie Cartwright" (similarity ≈0.706) and mis-routed to the wrong house.
 *     policyS2Exact / policyWbExact are EQUALITY-ONLY for that reason — no fuzzy
 *     matching may ever return to the route↔master or route↔board paths.
 *   - 2026-07-16 (Van ETA bug B30): first-word-only contact matching silently
 *     picked the WRONG household (Benson Terrell → Benson Pottle) and a test
 *     fixture. policyW1Surname is the surname-corroborated replacement — it
 *     refuses zero-signal ambiguity rather than guess.
 * The three policies are deliberately DISTINCT named functions even where their
 * bodies look similar today.
 *
 * Provenance — behaviour replicated exactly from the live implementations:
 *   GROOMING_RE = /(^|\s)G\.?D\.?$/i — "Full Day Load Plan\stage2_fuzzy_match.js":145
 *     (copies: "Full Day Load Plan\route_sender.js":249,
 *      "Whiteboard Mobile Edit\index_whiteboard.html":3191 inline).
 *   ALT_RE = /(^|\s)ALT$/i — stage2_fuzzy_match.js:169
 *     (copies: route_sender.js:261, "Full Day Load Plan\index_v6.html":2608).
 *   stripTokens — stage2 detectAlt (:170) THEN detectGrooming (:146), the pipeline
 *     order at stage2:568-573 (ALT stripped BEFORE grooming so "Atom G.D. ALT"
 *     → "Atom" with BOTH flags). Stripping-to-nothing keeps the ORIGINAL name
 *     (a bare "ALT"/"GD" is never left nameless — safe soft-skip downstream).
 *   appendTokens — ' G.D.' then ' ALT' (grooming before alt): the
 *     applyReorderMarkers convention, live in
 *     "Van ETA and Tracking\build\drive\ui\index.html":779-780.
 *   normalise — stage2_fuzzy_match.js:63-70.
 *   normaliseBoard — "Whiteboard Mobile Edit\white_board.js" normaliseName_
 *     :1152-1159. Its body is byte-identical to stage2's normalise, so it is
 *     implemented ONCE here and aliased; the parity harness
 *     (shared\tests\_trace_dogname_drift.mjs) PROVES the two live functions
 *     still agree — if either source ever diverges, split the alias.
 *   splitHousehold — the W1 matcher's '&' split: String(label) split on the
 *     regex \s*&\s* then .map(trim).filter(Boolean) (W1 "Resolve Dog Keys" node,
 *     backup "Van ETA and Tracking\backups\workflows\
 *     sop0phvTHDNB9kEE.2026-07-17.baseline-p1.json").
 *   levenshtein / similarity — white_board.js routeLevenshtein_ :1161-1177 /
 *     routeSimilarity_ :1179-1186. ⚠️ Retained ONLY for the van-SIZE roster
 *     resolver (resolveVanFromRoster_, exact-first then ≥0.85 + clear gap).
 *     NEVER use these for route↔board or route↔master dog matching — that is
 *     exactly the retired ≥0.70 fuzzy path that caused the Millie incident.
 *   policyW1Surname — faithful port of the post-B30 W1 "Resolve Dog Keys"
 *     matcher (same backup JSON). NOTE its token strip is DIFFERENT from
 *     stripTokens on purpose: W1 strips g.d./alt tokens ANYWHERE (word-bounded,
 *     /\b(g\.?\s*d\.?|alt)\b\.?/gi) while stage2 strips TRAILING tokens only.
 *     Both are live behaviour — do not "unify" them.
 *
 * GROOMING_RE / ALT_RE are exposed as GETTERS returning a FRESH RegExp per
 * access, so no caller can be bitten by a shared object (mutated lastIndex,
 * monkey-patching). FT_NAMES.GROOMING_RE !== FT_NAMES.GROOMING_RE by design.
 *
 * Verify after ANY edit here or to a source file above:
 *   node shared/tests/_trace_dogname_drift.mjs   (from the workspace root)
 * Dependency-free vanilla JS: browser (window.FT_NAMES), Apps Script / n8n Code
 * node (globalThis.FT_NAMES), Node (require).
 */
(function (root) {
  'use strict';

  /* Canonical literal strings — byte-comparison anchors for the drift harness.
     Any copy of these regexes in any file must be byte-identical to these. */
  var CANONICAL_GROOMING_LITERAL = '/(^|\\s)G\\.?D\\.?$/i';
  var CANONICAL_ALT_LITERAL = '/(^|\\s)ALT$/i';

  /* Private instances used internally (non-global flags — no lastIndex state). */
  var GROOMING_RE_ = /(^|\s)G\.?D\.?$/i;   // stage2_fuzzy_match.js:145
  var ALT_RE_ = /(^|\s)ALT$/i;             // stage2_fuzzy_match.js:169

  /* ---------------------------------------------------------------- primitives */

  /* stage2_fuzzy_match.js:63-70 — lower-case, NFKD, strip everything but
     letters/numbers/space/'/-, collapse whitespace, trim. NB: a CURLY apostrophe
     (U+2019) is NOT folded to a straight one — NFKD leaves it and the character
     class strips it, so "O’Brien" → "obrien" while "O'Brien" → "o'brien". That
     is live behaviour in BOTH stage2 and white_board.js (curly-apostrophe drift
     therefore exact-misses — known, surfaced loudly as not_found/unmatched). */
  function normalise(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{Letter}\p{Number}\s'-]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* white_board.js normaliseName_ :1152-1159 — byte-identical body to stage2's
     normalise, so aliased to the single implementation above. The harness
     proves the two LIVE functions still agree; split this alias if they ever
     diverge. */
  var normaliseBoard = normalise;

  /* stage2 pipeline order (:568-573): ALT first, then G.D. Each step keeps the
     ORIGINAL string when stripping would empty it (detectAlt :174-176,
     detectGrooming :150-152) — the dog is never left nameless; it simply
     won't resolve (safe soft-skip). Returns { clean, is_grooming, is_alt }. */
  function stripTokens(name) {
    var s = String(name == null ? '' : name).trim();
    var is_alt = false;
    var is_grooming = false;
    if (ALT_RE_.test(s)) {
      is_alt = true;
      var strippedAlt = s.replace(ALT_RE_, '').trim();
      s = strippedAlt || s;
    }
    if (GROOMING_RE_.test(s)) {
      is_grooming = true;
      var strippedGd = s.replace(GROOMING_RE_, '').trim();
      s = strippedGd || s;
    }
    return { clean: s, is_grooming: is_grooming, is_alt: is_alt };
  }

  /* Re-append the markers a strip removed — ' G.D.' THEN ' ALT' (grooming
     before alt), the single-pass applyReorderMarkers convention (drive ui
     index.html:779-780). The name is passed through verbatim (no trim). */
  function appendTokens(name, flags) {
    var out = String(name == null ? '' : name);
    flags = flags || {};
    if (flags.is_grooming) out += ' G.D.';
    if (flags.is_alt) out += ' ALT';
    return out;
  }

  /* W1's household split: "Hugo & Milo" → ['Hugo','Milo']. Whitespace around
     '&' absorbed; empty members dropped. */
  function splitHousehold(label) {
    return String(label == null ? '' : label)
      .split(/\s*&\s*/)
      .map(function (m) { return m.trim(); })
      .filter(Boolean);
  }

  /* white_board.js routeLevenshtein_ :1161-1177 — byte-identical port.
     Expects STRINGS (its callers always pre-normalise); go through
     similarity() for names. ⚠️ Roster-resolver use ONLY — see header. */
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = new Array(b.length + 1);
    var curr = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      curr[0] = i;
      for (var k = 1; k <= b.length; k++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
        curr[k] = Math.min(curr[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
      }
      var tmp = prev; prev = curr; curr = tmp;
    }
    return prev[b.length];
  }

  /* white_board.js routeSimilarity_ :1179-1186 — byte-identical port (its
     normaliseName_ ≡ normalise here). ⚠️ Kept ONLY for the van-SIZE roster
     resolver (≥0.85 + gap). Never for route↔board/master dog matching:
     similarity('Millie Carter','Millie Cartwright') ≈ 0.706 — the exact value
     that crossed the retired ≥0.70 route-match threshold. */
  function similarity(a, b) {
    a = normalise(a);
    b = normalise(b);
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    var maxLen = Math.max(a.length, b.length);
    return 1 - (levenshtein(a, b) / maxLen);
  }

  /* ------------------------------------------------- policy 1 — whiteboard */

  /* white_board.js updateVanRoute :1082-1092 (2026-06-16 exact-match change):
     a routed name claims a board row ONLY when the two names are identical
     after normaliseName_(). An empty/blank route name never matches (mirrors
     `if (!routeName) continue;` :1085). Pure pairwise test — the caller owns
     "first unclaimed exact row wins" row-claiming. */
  function policyWbExact(routeName, boardName) {
    var route = String(routeName == null ? '' : routeName).trim();
    if (!route) return false;
    return normaliseBoard(route) === normaliseBoard(boardName);
  }

  /* --------------------------------------------------- policy 2 — stage 2 */

  /* stage2_fuzzy_match.js matchIn :298-334 (2026-06-16 exact-match change):
     a route name resolves ONLY to the sheet row whose name is identical after
     normalise(); an empty query is not_found (:300-306). Pure pairwise test —
     matchIn's LIST-level rules stay in stage2 and are deliberately NOT merged
     here: the single-token ambiguity guard (:336-362, a bare "Poppy" with ≥2
     same-first-token rows is ambiguous, never a guess) and the duplicate-row
     guard (:364-379). */
  function policyS2Exact(routeName, masterName) {
    var query = String(routeName || '').trim();
    if (!query) return false;
    return normalise(query) === normalise(masterName);
  }

  /* ------------------------------------------ policy 3 — W1 (post-B30) */

  /* Faithful ports of the W1 "Resolve Dog Keys" helpers (jsCode in the
     baseline-p1 backup JSON). Note the DIFFERENT strip: word-bounded,
     anywhere-in-string — not the trailing-only stage2 rule. */
  function w1StripSuffixes(n) {
    return String(n || '').replace(/\b(g\.?\s*d\.?|alt)\b\.?/gi, ' ').replace(/\s+/g, ' ').trim();
  }
  function w1FirstWordKey(n) {
    var s = w1StripSuffixes(n);
    return (s.split(' ')[0] || '').toLowerCase();
  }
  function w1SurnameKey(n) {
    var s = w1StripSuffixes(n);
    var parts = s.split(' ').filter(function (w) { return w !== ''; });
    return parts.length > 1 ? parts.slice(1).join(' ').toLowerCase() : '';
  }
  function w1IsFixtureRow(r) {
    return String((r && r.client_name) === undefined || (r && r.client_name) === null ? '' : r.client_name).trim().toLowerCase() === 'fixture';
  }
  function w1Outcode(pc) {
    var m = /^([A-Za-z]{1,2}\d[A-Za-z\d]?)\b/.exec(String(pc || '').trim());
    return m ? m[1].toUpperCase() : '';
  }
  function w1PcOf(text) {
    var m = /([A-Za-z]{1,2}\d[A-Za-z\d]?)\s*(\d[A-Za-z]{2})/.exec(String(text || ''));
    return m ? (m[1] + ' ' + m[2]).toUpperCase() : '';
  }
  function w1Tokens(a) {
    return String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(function (t) { return t.length > 1; });
  }
  function w1Overlap(a, b) {
    var B = {};
    b.forEach(function (t) { B[t] = true; });
    var seen = {};
    var n = 0;
    a.forEach(function (t) { if (B[t] && !seen[t]) { n++; seen[t] = true; } });
    return n;
  }

  /* VAN-ETA W1 "Resolve Dog Keys" (post-B30 hardening, 2026-07-16) — the
     surname-corroborated contact matcher, ported decision-for-decision:
       - try EVERY '&'-household member (was: first member's first word only);
       - when both the member and a candidate carry a surname they must MATCH
         (a different surname is a different household — dropped);
       - a client_name='Fixture' row can never take a SURNAMED real stop;
       - one candidate → match; several → prefer same postcode outcode (+100)
         then highest address-token overlap; ZERO-SIGNAL ambiguity stays
         UNMATCHED — no messages beats the wrong household's messages.
     dogLabel: the stop's dog_name label (may be an '&' household).
     contacts: Dogs-tab rows [{ dog_name, dog_key, client_name, address }].
     stop (optional): { postcode, address, lookup_name } — the tie-break
     signals W1 reads off the stop itself.
     Returns { matched:true, dog_key, client_name, why:'' } on a match, else
     { matched:false, dog_key:'', client_name:'', why:<reason> } — dog_key ''
     is exactly W1's "no messages for this stop" outcome; `why` is an added
     diagnostic label (W1 itself records no reason string). */
  function policyW1Surname(dogLabel, contacts, stop) {
    stop = stop || {};
    var rows = [];
    (contacts || []).forEach(function (r) {
      if (r && (r.dog_name || r.dog_key)) rows.push(r);
    });

    var index = {};
    rows.forEach(function (r) {
      var key = w1FirstWordKey(r.dog_name);
      if (!key) return;
      if (!index[key]) index[key] = [];
      index[key].push(r);
    });

    var dogKey = '';
    var clientName = '';
    var why = 'no_household_members';

    var members = splitHousehold(dogLabel);
    if (!members.length && stop.lookup_name) members.push(String(stop.lookup_name));

    for (var i = 0; i < members.length; i++) {
      var member = members[i];
      var mKey = w1FirstWordKey(member);
      if (!mKey) { why = 'member_has_no_first_word'; continue; }
      var mSurname = w1SurnameKey(member);
      var cands = index[mKey] || [];
      if (mSurname) {
        var sameSurname = cands.filter(function (c) { return w1SurnameKey(c.dog_name) === mSurname; });
        if (sameSurname.length) {
          cands = sameSurname;
        } else {
          /* No exact-surname candidate: a DIFFERENT surname is a different
             household (drop); a Fixture row must never take a real, surnamed
             stop. */
          cands = cands.filter(function (c) { return !w1SurnameKey(c.dog_name) && !w1IsFixtureRow(c); });
        }
      }
      if (cands.length === 1) {
        dogKey = String(cands[0].dog_key || '');
        clientName = String(cands[0].client_name || '');
      } else if (cands.length > 1) {
        /* Prefer the candidate sharing the stop's postcode outcode, then
           highest address-token overlap. */
        var oc = w1Outcode(stop.postcode);
        var best = null;
        var bestScore = 0;
        for (var c = 0; c < cands.length; c++) {
          var cand = cands[c];
          var score = 0;
          var candOut = w1Outcode(w1PcOf(cand.address));
          if (oc && candOut && candOut === oc) score += 100;
          score += w1Overlap(w1Tokens(stop.address), w1Tokens(cand.address));
          if (score > bestScore) { bestScore = score; best = cand; }
        }
        if (best) {
          dogKey = String(best.dog_key || '');
          clientName = String(best.client_name || '');
        } else {
          why = 'ambiguous_zero_signal';
        }
        /* Zero-signal ambiguity stays unmatched — never guess a household. */
      } else {
        why = 'no_candidates';
      }
      if (dogKey) break;
    }

    if (dogKey) return { matched: true, dog_key: dogKey, client_name: clientName, why: '' };
    return { matched: false, dog_key: '', client_name: '', why: why };
  }

  /* ---------------------------------------------------------------- export */

  var api = {
    CANONICAL_GROOMING_LITERAL: CANONICAL_GROOMING_LITERAL,
    CANONICAL_ALT_LITERAL: CANONICAL_ALT_LITERAL,
    stripTokens: stripTokens,
    appendTokens: appendTokens,
    normalise: normalise,
    normaliseBoard: normaliseBoard,
    splitHousehold: splitHousehold,
    levenshtein: levenshtein,
    similarity: similarity,
    policyWbExact: policyWbExact,
    policyS2Exact: policyS2Exact,
    policyW1Surname: policyW1Surname
  };
  /* Fresh RegExp per access — callers can never share (or corrupt) one object. */
  Object.defineProperty(api, 'GROOMING_RE', {
    enumerable: true,
    get: function () { return /(^|\s)G\.?D\.?$/i; }
  });
  Object.defineProperty(api, 'ALT_RE', {
    enumerable: true,
    get: function () { return /(^|\s)ALT$/i; }
  });

  root.FT_NAMES = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis);
