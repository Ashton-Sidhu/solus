import { hostname } from 'os'
import { join } from 'path'
import { app, ipcMain, safeStorage, shell } from 'electron'
import type { AccountState } from '@solus/contracts/account-types'
import { AccountStore } from './account-store'
import { AccountSession } from './account-session'

export const ACCOUNT_CHANNELS = {
  state: 'solus:account-state',
  signIn: 'solus:account-sign-in',
  cancelSignIn: 'solus:account-cancel-sign-in',
  signOut: 'solus:account-sign-out',
  retryVerify: 'solus:account-retry-verify',
  stateChanged: 'solus:account-state-changed',
} as const

/** Production origin; `SOLUS_CLOUD_URL` overrides it for development and staging. */
export const DEFAULT_CLOUD_ORIGIN = 'https://app.solus.sh'

export function resolveCloudOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.SOLUS_CLOUD_URL?.trim()
  if (!candidate) return DEFAULT_CLOUD_ORIGIN
  const url = new URL(candidate)
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !isLoopback) {
    throw new Error('SOLUS_CLOUD_URL must use https unless it points at loopback')
  }
  return url.origin
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Wires the account session into Electron: IPC for the renderer, the keychain for
 * the token, the system browser for the approval page. Returns the session so the
 * app can verify on boot and on window focus.
 */
export function registerAccountIpc(broadcast: (channel: string, state: AccountState) => void): AccountSession {
  const session = new AccountSession({
    cloudOrigin: resolveCloudOrigin(),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    sleep,
    store: new AccountStore(join(app.getPath('userData'), 'account.bin'), safeStorage),
    openExternal: async (url) => {
      await shell.openExternal(url)
    },
    deviceLabel: () => `Solus for Mac — ${hostname().replace(/\.local$/, '')}`,
    onStateChange: (state) => broadcast(ACCOUNT_CHANNELS.stateChanged, state),
  })

  ipcMain.handle(ACCOUNT_CHANNELS.state, () => session.current())
  ipcMain.handle(ACCOUNT_CHANNELS.signIn, () => session.signIn())
  ipcMain.on(ACCOUNT_CHANNELS.cancelSignIn, () => session.cancelSignIn())
  ipcMain.handle(ACCOUNT_CHANNELS.signOut, () => session.signOut())
  ipcMain.handle(ACCOUNT_CHANNELS.retryVerify, () => session.verify('retry'))

  void session.verify('boot')
  return session
}
