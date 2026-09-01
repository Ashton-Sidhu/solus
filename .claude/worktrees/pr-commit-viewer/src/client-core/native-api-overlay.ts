import { RPC_INVOKE_METHODS } from '../shared/rpc'

const RPC_METHODS = new Set<string>(RPC_INVOKE_METHODS)

export const NATIVE_ONLY_SOLUS_METHODS = [
  'getPlatform',
  'getPathForFile',
  'readAttachmentBytes',
  'getLocalConnection',
  'openExternal',
  'showNotification',
  'setQuoteContext',
  'onQuoteSelection',
  'onAskSelectionInNewSession',
  'onThemeChange',
  'onWindowShown',
  'onWindowHidden',
  'setIgnoreMouseEvents',
  'setZoomFactor',
  'rendererReady',
  'rendererMounted',
] as const

// Most RPC methods belong to the selected host. External links are the lone
// exception: they must open on the client device, using its native shell when
// one exists instead of asking a remote host to open them.
const CLIENT_LOCAL_RPC_METHODS = new Set<string>(['openExternal'])

export type NativeOnlySolusMethod = (typeof NATIVE_ONLY_SOLUS_METHODS)[number]

export function mergeNativeOnlySolusApi(
  transportApi: object,
  nativeApi: object,
  nativeMethods: readonly string[] = NATIVE_ONLY_SOLUS_METHODS,
): object {
  const merged = { ...transportApi }

  for (const method of nativeMethods) {
    if (RPC_METHODS.has(method) && !CLIENT_LOCAL_RPC_METHODS.has(method)) continue
    const value = Reflect.get(nativeApi, method)
    if (typeof value === 'function') Reflect.set(merged, method, value)
  }

  return merged
}

export function installWindowSolusApi(api: object): void {
  const target = window as unknown as { solus?: object }
  try {
    target.solus = api
    if (target.solus === api) return
  } catch {}

  try {
    Object.defineProperty(window, 'solus', {
      value: api,
      configurable: true,
      writable: true,
    })
    if (target.solus === api) return
  } catch {}

  const existing = target.solus
  if (existing && typeof existing === 'object') {
    for (const [key, value] of Object.entries(api)) {
      try {
        Object.defineProperty(existing, key, {
          value,
          configurable: true,
          writable: true,
        })
      } catch {}
    }
    if (Reflect.get(existing, 'start') === Reflect.get(api, 'start')) return
  }

  throw new Error('Unable to install WS-backed Solus API')
}
