import { describe, expect, test } from 'bun:test'
import {
  automationCapableHosts,
  hasHostCapability,
  normalizeHostCapabilities,
  supportsEditor,
  supportsSettingsSurface,
} from '@solus/client-core/host-capabilities'
import type { HostCapabilities } from '@solus/contracts/types'

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

  test('an advertisement from a newer host degrades per field, never whole', () => {
    // WHY: skew-safety (dispatch-client step 1). One unknown editor id from a
    // newer host used to null the entire capability record, silently reading
    // as "everything unsupported" across the app.
    const skewed = normalizeHostCapabilities({
      attachUpload: true,
      automations: 'yes',
      editors: ['vscode', 'zed'],
      futureField: { shape: 'unknown' },
    })
    expect(skewed.attachUpload).toBe(true)
    expect(skewed.automations).toBeUndefined()
    expect(skewed.editors).toEqual(['vscode'])
  })

  test('a non-object advertisement is an empty record, not a throw', () => {
    expect(normalizeHostCapabilities(null)).toEqual({})
    expect(normalizeHostCapabilities('nope')).toEqual({})
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
