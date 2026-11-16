import { useMemo } from 'react'
import { hostReadinessCopy } from '@solus/client-core/host-readiness'
import { useApp, useListened } from '../../app/app-context'
import { hostMachineKind } from '../connection/lib/host-machine'

/** A stable readiness snapshot for the project picker and project forms. */
export function useProjectHosts() {
  const app = useApp()
  const hosts = useListened(app.registry.changes, app.registry.hosts)
  const states = useListened(app.connections.changes, () => hosts.map((host) => app.connections.readiness(host.id).readiness).join(','))
  const choices = useMemo(() => hosts.map((host) => {
    const state = app.connections.readiness(host.id)
    return {
      id: host.id,
      label: host.label,
      machine: hostMachineKind(host),
      ready: state.readiness === 'ready',
      detail: state.readiness === 'ready' ? undefined : hostReadinessCopy(state, host.label).headline,
    }
  }), [app, hosts, states])
  const readyHostIds = useMemo(() => new Set(choices.filter((host) => host.ready).map((host) => host.id)), [choices])
  return { choices, readyHostIds }
}
