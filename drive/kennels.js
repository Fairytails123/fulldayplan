/* Fairy Tails — van kennel layouts (SHARED module).
 *
 * Single source for per-van kennel grids, mirroring the office Load Plan's
 * markup in `Whiteboard and Routes/Full Day Load Plan/index_v6.html`
 * (the .kennel-grid sections, data-pos codes). If a van's kennel layout
 * changes, update index_v6.html AND this file together.
 *
 * Position codes: [S|B] Side/Back grid · [T|M|B] Top/Middle/Bottom row ·
 * [P|M|D] Passenger/Middle/Driver column.  BV and BVX are identical
 * (15 kennels); SV has 10, with wheel-arch bottom boxes on the back grid.
 */
window.FT_KENNELS = {
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
