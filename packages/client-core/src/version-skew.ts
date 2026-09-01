import { z } from 'zod'
import packageJson from '../../../package.json'
import { forwardCompatibleArray } from './forward-compat'
import { HOST_BOOLEAN_CAPABILITY_KEYS, type HostBooleanCapability } from './host-capabilities'
import type { HostCapabilities } from '@solus/contracts/types'

/** Both bundles compile from this repo, so the package version is the client
 *  version — the same value a build-time define would inject. */
export const CLIENT_VERSION: string = packageJson.version

export interface VersionSkewNotice {
  direction: 'host-older' | 'host-newer'
  clientVersion: string
  serverVersion: string
  /** Ready to render, derived from what the skew actually costs this session. */
  remediation: string
}

/** What a missing capability costs, in the user's words. `null` means the skew
 *  degrades invisibly — an older host without `promptImageRefs` just takes the
 *  image bytes inline again — so naming it would report a working feature as
 *  broken. Every capability decides, which is what keeps the record exhaustive. */
const FEATURE_WORDING = {
  attachUpload: 'file attachments',
  promptImageRefs: null,
  assetUrls: 'artifact previews',
  skillsInstall: 'skills',
  skillsSearch: 'skills',
  voiceModel: 'voice',
  automations: 'automations',
  githubProvider: 'GitHub',
  atlassianProvider: 'Atlassian',
} satisfies Record<HostBooleanCapability, string | null>

function numericParts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function isOlder(candidate: string, reference: string): boolean {
  const a = numericParts(candidate)
  const b = numericParts(reference)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left < right
  }
  return false
}

/**
 * The per-host version-skew notice (dispatch-client step 3). Null when the
 * versions match or the host never said. Remediation text is derived from the
 * session's capability record — it names what the skew actually gates.
 */
export function versionSkewNotice(
  hostLabel: string,
  serverVersion: string | undefined,
  capabilities: HostCapabilities | undefined,
  clientVersion: string = CLIENT_VERSION,
): VersionSkewNotice | null {
  if (!serverVersion || serverVersion === clientVersion) return null
  const direction = isOlder(serverVersion, clientVersion) ? 'host-older' : 'host-newer'
  if (direction === 'host-newer') {
    return {
      direction,
      clientVersion,
      serverVersion,
      remediation: `Update or reload this client to match ${hostLabel} (${serverVersion}).`,
    }
  }
  const gated = [...new Set(
    HOST_BOOLEAN_CAPABILITY_KEYS
      .filter((key) => capabilities && capabilities[key] !== true)
      .map((key) => FEATURE_WORDING[key])
      .filter((wording): wording is string => wording !== null),
  )]
  const remediation = gated.length > 0
    ? `Update Solus on ${hostLabel} to use ${gated.join(', ')}.`
    : `Update Solus on ${hostLabel} to match this client.`
  return { direction, clientVersion, serverVersion, remediation }
}

// ── Dismissals ──
// Keyed by host and BOTH versions: any version change on either side
// resurfaces the notice. Client-scoped state, forgotten with the host.

const DISMISSALS_KEY = 'solus.versionSkewDismissals.v1'

export function skewDismissalKey(hostId: string, clientVersion: string, serverVersion: string): string {
  return `${hostId}:${clientVersion}:${serverVersion}`
}

const dismissalsSchema = forwardCompatibleArray(z.string())

function readDismissals(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSALS_KEY)
    if (!raw) return []
    const decoded = dismissalsSchema.safeParse(JSON.parse(raw))
    if (decoded.success) return decoded.data
  } catch {}
  try {
    localStorage.removeItem(DISMISSALS_KEY)
  } catch {}
  return []
}

export function isSkewDismissed(dismissalKey: string): boolean {
  return readDismissals().includes(dismissalKey)
}

export function dismissSkew(dismissalKey: string): void {
  const dismissals = readDismissals()
  if (dismissals.includes(dismissalKey)) return
  dismissals.push(dismissalKey)
  try {
    localStorage.setItem(DISMISSALS_KEY, JSON.stringify(dismissals))
  } catch {}
}

/** Forgetting a host is total: its dismissals leave with it. */
export function forgetSkewDismissals(hostId: string): void {
  const kept = readDismissals().filter((entry) => !entry.startsWith(`${hostId}:`))
  try {
    localStorage.setItem(DISMISSALS_KEY, JSON.stringify(kept))
  } catch {}
}
