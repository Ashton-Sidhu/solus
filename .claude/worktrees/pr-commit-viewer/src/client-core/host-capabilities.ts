import type { EditorId, HostCapabilities } from '../shared/types'

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

const EDITOR_IDS = new Set<EditorId>(['vscode', 'vim', 'nvim', 'helix'])

interface HostCapabilitiesWire {
  attachUpload?: unknown
  assetUrls?: unknown
  skillsInstall?: unknown
  skillsSearch?: unknown
  voiceModel?: unknown
  automations?: unknown
  githubProvider?: unknown
  editors?: unknown
}

/** Keep only protocol fields this client understands. */
export function normalizeHostCapabilities(value: unknown): HostCapabilities {
  if (!value || typeof value !== 'object') return {}
  const source = value as HostCapabilitiesWire
  const capabilities: HostCapabilities = {}
  for (const key of HOST_BOOLEAN_CAPABILITY_KEYS) {
    if (typeof source[key] === 'boolean') capabilities[key] = source[key]
  }
  if (Array.isArray(source.editors)) {
    capabilities.editors = source.editors.filter(
      (editor): editor is EditorId => typeof editor === 'string' && EDITOR_IDS.has(editor as EditorId),
    )
  }
  return capabilities
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
