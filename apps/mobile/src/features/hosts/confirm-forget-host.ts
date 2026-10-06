import { Alert } from 'react-native'
import type { NativeHost } from './host-registry'

/** Forgetting a host is the way out of pairing; it is asked before it happens. */
export function confirmForgetHost(host: NativeHost, forget: () => void): void {
  Alert.alert(`Forget ${host.label}?`, 'This device removes its access, unsent prompts, and drafts for this host. The host keeps its sessions.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Forget', style: 'destructive', onPress: forget },
  ])
}
