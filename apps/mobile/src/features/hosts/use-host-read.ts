import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostApi } from '@solus/client-core/host-api'
import type { HostEventName } from '@solus/contracts/host-events'
import { useApp } from '../../app/app-context'
import { useHostApi } from '../projects/use-open-project'

export type HostReadState<T> =
  | { kind: 'loading' }
  | { kind: 'loaded'; value: T }
  | { kind: 'error'; message: string }

const LOADING = { kind: 'loading' } as const

/**
 * One read from a host, made when the host is ready, again on each of the
 * `refreshOn` events and on reconnect, and when `reload` is called. A read
 * keeps the last answer on screen, except an error, which shows `loading`
 * again. A reply from an older read, from a connection that has gone, or for
 * another `key` is dropped. `key` names what `read` reads: a new key reads
 * again.
 */
export function useHostRead<T>(
  hostId: string,
  key: string,
  read: (api: HostApi) => Promise<T>,
  refreshOn: readonly HostEventName[],
) {
  const app = useApp()
  const api = useHostApi(hostId)
  const [answer, setAnswer] = useState<{ key: string; state: HostReadState<T> } | null>(null)
  const request = useRef(0)
  const latestRead = useRef(read)
  useEffect(() => { latestRead.current = read })

  const reload = useCallback(() => {
    if (!api) return
    const at = ++request.current
    setAnswer((previous) => (previous?.state.kind === 'error' ? null : previous))
    const isCurrent = () => at === request.current && app.connections.connection(hostId)?.api === api
    latestRead.current(api).then(
      (value) => { if (isCurrent()) setAnswer({ key, state: { kind: 'loaded', value } }) },
      (cause: unknown) => { if (isCurrent()) setAnswer({ key, state: { kind: 'error', message: cause instanceof Error ? cause.message : String(cause) } }) },
    )
  }, [api, app, hostId, key])

  useEffect(() => {
    if (!api) return
    reload()
    const events = app.connections.connection(hostId)?.events
    const stops = refreshOn.map((topic) => events?.subscribe(topic, reload))
    return () => { for (const stop of stops) stop?.() }
  }, [api, app, hostId, refreshOn, reload])

  const state: HostReadState<T> = answer?.key === key ? answer.state : LOADING
  return { state, reload }
}
