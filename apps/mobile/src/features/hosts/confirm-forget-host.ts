import { Alert } from 'react-native'
import type { SolusApp } from '../../app/solus-app'
import type { NativeHost } from './host-registry'

/**
 * Forgetting a host is the way out of pairing; it is asked before it happens. A host
 * the account lists is listed on every device, so it leaves the account first;
 * forgetting it here alone would not last. A host already gone is forgotten again
 * without harm.
 */
export function confirmForgetHost(app: SolusApp, host: NativeHost, onForgotten?: () => void): void {
  const forget = async () => {
    if (host.uplink && !(await app.account.removeHost(host))) {
      Alert.alert(`Could not remove ${host.label}`, 'Solus Cloud did not remove it from your account. Try again.')
      return
    }
    await app.registry.forget(host.id)
    onForgotten?.()
  }
  Alert.alert(`Forget ${host.label}?`, 'This removes the host here and from your Solus account, with its access, unsent prompts, and drafts on this device. The host keeps its sessions.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Forget', style: 'destructive', onPress: () => void forget() },
  ])
}
