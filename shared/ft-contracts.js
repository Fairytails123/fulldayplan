/* FT-SHARED — cross-project contract constants (routes platform).
 *
 * Provenance (single source for values previously repeated per project):
 *   - VANS: W1 "Validate & Shape" van whitelist ['BV','BVX','SV'] (workflow
 *     sop0phvTHDNB9kEE) + "Van ETA and Tracking\CLAUDE.md" fleet list.
 *   - ROUTES_CHAT_ID: Telegram Routes supergroup id since the 2026-06-04
 *     group→supergroup migration ("Full Day Load Plan\CLAUDE.md" §2.1;
 *     corrected in the VAN-ETA conventions 2026-07-17 — see workspace CONTRACTS.md).
 *   - WEBHOOKS: live VPS n8n webhook paths (https://auto.thefairytails.co.uk/webhook/<path>):
 *     van-route (889 main), van-route-rehearsal, van-eta-route-ingest-p9v4x (W1),
 *     van-eta-drive-data-m3p7 (W15), van-eta-drive-tap-r8c2 (W16),
 *     van-eta-w2-cb-9k4t (W2 callback), geocode-validate (Reorder-tab geocoder).
 *   - ROUTE_ID_RE: route-id grammar YYYY-MM-DD-VAN-TYPE, TYPE ∈ AM|PM|HD
 *     (HD split from PM 2026-07-14) — see ft-routeid.js for the minting rules.
 *
 * Deployed by FT-SHARED marker injection (tools\vps_n8n.py inject) — do not add
 * markers in this file by hand.
 */
(function (root) {
  'use strict';
  var FT_CONTRACTS = {
    VANS: ['BV', 'BVX', 'SV'],
    ROUTES_CHAT_ID: '-1003924276822',
    WEBHOOKS: {
      VAN_ROUTE: 'van-route',
      VAN_ROUTE_REHEARSAL: 'van-route-rehearsal',
      ETA_ROUTE_INGEST: 'van-eta-route-ingest-p9v4x',
      DRIVE_DATA: 'van-eta-drive-data-m3p7',
      DRIVE_TAP: 'van-eta-drive-tap-r8c2',
      W2_CALLBACK: 'van-eta-w2-cb-9k4t',
      GEOCODE_VALIDATE: 'geocode-validate'
    },
    ROUTE_ID_RE: /^\d{4}-\d{2}-\d{2}-(?:BV|BVX|SV)-(?:AM|PM|HD)$/,
    /* Returns the list of required keys MISSING from obj ([] = shape ok).
       A non-object obj is missing every key. */
    assertShape: function (obj, requiredKeys) {
      var keys = Array.isArray(requiredKeys) ? requiredKeys : [];
      if (obj === null || typeof obj !== 'object') return keys.slice();
      var missing = [];
      for (var i = 0; i < keys.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(obj, keys[i])) missing.push(keys[i]);
      }
      return missing;
    }
  };
  root.FT_CONTRACTS = FT_CONTRACTS;
  if (typeof module !== 'undefined' && module.exports) { module.exports = FT_CONTRACTS; }
})(typeof window !== 'undefined' ? window : globalThis);
