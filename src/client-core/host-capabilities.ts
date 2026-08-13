import type { EditorId, HostCapabilities } from '../shared/types'
import { z } from 'zod'

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
const hostCapabilitiesSchema = z.object({
  attachUpload: z.boolean().optional(),
  assetUrls: z.boolean().optional(),
  skillsInstall: z.boolean().optional(),
  skillsSearch: z.boolean().optional(),
  voiceModel: z.boolean().optional(),
  automations: z.boolean().optional(),
  githubProvider: z.boolean().optional(),
  editors: z.array(editorIdSchema).optional(),
})

/** Keep only protocol fields this client understands. */
export function normalizeHostCapabilities(value: z.input<typeof hostCapabilitiesSchema>): HostCapabilities {
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
