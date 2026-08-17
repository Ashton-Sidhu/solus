import { z } from 'zod'
import type { SavedServer } from './server-registry'
import type { HostOperatingSystem, SshBootstrapCredential } from '../shared/types'
import { localApi } from './local-api'

// Handshake decoding is forward-compatible: a field a newer server reshapes
// (an unknown `os`, a structured error) degrades to "absent" instead of
// failing the response — a decode error here would block pairing entirely.
const tolerantString = z.string().optional().catch(undefined)
const tolerantOs = z.enum(['macos', 'windows', 'linux']).optional().catch(undefined)
const serverErrorSchema = z.object({ error: tolerantString }).catch({})
const pairResponseSchema = z.object({
  sessionToken: tolerantString,
  installationId: tolerantString,
  os: tolerantOs,
}).catch({})
const claimResponseSchema = z.object({
  ok: z.boolean().optional().catch(undefined),
  sessionToken: tolerantString,
  ownerDeviceId: tolerantString,
  claimedAt: z.number().optional().catch(undefined),
  installationId: tolerantString,
  fingerprint: tolerantString,
  os: tolerantOs,
}).catch({})

export interface ParsedPairLink {
  url: string
  pairToken: string
}

export interface PairServerInput {
  url: string
  pairToken: string
  deviceLabel: string
  serverLabel?: string
}

export interface PairServerResult {
  server: SavedServer
  sessionToken: string
  installationId: string
}

export interface ClaimServerInput {
  url: string
  code: string
  deviceLabel: string
  serverLabel?: string
}

export interface ClaimServerResult {
  server: SavedServer
  sessionToken: string
  ownerDeviceId: string
  claimedAt: number
  installationId: string
  fingerprint: string
}

export function parsePairLink(link: string): ParsedPairLink | null {
  try {
    const u = new URL(link.trim())
    const fragment = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash
    const params = new URLSearchParams(fragment)
    const pairToken = params.get('token')
    if (!pairToken) return null
    return { url: `${u.protocol}//${u.host}`, pairToken }
  } catch {
    return null
  }
}

export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed.replace(/\/+$/, '') : `http://${trimmed.replace(/\/+$/, '')}`
}

export function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * What this device calls itself when it pairs. The desktop app is always
 * "Solus desktop"; a browser names itself by browser and OS so the server's
 * device list distinguishes a phone from the desktop that paired it.
 */
export function defaultDeviceLabel(): string {
  if (localApi.getPlatform() !== 'web') return 'Solus desktop'
  const ua = navigator.userAgent
  const os = /iPhone|iPad/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : 'device'
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome/.test(ua) ? 'Chrome'
    : /Firefox/.test(ua) ? 'Firefox'
    : /Safari/.test(ua) ? 'Safari'
    : 'Browser'
  return `${browser} on ${os}`
}

export async function pairServer(input: PairServerInput): Promise<PairServerResult> {
  const url = normalizeServerUrl(input.url)
  const res = await fetch(`${url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairToken: input.pairToken,
      deviceLabel: input.deviceLabel || defaultDeviceLabel(),
    }),
  })
  if (!res.ok) {
    const body = serverErrorSchema.parse(await res.json().catch(() => ({})))
    throw new Error(body.error ?? `Pair failed (${res.status})`)
  }

  const body = pairResponseSchema.parse(await res.json().catch(() => ({})))
  if (!body.sessionToken) throw new Error('Pair response did not include a session token')
  if (!body.installationId) throw new Error('Pair response did not include an installation id')

  const server: SavedServer = {
    id: body.installationId,
    label: input.serverLabel || urlHost(url),
    url,
    sessionToken: body.sessionToken,
    installationId: body.installationId,
    os: body.os,
    lastConnected: Date.now(),
  }

  return { server, sessionToken: body.sessionToken, installationId: body.installationId }
}

export async function claimServer(input: ClaimServerInput): Promise<ClaimServerResult> {
  const url = normalizeServerUrl(input.url)
  const res = await fetch(`${url}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: input.code,
      deviceLabel: input.deviceLabel || defaultDeviceLabel(),
    }),
  })
  if (!res.ok) {
    const body = serverErrorSchema.parse(await res.json().catch(() => ({})))
    throw new Error(body.error ?? `Claim failed (${res.status})`)
  }

  const body = claimResponseSchema.parse(await res.json().catch(() => ({})))
  if (body.ok !== true) throw new Error('Claim response did not confirm ownership')
  if (!body.sessionToken) throw new Error('Claim response did not include a session token')
  if (!body.ownerDeviceId) throw new Error('Claim response did not include an owner device id')
  if (!body.installationId) throw new Error('Claim response did not include an installation id')
  if (!body.fingerprint) throw new Error('Claim response did not include a fingerprint')
  if (body.claimedAt === undefined) throw new Error('Claim response did not include a claim timestamp')

  const server: SavedServer = {
    id: body.installationId,
    label: input.serverLabel || urlHost(url),
    url,
    sessionToken: body.sessionToken,
    installationId: body.installationId,
    os: body.os,
    lastConnected: Date.now(),
  }

  return {
    server,
    sessionToken: body.sessionToken,
    ownerDeviceId: body.ownerDeviceId,
    claimedAt: body.claimedAt,
    installationId: body.installationId,
    fingerprint: body.fingerprint,
  }
}

export function saveBootstrappedServer(
  urlInput: string,
  credential: SshBootstrapCredential,
  serverLabel?: string,
  os?: HostOperatingSystem,
): SavedServer {
  const url = normalizeServerUrl(urlInput)
  return {
    id: credential.installationId,
    label: serverLabel || urlHost(url),
    url,
    sessionToken: credential.sessionToken,
    installationId: credential.installationId,
    os,
    lastConnected: Date.now(),
  }
}
