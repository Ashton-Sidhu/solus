import { connect } from 'node:net'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { z } from 'zod'
import type { DevicePlatform } from '@solus/contracts/device-types'
import { DeviceDomainError } from './device-errors'

/**
 * The dev path of Run app: a simulator joins this project's Metro on port
 * 8081. Solus starts Metro only when nothing listens there, and never adopts
 * a server that belongs to another project. The app must already be on the
 * simulator as a debug build; the dev path builds nothing.
 */

export const DEV_SERVER_PORT = 8081
const ORIGIN = `http://localhost:${DEV_SERVER_PORT}`
/** What the simulator loads from. Android reaches it through `adb reverse`. */
export const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`

/** `free`: nothing listens. `running`: Metro serves that folder. `other`: something else has the port. */
export type DevServerProbe = { state: 'free' } | { state: 'running'; projectRoot: string } | { state: 'other' }

function accepts(host: string): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = connect({ host, port: DEV_SERVER_PORT })
    socket.setTimeout(2_000)
    const done = (accepted: boolean) => { socket.destroy(); resolveConnect(accepted) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}

/**
 * Connect, do not bind: Metro listens on IPv6 `*:8081`, and macOS still lets
 * another process bind 127.0.0.1:8081 beside it.
 */
async function portIsFree(): Promise<boolean> {
  const [ipv4, ipv6] = await Promise.all([accepts('127.0.0.1'), accepts('::1')])
  return !ipv4 && !ipv6
}

export async function probeDevServer(fetcher: typeof fetch = fetch): Promise<DevServerProbe> {
  if (await portIsFree()) return { state: 'free' }
  try {
    // Expo answers /status only once the bundler is ready, so this can take a while.
    const response = await fetcher(`${ORIGIN}/status`, { signal: AbortSignal.timeout(15_000) })
    const root = response.headers.get('X-React-Native-Project-Root')
    if ((await response.text()) !== 'packager-status:running' || !root) return { state: 'other' }
    // Expo encodes the path; React Native sends it as is.
    let projectRoot = root
    try { projectRoot = decodeURI(root) } catch { /* Keep the raw path. */ }
    return { state: 'running', projectRoot }
  } catch {
    return { state: 'other' }
  }
}

/** Metro serves this checkout when its project root is the checkout or a folder in it. */
export async function servesCheckout(projectRoot: string, checkoutPath: string): Promise<boolean> {
  const [root, checkout] = await Promise.all([realpath(projectRoot).catch(() => projectRoot), realpath(checkoutPath).catch(() => checkoutPath)])
  return root === checkout || root.startsWith(checkout + sep)
}

export interface DevApp {
  appId: string
  /** The Expo dev client's URL scheme, when the project uses one. */
  devClientScheme: string | null
}

const appIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,255}$/)
const manifestSchema = z.object({ extra: z.object({ expoClient: z.object({
  slug: z.string(),
  ios: z.object({ bundleIdentifier: appIdSchema.optional() }).optional(),
  android: z.object({ package: appIdSchema.optional() }).optional(),
}) }) })

async function declares(appFolder: string, name: string): Promise<boolean> {
  try {
    // SAFETY: Only presence of the named dependency keys is used; malformed JSON is caught below.
    const manifest = JSON.parse(await readFile(join(appFolder, 'package.json'), 'utf8')) as { dependencies?: { [name: string]: string }; devDependencies?: { [name: string]: string } }
    return !!manifest.dependencies?.[name] || !!manifest.devDependencies?.[name]
  } catch {
    return false
  }
}

/** Expo's manifest names the app as its config does, a dynamic app.config included. */
async function expoApp(appFolder: string, platform: DevicePlatform, fetcher: typeof fetch): Promise<DevApp | null> {
  const response = await fetcher(`${ORIGIN}/`, { headers: { 'expo-platform': platform, accept: 'application/expo+json' }, signal: AbortSignal.timeout(60_000) }).catch(() => null)
  const parsed = manifestSchema.safeParse(await response?.json().catch(() => null))
  if (!parsed.success) return null
  const config = parsed.data.extra.expoClient
  const appId = platform === 'ios' ? config.ios?.bundleIdentifier : config.android?.package
  if (!appId) return null
  // expo-dev-client registers `exp+<slug>`.
  const devClientScheme = await declares(appFolder, 'expo-dev-client') ? `exp+${config.slug.replace(/[^A-Za-z0-9+.-]/g, '')}` : null
  return { appId, devClientScheme }
}

/** A React Native project names its app in the native projects. */
async function nativeAppId(appFolder: string, platform: DevicePlatform): Promise<string | null> {
  if (platform === 'android') {
    for (const file of ['build.gradle', 'build.gradle.kts']) {
      const text = await readFile(join(appFolder, 'android', 'app', file), 'utf8').catch(() => '')
      const value = /applicationId\s*=?\s*["']([^"']+)["']/.exec(text)?.[1]
      if (appIdSchema.safeParse(value).success) return value!
    }
    return null
  }
  const projects = (await readdir(join(appFolder, 'ios')).catch(() => [])).filter((name) => name.endsWith('.xcodeproj'))
  for (const project of projects) {
    const text = await readFile(join(appFolder, 'ios', project, 'project.pbxproj'), 'utf8').catch(() => '')
    for (const match of text.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)) {
      if (appIdSchema.safeParse(match[1]).success) return match[1]!
    }
  }
  return null
}

export async function devApp(appFolder: string, platform: DevicePlatform, usesExpo: boolean, fetcher: typeof fetch = fetch): Promise<DevApp> {
  const app = (usesExpo ? await expoApp(appFolder, platform, fetcher) : null)
    ?? await nativeAppId(appFolder, platform).then((appId) => appId ? { appId, devClientScheme: null } : null)
  if (!app) throw new DeviceDomainError('invalid_request', `Could not find this app's ${platform === 'ios' ? 'bundle id' : 'package name'}. Set it in the app config.`)
  return app
}
