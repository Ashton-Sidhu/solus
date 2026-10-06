import { Appearance, AppState, Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import * as WebBrowser from 'expo-web-browser'
import * as Network from 'expo-network'
import Storage from 'expo-sqlite/kv-store'
import { EncodingType, FileSystemUploadType, readAsStringAsync, uploadAsync } from 'expo-file-system/legacy'
import { WsTransport } from '@solus/client-core/ws-transport'
import type { SettingsSyncEnvironment, SettingsSyncSignal } from '@solus/client-core/settings-sync'
import { uuid } from '@solus/contracts/uuid'
import type { PlatformAdapters } from '../app/solus-app'
import appConfig from '../../app.json'
import type { HostConnections } from '../features/hosts/host-connections'
import type { KeyValueStore, SecretStore } from './ports'

/** Plain data in the app's SQLite key-value store: synchronous, not secret. */
const storage: KeyValueStore = {
  getItem: (key) => Storage.getItemSync(key),
  setItem: (key, value) => Storage.setItemSync(key, value),
  removeItem: (key) => { Storage.removeItemSync(key) },
  keys: () => Storage.getAllKeysSync(),
}

// The keychain allows letters, digits, `.`, `-`, and `_` in a key.
const keychainKey = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_')

/** Credentials only, in the iOS Keychain / Android Keystore. Available after
 *  the first unlock so a reconnect in the background can read a host token. */
const secrets: SecretStore = {
  get: (key) => SecureStore.getItemAsync(keychainKey(key)),
  set: (key, value) => SecureStore.setItemAsync(keychainKey(key), value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  delete: (key) => SecureStore.deleteItemAsync(keychainKey(key)),
}

function deviceLabel(): string {
  if (Platform.OS === 'ios') return Platform.isPad ? 'Solus for iPad' : 'Solus for iPhone'
  if (Platform.OS === 'android') return 'Solus for Android'
  return 'Solus mobile'
}

/**
 * Network and app activity as settings sync reads them: synchronous answers
 * from the last report, kept current by the platform's listeners. One per app
 * run; its listeners live as long as the app.
 */
function settingsSyncEnvironment(): SettingsSyncEnvironment {
  let isOnline = true
  let isForeground = AppState.currentState === 'active'
  const listeners = new Set<(signal: SettingsSyncSignal) => void>()
  const tell = (signal: SettingsSyncSignal) => { for (const listener of Array.from(listeners)) listener(signal) }
  const onNetwork = (network: Network.NetworkState) => {
    // Unknown (null or undefined) is not offline: only a definite "no" pauses sync.
    const next = network.isConnected !== false && network.isInternetReachable !== false
    if (next === isOnline) return
    isOnline = next
    tell(next ? 'online' : 'offline')
  }
  void Network.getNetworkStateAsync().then(onNetwork, () => undefined)
  Network.addNetworkStateListener(onNetwork)
  AppState.addEventListener('change', (state) => {
    const next = state === 'active'
    if (next === isForeground) return
    isForeground = next
    tell(next ? 'foreground' : 'background')
  })
  return {
    isOnline: () => isOnline,
    isForeground: () => isForeground,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export const expoPlatform: PlatformAdapters = {
  storage,
  secrets,
  fetch: (input, init) => fetch(input, init),
  createTransport: (options) => new WsTransport(options),
  openBrowser: async (url) => {
    await WebBrowser.openBrowserAsync(url)
  },
  deviceLabel: deviceLabel(),
  uuid,
  // Overrides the system scheme for this app only: native controls follow it.
  applyAppearance: (mode) => Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode),
  settingsSyncEnvironment: settingsSyncEnvironment(),
  appVersion: appConfig.expo.version,
  attachmentIo: {
    readBase64: (uri) => readAsStringAsync(uri, { encoding: EncodingType.Base64 }),
    // Raw bytes, as the host's signed upload route expects; the length is the file's.
    uploadFile: async (url, uri) => (await uploadAsync(url, uri, { httpMethod: 'POST', uploadType: FileSystemUploadType.BINARY_CONTENT })).status,
  },
}

/**
 * App activity and network changes become the supervisor's wake signals. A
 * return to the foreground is a recovery event: the socket may not have
 * survived the suspension, so a long one dials every host now.
 */
export function watchAppLifecycle(connections: HostConnections, onForeground?: () => void): () => void {
  let state = AppState.currentState
  const appSubscription = AppState.addEventListener('change', (next) => {
    if (next === 'active' && state !== 'active') {
      connections.resume(Date.now())
      onForeground?.()
    }
    else if (next !== 'active' && state === 'active') connections.suspend(Date.now())
    state = next
  })
  const networkSubscription = Network.addNetworkStateListener((network) => {
    if (network.isConnected) connections.wake('activation')
  })
  return () => {
    appSubscription.remove()
    networkSubscription.remove()
  }
}
