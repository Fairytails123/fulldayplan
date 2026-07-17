/* FT-SHARED — van kennel layouts.
 *
 * Provenance: promoted VERBATIM from "Van ETA and Tracking\build\drive\ui\kennels.js"
 * (which mirrors the office Load Plan's markup in
 * "Full Day Load Plan\index_v6.html" — the .kennel-grid sections, data-pos codes).
 * If a van's kennel layout changes, update index_v6.html AND this file together.
 *
 * Position codes: [S|B] Side/Back grid · [T|M|B] Top/Middle/Bottom row ·
 * [P|M|D] Passenger/Middle/Driver column.  BV and BVX are identical
 * (15 kennels); SV has 10, with wheel-arch bottom boxes on the back grid.
 *
 * Deployed by FT-SHARED marker injection (tools\vps_n8n.py inject) — do not add
 * markers in this file by hand.
 */
(function (root) {
  'use strict';
  var FT_KENNELS = {
    BV: {
      side: [['STP', 'STM', 'STD'], ['SMP', 'SMD'], ['SBP', 'SBD']],
      back: [['BTP', 'BTM', 'BTD'], ['BMP', 'BMM', 'BMD'], ['BBP', 'BBD']],
      arches: []
    },
    BVX: {
      side: [['STP', 'STM', 'STD'], ['SMP', 'SMD'], ['SBP', 'SBD']],
      back: [['BTP', 'BTM', 'BTD'], ['BMP', 'BMM', 'BMD'], ['BBP', 'BBD']],
      arches: []
    },
    SV: {
      side: [['STP', 'STM', 'STD'], ['SBP', 'SBD']],
      back: [['BTP', 'BTM', 'BTD'], ['BBP', 'BBD']],
      arches: ['BBP', 'BBD']
    }
  };
  root.FT_KENNELS = FT_KENNELS;
  if (typeof module !== 'undefined' && module.exports) { module.exports = FT_KENNELS; }
})(typeof window !== 'undefined' ? window : globalThis);
