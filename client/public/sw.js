const seenAttention = new Set();

self.addEventListener('message', (event) => {
  if (event.data?.type === 'solus:attention-seen' && event.data.dedupKey) {
    seenAttention.add(event.data.dedupKey);
  }
});

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
    entryKey: payload.entryKey || null,
    installationId: payload.installationId || null,
    route: payload.route || null,
  };
  const dedupKey = data.installationId && data.entryKey
    ? `${data.installationId}:${data.entryKey}`
    : null;

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      client.postMessage({ type: 'solus:push-received', ...data });
    }
    if (dedupKey && seenAttention.has(dedupKey)) return;
    await self.registration.showNotification(title, {
      body,
      data,
      tag: dedupKey || (data.sessionId ? `solus-${data.sessionId}-${data.kind || 'attention'}` : 'solus-attention'),
    });
  })());
});

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
      const params = new URLSearchParams();
      if (data.sessionId) params.set('notificationSessionId', data.sessionId);
      if (data.installationId) params.set('notificationInstallationId', data.installationId);
      if (data.route) params.set('notificationRoute', data.route);
      await clients.openWindow(params.size > 0 ? `/?${params}` : '/');
    }
  })());
});
