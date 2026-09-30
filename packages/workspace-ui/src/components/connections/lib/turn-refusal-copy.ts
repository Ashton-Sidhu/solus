import type { TurnRefusal } from '@solus/contracts/organization-scope'

/** What the refused person can do next. */
export type TurnRefusalAction = 'choose-organization' | 'sign-in' | 'none'

export interface TurnRefusalCopy {
  title: string
  /** What to do, after the host's own reason. */
  hint: string
  action: TurnRefusalAction
}

/**
 * The organization refusal card's words (plan 004 step 11). The host's message
 * says why and names the organization when it knew it; this says what the
 * reader can do, and which one control does it. `activeOrganization` is the
 * organization this window works in, the one a new turn asks for.
 */
export function turnRefusalCopy(code: TurnRefusal, input: { signedIn: boolean; activeOrganization: string | null }): TurnRefusalCopy {
  const organization = input.activeOrganization ?? 'your organization'
  switch (code) {
    case 'ORGANIZATION_REQUIRED':
      return input.signedIn
        ? { title: 'This turn needs an organization', hint: 'Choose the organization to work in, then send again.', action: 'choose-organization' }
        : { title: 'This turn needs an organization', hint: 'Sign in to Solus and choose the organization to work in, then send again.', action: 'sign-in' }
    case 'PERSONAL_HOSTS_NOT_ALLOWED':
      return { title: `${organization} does not run work here`, hint: 'Send it from a self-hosted server or a cloud host of the organization.', action: 'none' }
    case 'ORGANIZATION_NOT_ALLOWED':
      return { title: `This machine does not run work for ${organization}`, hint: 'Choose an organization this machine works for, then send again.', action: 'choose-organization' }
    case 'ORGANIZATION_ACCESS_REFUSED':
      return { title: `${organization} refused this turn`, hint: 'Ask an organization admin for access, then send again.', action: 'none' }
    case 'ORGANIZATION_API_UNAVAILABLE':
      return { title: `Cannot reach ${organization}`, hint: 'The organization’s Solus API did not answer. Send again in a moment.', action: 'none' }
    case 'ORGANIZATION_AUTHORITY_MISSING':
      return { title: 'This machine cannot act for you yet', hint: 'Sign in to Solus again so this machine can act for you, then send again.', action: 'sign-in' }
  }
}
