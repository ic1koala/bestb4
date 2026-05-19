const CACHE_NAME = 'bestb4-v2';
const ASSETS = [
  './index.html',
  './manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
});

self.addEventListener('fetch', (e) => {
  // Google APIへの通信はService Workerで干渉せず直接通す（巨大データのPOSTエラー回避）
  if (e.request.url.includes('googleapis.com') || e.request.url.includes('script.google.com')) {
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

// バックグラウンド通知の制御
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SCHEDULE_NOTIFICATION') {
    const { title, options, delay } = event.data;
    setTimeout(() => {
      self.registration.showNotification(title, options);
    }, delay);
  }
});
