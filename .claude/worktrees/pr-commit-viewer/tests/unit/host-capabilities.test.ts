import { describe, expect, test } from 'bun:test'
import {
  automationCapableHosts,
  hasHostCapability,
  normalizeHostCapabilities,
  supportsEditor,
  supportsSettingsSurface,
} from '../../src/client-core/host-capabilities'
import type { HostCapabilities } from '../../src/shared/types'

describe('host capability gates', () => {
  test('uses absence as unsupported for attachment and asset families', () => {
    // WHY: this is the version-skew rule. No surface may infer support from a
    // connected socket or wait for an unknown-method error.
    expect(hasHostCapability(undefined, 'attachUpload')).toBe(false)
    expect(hasHostCapability({}, 'assetUrls')).toBe(false)
    expect(hasHostCapability({ attachUpload: true }, 'attachUpload')).toBe(true)
  })

  test('maps each host-framed settings surface to its advertised feature', () => {
    expect(supportsSettingsSurface({}, 'skills')).toBe(false)
    expect(supportsSettingsSurface({ skillsSearch: true }, 'skills')).toBe(true)
    expect(supportsSettingsSurface({ editors: [] }, 'tools')).toBe(true)
    expect(supportsSettingsSurface({ voiceModel: false }, 'voice')).toBe(false)
  })

  test('filters automation hosts and editor choices from the record', () => {
    const records = new Map<string, HostCapabilities>([
      ['new', { automations: true, editors: ['vscode'] }],
      ['old', {}],
    ])
    const hosts = automationCapableHosts(
      [{ serverId: 'new' }, { serverId: 'old' }],
      (serverId) => records.get(serverId),
    )

    expect(hosts).toEqual([{ serverId: 'new' }])
    expect(supportsEditor(normalizeHostCapabilities(records.get('new')), 'vscode')).toBe(true)
    expect(supportsEditor(normalizeHostCapabilities(records.get('new')), 'vim')).toBe(false)
  })
})
