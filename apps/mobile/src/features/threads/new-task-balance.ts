import { checkBalancedHost } from '@solus/client-core/host-balance'
import type { HostBalancePreference } from '@solus/contracts/settings'
import type { HostResources } from '@solus/contracts/host-resources'
import { useEffect, useRef, useState } from 'react'
import { useApp, useListened } from '../../app/app-context'
import { newTaskBalanceCandidates, type BalanceableEnvironment } from './lib/new-task-balance-candidates'

/** Who chose the host of a new task. Absent: nobody yet, so Auto balance may. */
export type NewTaskHostChoice = 'auto' | 'manual'

export type NewTaskBalanceState = 'idle' | 'checking' | 'unavailable'

/**
 * The hosts Auto balance may choose for a new task now, read from each host's
 * connection. Two consumers: the composer's check, and the picker's row.
 */
export function useNewTaskBalanceCandidates<Environment extends BalanceableEnvironment>(environments: readonly Environment[], agentId: string | null) {
  const app = useApp()
  const hosts = useListened(app.registry.changes, app.registry.hosts)
  const balancing = useListened(app.personal.changes, () => app.personal.current().hostBalancing)
  // Follows connections: a host that connects can join the choice.
  const version = useListened(app.connections.changes, () => hosts.map((host) => app.connections.state(host.id)?.readiness === 'ready' ? '1' : '0').join(''))
  if (!balancing.enabled) return []
  const agent = agentId ?? app.personal.current().activeAgent
  return newTaskBalanceCandidates(environments, hosts.map((host, index) => {
    const agents = app.connections.connection(host.id)?.facts.value('machine')?.agents
    return {
      id: host.id,
      ready: version[index] === '1',
      uplink: host.uplink,
      runsAgent: !agents || agents.some((candidate) => candidate.id === agent && candidate.available !== false),
    }
  }), balancing)
}

export interface NewTaskBalanceOptions<Environment extends BalanceableEnvironment> {
  /** Check now: a new task with no choice, or the picker's Auto balance row. */
  shouldCheck: boolean
  /** A new value asks for another check, also after one that failed. */
  request: number | undefined
  candidates: readonly (Environment & { preference: HostBalancePreference })[]
  read: (hostId: string) => Promise<HostResources>
  /** The check chose. Says whether the choice could be applied. */
  onChosen: (environment: Environment) => boolean
}

/** Runs one check for each request, then the choice stays. A failed check
 *  leaves the draft where it is, and the person chooses. */
export function useNewTaskBalance<Environment extends BalanceableEnvironment>(options: NewTaskBalanceOptions<Environment>): NewTaskBalanceState {
  const { shouldCheck, request, candidates } = options
  const [state, setState] = useState<NewTaskBalanceState>('idle')
  const canCheck = shouldCheck && candidates.length >= 2
  // The check settles later than the render that started it: `onChosen` reads
  // what the person typed in the meantime, and the candidates are those of the
  // moment the check starts.
  const latest = useRef(options)
  useEffect(() => { latest.current = options })

  useEffect(() => {
    if (!canCheck) {
      setState('idle')
      return
    }
    let abandoned = false
    setState('checking')
    const { candidates: checked, read } = latest.current
    void checkBalancedHost(checked.map(({ hostId, preference }) => ({ hostId, preference, read: () => read(hostId) }))).then((hostId) => {
      if (abandoned) return
      const chosen = checked.find((candidate) => candidate.hostId === hostId)
      setState(chosen && latest.current.onChosen(chosen) ? 'idle' : 'unavailable')
    })
    return () => { abandoned = true }
  }, [canCheck, request])

  return state
}
