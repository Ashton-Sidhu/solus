import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { connect } from 'net'
import { userInfo } from 'os'
import { findOnPath, getCliPath } from '../cli-env'
import { readTailscaleStatus, tailscaleInstallPaths } from '../transport/endpoints'

export interface SshTarget { host: string; user: string }

const CACHE_MS = 60_000
const PROBE_MS = 300
const CLI_TIMEOUT_MS = process.platform === 'win32' ? 5_000 : 1_500
let cached: { value: SshTarget | undefined; expiresAt: number } | undefined
let pending: Promise<SshTarget | undefined> | undefined

export function sshTargetFromStatus(
  status: { Self?: { DNSName?: string; TailscaleIPs?: string[] } } | null,
  user: string,
  sshListening: boolean,
  tailscaleSshEnabled: boolean,
): SshTarget | undefined {
  const host = status?.Self?.DNSName?.replace(/\.$/, '').trim()
  return host && user && (sshListening || tailscaleSshEnabled) ? { host, user } : undefined
}

export function tailscaleSshFromPrefs(prefs: { RunSSH?: boolean; WantRunning?: boolean }): boolean {
  return prefs.RunSSH === true && prefs.WantRunning === true
}

function tailscaleBin(): string | null {
  for (const path of tailscaleInstallPaths(process.platform, process.env)) {
    if (existsSync(path)) return path
  }
  return findOnPath('tailscale', getCliPath())
}

function readTailscaleSshPrefs(): Promise<boolean> {
  const bin = tailscaleBin()
  if (!bin) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile(bin, ['debug', 'prefs'], {
      encoding: 'utf8', timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024,
    }, (error, output) => {
      if (error) return resolve(false)
      try { resolve(tailscaleSshFromPrefs(JSON.parse(output))) }
      catch { resolve(false) }
    })
  })
}

function hasSshListener(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: address, port: 22 })
    let done = false
    const finish = (listening: boolean) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(PROBE_MS, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function discoverSshTarget(): Promise<SshTarget | undefined> {
  const [status, tailscaleSshEnabled] = await Promise.all([readTailscaleStatus(), readTailscaleSshPrefs()])
  const addresses = status?.Self?.TailscaleIPs ?? []
  if (!status?.Self?.DNSName) return undefined
  const listening = tailscaleSshEnabled ? false : (await Promise.all(addresses.map(hasSshListener))).includes(true)
  let user: string
  try { user = userInfo().username }
  catch { return undefined }
  return sshTargetFromStatus(status, user, listening, tailscaleSshEnabled)
}

/** First read resolves discovery. Later reads serve stale data while one refresh runs. */
export function sshTarget(): Promise<SshTarget | undefined> {
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
  if (!pending) {
    pending = discoverSshTarget().then((value) => {
      cached = { value, expiresAt: Date.now() + CACHE_MS }
      return value
    }).finally(() => { pending = undefined })
  }
  return cached ? Promise.resolve(cached.value) : pending
}
