import { Alert } from 'react-native'
import type { SolusApp } from '../../app/solus-app'
import type { KnownHost } from '@solus/client-core/known-host'

/**
 * Forgetting a host is the way out of pairing; it is asked before it happens. A host
 * the account lists is listed on every device, so it leaves the account first;
 * forgetting it here alone would not last. Then its listing leaves the person's
 * host list, and only then its credential leaves this device (plans/033 §4.1). A
 * host already gone is forgotten again without harm.
 */
export function confirmForgetHost(app: SolusApp, host: KnownHost, onForgotten?: () => void): void {
  const forget = async () => {
    try {
      await app.connections.forgetHost(host.id, host.routes)
    } catch (error) {
      Alert.alert(`Could not remove ${host.label}`, error instanceof Error ? error.message : String(error))
      return
    }
    if (host.uplink && !(await app.account.removeHost(host))) {
      Alert.alert(`Could not remove ${host.label}`, 'Solus Cloud did not remove it from your account. Try again.')
      return
    }
    try {
      // The listing leaves the person's list first; a list that does not answer forgets nothing.
      await app.registry.forget(host.id)
    } catch (error) {
      Alert.alert(`Could not remove ${host.label}`, error instanceof Error ? error.message : String(error))
      return
    }
    onForgotten?.()
  }
  Alert.alert(`Forget ${host.label}?`, 'This removes the host here and from your Solus account, with its access, unsent prompts, and drafts on this device. The host keeps its sessions.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Forget', style: 'destructive', onPress: () => void forget() },
  ])
}
