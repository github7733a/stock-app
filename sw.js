/* Service Worker - 快取 shell，股價每次重新從網路抓 */
const CACHE = "stock-app-v1";
const SHELL = ["./", "./index.html", "./app.js", "./style.css", "./manifest.json",
               "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // 股價 API 一律走網路，不快取
  if (url.hostname.includes("twse.com.tw") || url.hostname.includes("tpex.org.tw")) {
    e.respondWith(fetch(e.request).catch(() => new Response("[]")));
    return;
  }
  // shell assets：先網路、失敗再用快取
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
