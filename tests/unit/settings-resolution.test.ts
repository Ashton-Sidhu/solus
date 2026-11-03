import { describe, expect, test } from 'bun:test'
import { DEFAULT_HOST_CONFIG, HOST_CONFIG_KEYS, hostConfigPatchSchema } from '@solus/contracts/host-config'
import {
  accountSettingsPatchRequestSchema,
  CLIENT_DEVICE_LAYOUT_KEYS,
  DEFAULT_DEVICE_SETTINGS,
  DEFAULT_PERSONAL_SETTINGS,
  PERSONAL_SETTING_KEYS,
  personalSettingsDocumentSchema,
  personalSettingsSchema,
  personalSettingsWithDefaults,
} from '@solus/contracts/settings'
import { MANAGED_SESSION_SETTING_KEYS, validatePolicyDocument } from '@solus/contracts/policy'

describe('ownership', () => {
  // A setting has one owner. A key in two tables would be written in two
  // places, and the two copies would drift.
  test('personal, device, and host keys never overlap', () => {
    const owners = [PERSONAL_SETTING_KEYS, Object.keys(DEFAULT_DEVICE_SETTINGS), CLIENT_DEVICE_LAYOUT_KEYS, HOST_CONFIG_KEYS]
    const all = owners.flatMap((keys) => [...keys])
    expect(new Set(all).size).toBe(all.length)
  })

  test('the personal defaults are a valid profile', () => {
    expect(personalSettingsSchema.safeParse(DEFAULT_PERSONAL_SETTINGS).success).toBe(true)
  })

  test('a profile with no lens choice starts with Show me, but a saved choice is preserved', () => {
    const lenses = personalSettingsWithDefaults({}).savedLenses
    expect(lenses).toHaveLength(1)
    expect(lenses[0].name).toBe('Show me')
    expect(lenses[0].prompt).toContain('plugins/show-me/skills/show-me/SKILL.md')
    expect(personalSettingsWithDefaults({ savedLenses: [] }).savedLenses).toEqual([])
    const custom = [{ id: 'custom', name: 'My lens', prompt: 'Show the data flow.' }]
    expect(personalSettingsWithDefaults({ savedLenses: custom }).savedLenses).toEqual(custom)
  })

  test('a host accepts no personal or device key', () => {
    for (const key of ['themeMode', 'extraInstructions', 'defaultPermissionMode', 'voiceModeEnabled', 'zoomFactor']) {
      expect(hostConfigPatchSchema.safeParse({ [key]: true }).success).toBe(false)
    }
  })
})

describe('personal sync payloads', () => {
  test('host, device, and secret keys are refused, not dropped', () => {
    for (const key of [...HOST_CONFIG_KEYS, 'voiceModeEnabled', 'defaultEditor', 'clientAnalyticsEnabled', 'projectsBaseDirectory', 'zoomFactor', 'keybindings']) {
      const parsed = personalSettingsDocumentSchema.safeParse({ [key]: DEFAULT_HOST_CONFIG[key as keyof typeof DEFAULT_HOST_CONFIG] ?? true })
      expect(parsed.success).toBe(false)
    }
    expect(personalSettingsDocumentSchema.safeParse({ otel: { headers: 'authorization=secret' } }).success).toBe(false)
  })

  test('a malformed value is refused rather than healed to a default', () => {
    expect(personalSettingsDocumentSchema.safeParse({ themeMode: 'purple' }).success).toBe(false)
    expect(personalSettingsDocumentSchema.safeParse({ fontSize: 400 }).success).toBe(false)
    expect(personalSettingsDocumentSchema.safeParse({ extraInstructions: 'x'.repeat(20_001) }).success).toBe(false)
  })

  test('a synced font is a bundled preset; an installed family is not portable', () => {
    expect(personalSettingsDocumentSchema.safeParse({ fontFamily: 'inter' }).success).toBe(true)
    expect(personalSettingsDocumentSchema.safeParse({ fontFamily: 'Comic Neue' }).success).toBe(false)
  })

  test('a patch may reset only personal keys', () => {
    expect(accountSettingsPatchRequestSchema.safeParse({ generation: 0, expectedRevision: 1, set: {}, reset: ['themeMode'] }).success).toBe(true)
    expect(accountSettingsPatchRequestSchema.safeParse({ generation: 0, expectedRevision: 1, set: {}, reset: ['otel'] }).success).toBe(false)
  })
})

describe('managed settings (plans/030)', () => {
  // A policy locks only settings the host enforces. A comfort setting such as a
  // font is never manageable: only the client applies it, so a lock would be a request.
  test('only host-enforced personal settings can be locked', () => {
    for (const key of MANAGED_SESSION_SETTING_KEYS) expect(PERSONAL_SETTING_KEYS).toContain(key)
    for (const key of ['fontFamily', 'themeMode', 'showToolCalls', 'responseStreamingMode', 'activeAgent']) {
      expect(validatePolicyDocument({ schemaVersion: 1, organization: { name: 'A' }, sessions: { settings: { [key]: DEFAULT_PERSONAL_SETTINGS[key as keyof typeof DEFAULT_PERSONAL_SETTINGS] } } }, 'organization').ok).toBe(false)
    }
  })

  test('a locked value is refused rather than healed', () => {
    expect(validatePolicyDocument({ schemaVersion: 1, organization: { name: 'A' }, sessions: { settings: { defaultPermissionMode: 'yes' } } }, 'organization').ok).toBe(false)
  })
})
