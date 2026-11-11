// coread service worker: shows Web Push notifications and opens the app when one is tapped.
// No offline caching; the page always loads fresh from the network.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "coread", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "coread", {
    body: d.body || "",
    tag: d.tag || "coread",
    renotify: true,
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (win) { await win.focus(); return; }
    await self.clients.openWindow(url);
  })());
});
