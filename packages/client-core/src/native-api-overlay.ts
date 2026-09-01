import { RPC_INVOKE_METHODS } from '@solus/contracts/rpc'

const RPC_METHODS = new Set<string>(RPC_INVOKE_METHODS)

export const NATIVE_ONLY_SOLUS_METHODS = [
  'getPlatform',
  'getPathForFile',
  'readAttachmentBytes',
  'getLocalConnection',
  'openExternal',
  'showNotification',
  'logNotificationSound',
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
  'accountState',
  'accountSignIn',
  'accountCancelSignIn',
  'accountSignOut',
  'accountRetryVerify',
  'onAccountStateChange',
] as const

// Most RPC methods belong to the selected host. External links are the lone
// exception: they must open on the client device, using its native shell when
// one exists instead of asking a remote host to open them.
const CLIENT_LOCAL_RPC_METHODS = new Set<string>(['openExternal'])

export type NativeOnlySolusMethod = (typeof NATIVE_ONLY_SOLUS_METHODS)[number]

export function mergeNativeOnlySolusApi<TransportApi extends object, NativeApi extends object>(
  transportApi: TransportApi,
  nativeApi: NativeApi,
  nativeMethods: readonly string[] = NATIVE_ONLY_SOLUS_METHODS,
): TransportApi & Partial<NativeApi> {
  const nativeEntries = Object.entries(nativeApi).filter(([method]) =>
    nativeMethods.includes(method)
    && (!RPC_METHODS.has(method) || CLIENT_LOCAL_RPC_METHODS.has(method)))

  // SAFETY: Every selected entry comes directly from `nativeApi`; the filter only narrows its keys.
  const nativeMethodsApi = Object.fromEntries(nativeEntries) as Partial<NativeApi>
  return { ...transportApi, ...nativeMethodsApi }
}

export function installWindowSolusApi<Api extends object>(api: Api): void {
  // SAFETY: This function owns installation of the `solus` global and checks each write below.
  const target = window as Window & { solus?: Api }
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
  if (existing) {
    for (const [key, value] of Object.entries(api)) {
      try {
        Object.defineProperty(existing, key, {
          value,
          configurable: true,
          writable: true,
        })
      } catch {}
    }
    const installedStart = Object.entries(existing).find(([key]) => key === 'start')?.[1]
    const apiStart = Object.entries(api).find(([key]) => key === 'start')?.[1]
    if (installedStart === apiStart) return
  }

  throw new Error('Unable to install WS-backed Solus API')
}
