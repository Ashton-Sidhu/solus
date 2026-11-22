import { z } from 'zod'
import type { ThemeMode } from './settings'
import { identityClaimsSchema } from './auth/clients'

/** The HTML contract between the account server and the web client. */
export const ACCOUNT_SHELL = {
  marker: 'solus-account-origin',
  identity: 'solus-account-identity',
  directory: 'solus-host-directory',
  account: 'solus-account',
  settings: 'solus-account-settings',
} as const

export const shellIdentitySchema = z.object({ identity: identityClaimsSchema, signedInAt: z.number() })
export type ShellIdentity = z.input<typeof shellIdentitySchema>

export const ACCOUNT_SETTINGS_PATHS = {
  appearance: '/account/appearance',
  'agent-profile': '/account/agent-profile',
  connections: '/connections',
} as const
export type AccountSettingsPageId = keyof typeof ACCOUNT_SETTINGS_PATHS

/** Workspace tabs that the account origin exposes at stable public addresses. */
export function accountSettingsDestination(pathname: string): 'appearance' | 'agent-profile' | undefined {
  const path = pathname.replace(/\/$/, '')
  if (path === ACCOUNT_SETTINGS_PATHS.appearance) return 'appearance'
  if (path === ACCOUNT_SETTINGS_PATHS['agent-profile']) return 'agent-profile'
  return undefined
}

export const ACCOUNT_THEME_COOKIE = 'solus-appearance'
export const LEGACY_THEME_COOKIE = 'solus-theme'

/** The old console pin is a first preference only when the account has no theme of its own. */
export function legacyAccountTheme(previous: string | undefined, mirror: string | undefined, stored: ThemeMode | undefined): ThemeMode | undefined {
  return !mirror && !stored && (previous === 'light' || previous === 'dark') ? previous : undefined
}
