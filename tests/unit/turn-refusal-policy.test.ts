import { describe, expect, test } from 'bun:test'
import { HostPolicies } from '@solus/contracts/host-policies'
import { POLICY_REFUSAL_CODES, type PolicySet } from '@solus/contracts/policy'
import { loweredPermissionMode, turnRefusalCopy } from '../../packages/workspace-ui/src/components/connections/lib/turn-refusal-copy'

const input = { signedIn: true, activeOrganization: 'Globex' }

describe('policy refusal copy', () => {
  test('every policy refusal code has a title, and only the mode refusal offers an action', () => {
    for (const code of POLICY_REFUSAL_CODES) {
      const copy = turnRefusalCopy(code, input)
      expect(copy.title.length).toBeGreaterThan(0)
      expect(copy.action).toBe(code === 'PERMISSION_MODE_ABOVE_LIMIT' ? 'lower-mode' : 'none')
    }
  })

  test('the hint never repeats what the host message already says', () => {
    // The host message of these two ends with what to do; the card adds nothing.
    expect(turnRefusalCopy('POLICY_UNAVAILABLE', input).hint).toBe('')
    expect(turnRefusalCopy('POLICY_UNENFORCEABLE', input).hint).toBe('')
    expect(turnRefusalCopy('PERMISSION_MODE_ABOVE_LIMIT', input).hint).toBe('Lower the mode, then send again.')
  })
})

describe('lower the mode', () => {
  const set: PolicySet = {
    mdm: { kind: 'mdm', organizationId: null, document: { schemaVersion: 1, organization: { name: 'Example Corp' }, sessions: { limits: { maxPermissionMode: 'supervised' } } } },
    hostOwnerOrganizationId: null,
    organizations: {},
  }

  test('a mode above the ceiling lowers to the ceiling, the highest allowed mode', () => {
    expect(loweredPermissionMode(new HostPolicies(set).forWork('local'), 'full-access')).toBe('supervised')
  })

  test('no action when the mode is already allowed or no ceiling is known', () => {
    expect(loweredPermissionMode(new HostPolicies(set).forWork('local'), 'plan')).toBeNull()
    expect(loweredPermissionMode(HostPolicies.none.forWork('local'), 'full-access')).toBeNull()
  })
})
