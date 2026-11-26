import { describe, expect, test } from 'bun:test'
import { validatePolicyDocument, type PolicyDocument } from '@solus/contracts/policy'
import { applyPolicyBlock, blockDocument, POLICY_BLOCKS, policyBlocksFor } from '@solus/workspace-ui/components/settings/policy/lib/policy-blocks'
import { policyText } from '@solus/workspace-ui/components/settings/policy/lib/policy-editor'

// Settings → Policy: a person builds a policy from blocks instead of JSON. A
// block must write a document the one validator accepts, read back what it
// wrote, and leave no empty section behind when it is removed.

const empty: PolicyDocument = { schemaVersion: 1, organization: { name: 'Acme' } }

function block(id: string) {
  const found = POLICY_BLOCKS.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no block ${id}`)
  return found
}

describe('policy building blocks', () => {
  test('each block, at each choice, writes a valid MDM policy and reads its choice back', () => {
    for (const candidate of POLICY_BLOCKS) {
      for (const choice of candidate.choices) {
        const document = blockDocument(applyPolicyBlock(empty, candidate, choice.value))
        expect(document).not.toBeNull()
        if (!document) continue
        expect(validatePolicyDocument(document, 'mdm').ok).toBe(true)
        expect(candidate.read(document)).toBe(choice.value)
      }
    }
  })

  test('removing the last rule leaves the document as it was', () => {
    const withMode = blockDocument(applyPolicyBlock(empty, block('maxPermissionMode'), 'supervised'))
    const withBoth = withMode && blockDocument(applyPolicyBlock(withMode, block('updates'), 'off'))
    expect(withBoth?.sessions?.limits?.maxPermissionMode).toBe('supervised')
    const removed = withBoth && blockDocument(applyPolicyBlock(withBoth, block('maxPermissionMode'), undefined))
    const cleared = removed && applyPolicyBlock(removed, block('updates'), undefined)
    expect(cleared).toBe(policyText(empty))
  })

  test('a block keeps the keys beside it that it does not own', () => {
    const document: PolicyDocument = { ...empty, host: { updates: { mode: 'auto', feedUrl: 'https://updates.example.com' } } }
    const next = blockDocument(applyPolicyBlock(document, block('updates'), 'off'))
    expect(next?.host?.updates).toEqual({ mode: 'off', feedUrl: 'https://updates.example.com' })
  })

  test('an organization policy offers no host settings, as the validator refuses them there', () => {
    expect(policyBlocksFor('organization').some((candidate) => candidate.group === 'Host settings')).toBe(false)
    expect(policyBlocksFor('host').some((candidate) => candidate.group === 'Host settings')).toBe(true)
  })

  test('text that is not a policy shape gives the blocks nothing to change', () => {
    expect(blockDocument('{')).toBeNull()
    expect(blockDocument('{"schemaVersion":2}')).toBeNull()
    // A rule that conflicts with another still opens in the blocks, so a block can fix it.
    const conflicting = { ...empty, sessions: { settings: { defaultPermissionMode: 'full-access' }, limits: { maxPermissionMode: 'plan' } } }
    expect(blockDocument(JSON.stringify(conflicting))).not.toBeNull()
  })
})
