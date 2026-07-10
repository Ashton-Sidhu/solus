self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || 'Solus needs attention';
  const body = payload.body || '';
  const data = {
    sessionId: payload.sessionId || null,
    kind: payload.kind || null,
  };

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data,
      tag: data.sessionId ? `solus-${data.sessionId}-${data.kind || 'attention'}` : 'solus-attention',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find((candidate) => 'focus' in candidate);
    if (client) {
      await client.focus();
      client.postMessage({
        type: 'solus:notification-click',
        sessionId: data.sessionId || null,
        kind: data.kind || null,
      });
      return;
    }

    if (clients.openWindow) {
      const opened = await clients.openWindow('/');
      opened?.postMessage({
        type: 'solus:notification-click',
        sessionId: data.sessionId || null,
        kind: data.kind || null,
      });
    }
  })());
});
