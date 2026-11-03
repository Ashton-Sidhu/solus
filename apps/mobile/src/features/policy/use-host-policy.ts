import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { HostPolicies } from '@solus/contracts/host-policies'
import type { ManagedSessionSettingKey } from '@solus/contracts/policy'
import { useApp, useListened } from '../../app/app-context'
import type { HostConnection } from '../hosts/host-connections'
import { managedSettingNotes, permissionCeilingLines, type PolicyHostView } from './lib/policy-view'

const NO_SUBSCRIPTION = () => () => {}

/**
 * A host's policy summary, from its shared `policy` fact (plans/030 §7). The
 * fact follows `host.policyChanged`, so a screen sees a new policy at once.
 * Null until the host answers, and for a host with no connection.
 */
export function useHostPolicy(hostId: string | null): HostPolicies | null {
  const app = useApp()
  const connection = useListened(app.connections.changes, () => (hostId ? app.connections.connection(hostId) : null))
  useEffect(() => {
    connection?.facts.ensure('policy')
  }, [connection])
  const subscribe = useCallback(
    (notify: () => void) => connection?.facts.subscribe((key) => { if (key === 'policy') notify() }) ?? (() => {}),
    [connection],
  )
  const read = useCallback(() => connection?.facts.value('policy') ?? null, [connection])
  return useSyncExternalStore(connection ? subscribe : NO_SUBSCRIPTION, read, read)
}

/**
 * The policy of every connected host, for a personal settings page: personal
 * settings apply on every host, so each host's locks are named with the host.
 */
export function usePolicyHosts(): PolicyHostView[] {
  const app = useApp()
  const hosts = useListened(app.registry.changes, app.registry.hosts)
  const readyIds = useListened(app.connections.changes, () =>
    hosts.filter((host) => app.connections.state(host.id)?.readiness === 'ready').map((host) => host.id).join('\n'))
  const connections = useMemo(
    () => (readyIds ? readyIds.split('\n').map((hostId) => app.connections.connection(hostId)).filter((connection): connection is HostConnection => connection !== null) : []),
    [app, readyIds],
  )
  const [policies, setPolicies] = useState<PolicyHostView[]>([])
  useEffect(() => {
    const read = () => setPolicies(connections.flatMap((connection) => {
      const policies = connection.facts.value('policy')
      const host = app.registry.host(connection.hostId)
      return policies && host ? [{ hostLabel: host.label, policies }] : []
    }))
    const stops = connections.map((connection) => {
      connection.facts.ensure('policy')
      return connection.facts.subscribe((key) => { if (key === 'policy') read() })
    })
    read()
    return () => { for (const stop of stops) stop() }
  }, [app, connections])
  return policies
}

/** The organizations the account is in, as the lines under a managed setting name them. */
function useAccountOrganizations(): readonly { organizationId: string; name: string }[] {
  const app = useApp()
  const directory = useListened(app.account.changes, () => app.account.directory)
  return useMemo(() => (directory.kind === 'loaded' ? directory.organizations : []), [directory])
}

/** The lines under one managed personal setting, for every connected host that locks it. */
export function useManagedSettingLines(key: ManagedSessionSettingKey): string[] {
  const hosts = usePolicyHosts()
  const organizations = useAccountOrganizations()
  return useMemo(() => managedSettingNotes(hosts, organizations, key), [hosts, organizations, key])
}

/** The permission-mode ceiling on each connected host for work of the device's organization. */
export function usePermissionCeilingLines(): string[] {
  const app = useApp()
  const hosts = usePolicyHosts()
  const organizationId = useListened(app.account.changes, () => app.account.organizationId)
  return useMemo(() => permissionCeilingLines(hosts, organizationId), [hosts, organizationId])
}
