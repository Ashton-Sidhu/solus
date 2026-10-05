self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const message = { type: 'solus:notification-click', ...data };

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find((candidate) => 'focus' in candidate);
    if (client) {
      await client.focus();
      client.postMessage(message);
      return;
    }

    if (clients.openWindow) {
      const root = new URL(self.registration.scope).pathname;
      await clients.openWindow(data.route ? `${root}?${new URLSearchParams({ notificationRoute: data.route })}` : root);
    }
  })());
});
