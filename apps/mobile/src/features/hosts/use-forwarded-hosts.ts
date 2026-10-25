import { useCallback, useEffect } from 'react'
import { Alert } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import type { ForwardedHost } from '@solus/contracts/remote-machines'
import { useApp, useListened } from '../../app/app-context'
import { forwardedRemoveChoice } from './forwarded-hosts'

/** One host's SSH forwards for its details: read on connect and on focus; a
 *  refused remove or link says why. Remove is asked before it happens. */
export function useForwardedHosts(hostId: string, holderLabel: string) {
  const app = useApp()
  const state = useListened(app.forwardedHosts.changes, () => app.forwardedHosts.stateOf(hostId))
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const reload = useCallback(() => { void app.forwardedHosts.load(hostId) }, [app, hostId])

  useEffect(() => {
    if (readiness === 'ready') reload()
  }, [readiness, reload])

  useFocusEffect(reload)

  const report = (title: string) => (cause: unknown) => {
    Alert.alert(title, cause instanceof Error ? cause.message : String(cause))
  }

  const link = (host: ForwardedHost) => {
    void app.forwardedHosts.link(hostId, host.installationId).catch(report(`${host.label} is not linked`))
  }

  const remove = (host: ForwardedHost) => {
    const choice = forwardedRemoveChoice(host, holderLabel)
    const run = (stopRemote: boolean) => {
      void app.forwardedHosts.remove(hostId, host.installationId, stopRemote).catch(report(`${host.label} is not removed`))
    }
    Alert.alert(choice.title, choice.message, [
      { text: 'Cancel', style: 'cancel' },
      ...(choice.offersStop ? [{ text: 'Remove and stop Solus there', style: 'destructive' as const, onPress: () => run(true) }] : []),
      { text: 'Remove', style: 'destructive', onPress: () => run(false) },
    ])
  }

  return { state, reload, link, remove }
}
