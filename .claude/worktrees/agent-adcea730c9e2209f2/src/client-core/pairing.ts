import { uuid } from '../shared/uuid'
import type { SavedServer } from './server-registry'

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
  installationId?: string
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

export function desktopDeviceLabel(): string {
  return 'Solus desktop'
}

export async function pairServer(input: PairServerInput): Promise<PairServerResult> {
  const url = normalizeServerUrl(input.url)
  const res = await fetch(`${url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairToken: input.pairToken,
      deviceLabel: input.deviceLabel || desktopDeviceLabel(),
    }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `Pair failed (${res.status})`)
  }

  const body = await res.json() as { sessionToken?: string; installationId?: string }
  if (!body.sessionToken) throw new Error('Pair response did not include a session token')

  const server: SavedServer = {
    id: body.installationId ?? uuid(),
    label: input.serverLabel || urlHost(url),
    url,
    sessionToken: body.sessionToken,
    installationId: body.installationId,
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
      deviceLabel: input.deviceLabel || desktopDeviceLabel(),
    }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `Claim failed (${res.status})`)
  }

  const body = await res.json() as {
    ok?: boolean
    sessionToken?: string
    ownerDeviceId?: string
    claimedAt?: number
    installationId?: string
    fingerprint?: string
  }
  if (body.ok !== true) throw new Error('Claim response did not confirm ownership')
  if (!body.sessionToken) throw new Error('Claim response did not include a session token')
  if (!body.ownerDeviceId) throw new Error('Claim response did not include an owner device id')
  if (!body.installationId) throw new Error('Claim response did not include an installation id')
  if (!body.fingerprint) throw new Error('Claim response did not include a fingerprint')
  if (typeof body.claimedAt !== 'number') throw new Error('Claim response did not include a claim timestamp')

  const server: SavedServer = {
    id: body.installationId,
    label: input.serverLabel || urlHost(url),
    url,
    sessionToken: body.sessionToken,
    installationId: body.installationId,
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
