import type { TurnRefusal } from '@solus/contracts/organization-scope'
import { isPermissionModeAbove } from '@solus/contracts/policy'
import type { PermissionMode } from '@solus/contracts/types'
import type { WorkPolicy } from '@solus/contracts/host-policies'

/** What the refused person can do next. */
export type TurnRefusalAction = 'choose-organization' | 'sign-in' | 'lower-mode' | 'none'

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
    case 'WORKSPACE_PREPARING':
      return { title: 'Setting up your workspace for the first time', hint: 'Send again in a moment.', action: 'none' }
    // A policy refusal (plans/030 §6.1): the host's message names the policy and its rule.
    case 'PERMISSION_MODE_ABOVE_LIMIT':
      return { title: 'This permission mode is not allowed', hint: 'Lower the mode, then send again.', action: 'lower-mode' }
    case 'PROVIDER_NOT_ALLOWED':
      return { title: 'This agent is not allowed', hint: 'Choose another agent, then send again.', action: 'none' }
    case 'MODEL_NOT_ALLOWED':
      return { title: 'This model is not allowed', hint: 'Choose another model, then send again.', action: 'none' }
    case 'SETTING_MANAGED':
      return { title: 'This setting is managed', hint: 'The policy sets this value. You cannot change it here.', action: 'none' }
    case 'REMOTE_ACCESS_NOT_ALLOWED':
      return { title: 'Remote access is not allowed', hint: 'Use Solus on the machine that runs this host.', action: 'none' }
    case 'CLOUD_TUNNEL_NOT_ALLOWED':
      return { title: 'The Solus Cloud tunnel is not allowed', hint: 'Connect to this host in a different way.', action: 'none' }
    case 'UPDATES_MANAGED':
      return { title: 'Updates are managed', hint: 'Your organization installs Solus updates.', action: 'none' }
    case 'POLICY_UNAVAILABLE':
      return { title: 'This host has no policy for this work yet', hint: '', action: 'none' }
    case 'POLICY_UNENFORCEABLE':
      return { title: 'This host cannot apply the policy', hint: '', action: 'none' }
  }
}

/**
 * The mode "Lower the mode" sets after a PERMISSION_MODE_ABOVE_LIMIT refusal:
 * the ceiling, the highest mode the policy allows. Null when the client does
 * not know a ceiling that `current` is above, so the card offers no action.
 */
export function loweredPermissionMode(policy: WorkPolicy, current: PermissionMode): PermissionMode | null {
  const ceiling = policy.ceiling()
  return ceiling && isPermissionModeAbove(current, ceiling.value) ? ceiling.value : null
}
