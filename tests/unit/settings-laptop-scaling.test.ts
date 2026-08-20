import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const componentSource = (path: string) =>
  readFileSync(
    new URL(`../../packages/workspace-ui/src/components/${path}`, import.meta.url),
    'utf8',
  )

describe('settings laptop scaling', () => {
  test('the settings shell and shared rows use the canonical responsive type rung', () => {
    // WHY: Settings stays mounted on desktop and web. It must follow the one
    // laptop classification instead of inventing a second viewport boundary.
    const page = componentSource('settings/SettingsPage.svelte')
    const row = componentSource('settings/SettingsRow.svelte')

    expect(page).toContain('text-workspace-chrome')
    expect(page).toContain('[.is-laptop-display_&]:max-w-[60rem]')
    expect(row).toContain('text-workspace-chrome font-medium')
    expect(row).toContain('[.is-laptop-display_&]:py-2.5')
  })

  test('host onboarding uses the same responsive type and laptop geometry', () => {
    // WHY: adding a host is part of the same Settings flow, so opening the
    // modal must not jump back to large-desktop density on a laptop.
    const onboarding = componentSource('servers/HostOnboarding.svelte')

    expect(onboarding).toContain('text-workspace-chrome')
    expect(onboarding).toContain('[.is-laptop-display_&]:max-w-[50rem]')
    expect(onboarding).toContain('[.is-laptop-display_&]:w-[15.5rem]')
  })

  test('host rows do not render activity or network-source chips', () => {
    // WHY: the host name and metadata already communicate identity and status;
    // the two extra chips make the directory noisy and consume laptop width.
    const directory = componentSource('servers/HostDirectory.svelte')

    expect(directory).not.toContain('Running sessions')
    expect(directory).not.toContain('"LAN" : "Tailnet"')
  })
})
