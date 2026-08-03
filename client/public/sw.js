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
    // Where clicking lands, as a serialized route. Falling back to the session's
    // own chat route keeps payloads sent by an older host working.
    route:
      payload.route ||
      (payload.sessionId ? `/chat/@${encodeURIComponent(payload.sessionId)}` : null),
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
  const message = { type: 'solus:notification-click', route: data.route || null };

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find((candidate) => 'focus' in candidate);
    if (client) {
      await client.focus();
      client.postMessage(message);
      return;
    }

    if (clients.openWindow) {
      // A cold open lands directly at the route: the hash is the location, so
      // the workspace boots showing that session instead of the last one.
      const opened = await clients.openWindow(data.route ? `/#${data.route}` : '/');
      opened?.postMessage(message);
    }
  })());
});
