import type { PolicyApiResult } from '@solus/contracts/host-api'
import type { OrganizationHostRules, OrganizationSettingsResponse } from '@solus/contracts/policy-api'

/** An owner changes the organization's settings; a member reads them. Solus Cloud checks it again on each write. */
export function canManageOrganization(settings: Pick<OrganizationSettingsResponse, 'role'>): boolean {
  return settings.role === 'owner'
}

/** Packages as a person types them: separated by spaces or commas, each once. */
export function packagesFromText(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))]
}

/** The host rules with one change, ready to save against the revision that was read. */
export function changedHostRules(rules: OrganizationHostRules, change: Partial<OrganizationHostRules>): OrganizationHostRules {
  const next = { ...rules, ...change }
  // A blank script is no script, as Solus Cloud stores it.
  return next.defaultSetupScript?.trim() ? next : { ...next, defaultSetupScript: null }
}

/** True when saving `next` would change nothing. */
export function sameHostRules(rules: OrganizationHostRules, next: OrganizationHostRules): boolean {
  return rules.allowCloudHosts === next.allowCloudHosts &&
    rules.allowPersonalHosts === next.allowPersonalHosts &&
    rules.defaultSetupScript === next.defaultSetupScript &&
    rules.defaultPackages.join(' ') === next.defaultPackages.join(' ')
}

/** What a refused write tells the owner. Null on success. */
export function organizationSettingsMessage(result: PolicyApiResult<unknown>): string | null {
  switch (result.kind) {
    case 'ok': return null
    case 'conflict': return 'Another owner saved first. Their settings are shown. Make your change again.'
    case 'rejected': return `Not saved: ${result.issues.join('; ')}.`
    case 'forbidden': return 'Only an owner of this organization can change its settings.'
    case 'signed-out': return 'Sign in to Solus again to change these settings.'
    case 'offline': return 'Solus could not reach your account. Nothing was saved.'
    case 'error': return result.message ?? `Solus Cloud did not accept the change (${result.code}).`
  }
}

/** The Solus console page for one organization, for what Solus does not change itself. */
export type OrganizationConsolePage = 'members' | 'invite' | 'audit' | 'observability' | 'leave' | 'delete'

export function organizationConsoleUrl(consoleUrl: string, organizationId: string, page: OrganizationConsolePage): string {
  return new URL(`/organizations/${encodeURIComponent(organizationId)}/${page}`, consoleUrl).toString()
}
