/* Fairy Tails Drive — offline-shell service worker (v0.3, 2026-07-15).
   Purpose: the driver app must ALWAYS load its own UI, even with no signal. On the
   2026-07-15 SV pilot the app dropped to "offline / no route" after a long screen-off
   suspension because the remote page could not be re-fetched and the Capacitor shell
   fell back to its bundled stub. This SW caches the app shell and serves it when the
   network is unavailable. The route DATA still comes from the in-page veta_last_<van>
   cache; this only guarantees the shell (HTML/JS) itself renders.

   Strategy:
   - HTML/navigations: NETWORK-FIRST (always fresh when online; ships Pages updates
     immediately), cached shell only as an offline fallback — so it can never freeze
     users on a stale version.
   - Same-origin static assets (kennels.js, icons, manifest): cache-first with a
     network+cache fallback.
   - Cross-origin requests (n8n webhooks, Apps Script): never intercepted — straight to
     the network, so live data + taps are untouched. */

var CACHE = 'ftdrive-shell-v0_3';
var SHELL = ['./', './index.html', './kennels.js', './manifest.webmanifest'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL).catch(function () {}); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;   // n8n / Apps Script → untouched

  var isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1;
  if (isHTML) {
    e.respondWith(
      fetch(req).then(function (res) {
        try { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put('./index.html', copy); }); } catch (err) {}
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (m) { return m || caches.match('./'); });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (m) {
      if (m) return m;
      return fetch(req).then(function (res) {
        try { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); } catch (err) {}
        return res;
      });
    })
  );
});
