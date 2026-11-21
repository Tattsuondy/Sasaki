/*
 * 家計簿 v2 ― オフラインでもすぐ開くための仕組み（Service Worker）
 * 画面のファイル（HTML・JS・CSS・アイコン）だけを端末に置きます。家計のデータはここでは扱いません。
 * 新しい版を GitHub に置いたら、下の VERSION を変えてください。
 */
const VERSION = 'kakeibo-v2-2026-11-21d';
const FILES = ['./', './index.html', './app.js', './engine.js', './style.css', './manifest.webmanifest', './icon-180.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// 同じサイトの画面ファイルだけ：端末の写しをすぐ返し、裏で新しいものを取ってくる
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
