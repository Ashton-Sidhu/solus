import type { EditorId, HostCapabilities } from '../shared/types'
import { z } from 'zod'
import { forwardCompatibleArray } from './forward-compat'

export const HOST_BOOLEAN_CAPABILITY_KEYS = [
  'attachUpload',
  'assetUrls',
  'skillsInstall',
  'skillsSearch',
  'voiceModel',
  'automations',
  'githubProvider',
] as const

export type HostBooleanCapability = (typeof HOST_BOOLEAN_CAPABILITY_KEYS)[number]
export type HostSettingsSurface = 'skills' | 'tools' | 'voice'

const editorIdSchema = z.enum(['vscode', 'vim', 'nvim', 'helix'])
// Every field degrades alone: an advertisement from a newer host (an unknown
// editor id, a reshaped value) must never blank the entire capability record —
// that reads as "everything unsupported" across the whole app.
const tolerantBoolean = z.boolean().optional().catch(undefined)
const hostCapabilitiesSchema = z.object({
  version: z.string().optional().catch(undefined),
  attachUpload: tolerantBoolean,
  assetUrls: tolerantBoolean,
  skillsInstall: tolerantBoolean,
  skillsSearch: tolerantBoolean,
  voiceModel: tolerantBoolean,
  automations: tolerantBoolean,
  githubProvider: tolerantBoolean,
  editors: forwardCompatibleArray(editorIdSchema).optional().catch(undefined),
})

/** Keep only protocol fields this client understands. This function is the
 *  I/O boundary: the advertisement may come from a newer host, so no shape
 *  can be assumed before the schema runs. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function normalizeHostCapabilities(value: unknown): HostCapabilities {
  const parsed = hostCapabilitiesSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

export function hasHostCapability(
  capabilities: HostCapabilities | undefined,
  key: HostBooleanCapability,
): boolean {
  return capabilities?.[key] === true
}

export function supportsEditor(
  capabilities: HostCapabilities | undefined,
  editorId: EditorId,
): boolean {
  return capabilities?.editors?.includes(editorId) === true
}

export function supportsSettingsSurface(
  capabilities: HostCapabilities | undefined,
  surface: HostSettingsSurface,
): boolean {
  if (surface === 'skills') return hasHostCapability(capabilities, 'skillsSearch')
  if (surface === 'voice') return hasHostCapability(capabilities, 'voiceModel')
  return capabilities?.editors !== undefined
}

export function unsupportedOnHost(feature: string, hostLabel: string): string {
  return `${feature} are not supported on ${hostLabel}.`
}

export function automationCapableHosts<T extends { serverId: string }>(
  hosts: readonly T[],
  capabilitiesFor: (serverId: string) => HostCapabilities | undefined,
): T[] {
  return hosts.filter((host) => hasHostCapability(capabilitiesFor(host.serverId), 'automations'))
}
