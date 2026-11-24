import { describe, expect, mock, test } from 'bun:test'
import { join } from 'node:path'

/**
 * Settings opens with no section skeleton between the page and the section.
 * `{#await}` shows its pending branch for any promise, even one for a module that
 * has already loaded, so a loaded section must come back as the module itself.
 */

const settingsFolder = join(import.meta.dir, '../../packages/workspace-ui/src/components/settings')
mock.module(join(settingsFolder, 'SettingsTabGeneral.svelte'), () => ({ default: 'SettingsTabGeneral' }))
mock.module(join(settingsFolder, 'SettingsTabChat.svelte'), () => {
  throw new Error('chunk failed')
})

const { settingsSection } = await import('../../packages/workspace-ui/src/components/settings/lib/settings-section-loaders')

describe('settingsSection', () => {
  // WHY: a promise for a loaded module flashes the section skeleton on every open and tab switch.
  test('gives a loaded section as the module, not a promise', async () => {
    const first = settingsSection('general')
    expect(first).toBeInstanceOf(Promise)
    const loaded = await first

    expect(settingsSection('general')).toBe(loaded)
  })

  // WHY: a failed load must not stick; the next open tries the section again.
  test('does not keep a failed load', async () => {
    await expect(settingsSection('chat')).rejects.toThrow()

    const retry = settingsSection('chat')
    expect(retry).toBeInstanceOf(Promise)
    await Promise.resolve(retry).catch(() => {})
  })
})
