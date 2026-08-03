import { RPC_INVOKE_METHODS } from '../shared/rpc'

const RPC_METHODS = new Set<string>(RPC_INVOKE_METHODS)

export const NATIVE_ONLY_SOLUS_METHODS = [
  'getPlatform',
  'getPathForFile',
  'getLocalConnection',
  'openExternal',
  'setQuoteContext',
  'onQuoteSelection',
  'onAskSelectionInNewSession',
  'onThemeChange',
  'onWindowShown',
  'onWindowHidden',
  'setIgnoreMouseEvents',
  'rendererReady',
  'rendererMounted',
] as const

// Most RPC methods belong to the selected host. External links are the lone
// exception: they must open on the client device, using its native shell when
// one exists instead of asking a remote host to open them.
const CLIENT_LOCAL_RPC_METHODS = new Set<string>(['openExternal'])

export type NativeOnlySolusMethod = (typeof NATIVE_ONLY_SOLUS_METHODS)[number]

export function mergeNativeOnlySolusApi(
  transportApi: Record<string, unknown>,
  nativeApi: Record<string, unknown>,
  nativeMethods: readonly string[] = NATIVE_ONLY_SOLUS_METHODS,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...transportApi }

  for (const method of nativeMethods) {
    if (RPC_METHODS.has(method) && !CLIENT_LOCAL_RPC_METHODS.has(method)) continue
    const value = nativeApi[method]
    if (typeof value === 'function') merged[method] = value
  }

  return merged
}

export function installWindowSolusApi(api: Record<string, unknown>): void {
  const target = window as unknown as { solus?: Record<string, unknown> }
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
    if (existing.start === api.start) return
  }

  throw new Error('Unable to install WS-backed Solus API')
}
