import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const settingsPage = readFileSync(
  new URL('../../packages/workspace-ui/src/components/settings/SettingsPage.svelte', import.meta.url).pathname,
  'utf8',
)
const reviewSettings = readFileSync(
  new URL('../../packages/workspace-ui/src/components/settings/SettingsTabReview.svelte', import.meta.url).pathname,
  'utf8',
)

describe('settings typography', () => {
  test('button labels inherit the responsive workspace chrome rung in both layouts', () => {
    // WHY: compact Button variants pin a static size. Settings actions must be
    // 12px on laptop displays and 14px on desktop and coarse-pointer clients,
    // including host-backed subpages rendered inside the settings shell.
    expect(settingsPage.match(/\[&_button\]:text-\[length:inherit\]/gu)).toHaveLength(2)
  })

  test('review instructions use the chrome rung for placeholder and entered text', () => {
    // WHY: the shared prose editor defaults to the larger body rung. This field
    // is compact settings chrome, so its hint must not dominate the row.
    expect(reviewSettings).toContain('[--plain-editor-font-size:var(--text-workspace-chrome)]')
  })
})
