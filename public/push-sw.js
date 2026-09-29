// Worker dédié aux notifications push de P&H (pas de cache, pas d'offline).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || "P&H 🍂", {
      body: data.body || "Tu as un nouveau message 💌",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "pnh-message",
      renotify: true,
      vibrate: [120, 60, 120],
      data: { url: "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow("/");
    }),
  );
});
