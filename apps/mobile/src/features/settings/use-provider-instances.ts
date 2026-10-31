import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { ProviderInstancesClient } from '@solus/client-core/provider-instances'
import { useApp, useListened } from '../../app/app-context'

export function useProviderInstances(hostId?: string) {
  const app = useApp();
  const readiness = useListened(app.connections.changes, () => hostId ? app.connections.state(hostId)?.readiness : undefined);
  const client = useMemo(() => new ProviderInstancesClient(() => {
    const connection = hostId ? app.connections.connection(hostId) : null;
    if (!connection) throw new Error("Connect this host to manage provider instances.");
    return connection.api;
  }), [app, hostId]);
  const view = useSyncExternalStore(client.subscribe, client.current);
  useEffect(() => {
    if (readiness !== "ready") { client.clear(); return; }
    void client.load();
    return hostId ? app.connections.connection(hostId)?.events.subscribe("provider-instances.changed", () => { void client.load(); }) : undefined;
  }, [app, hostId, readiness, client]);
  return { client, view, readiness };
}
