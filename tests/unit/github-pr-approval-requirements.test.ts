import { describe, expect, test } from 'bun:test'
import { requiredApprovalCount } from '@solus/server/providers/github/provider'

describe('GitHub pull request approval requirements', () => {
  test('uses the strongest active pull request rule', () => {
    // WHY: repository and organization rules can both apply to one base
    // branch. The PR must satisfy the strongest numeric approval requirement.
    expect(
      requiredApprovalCount([
        { type: 'required_status_checks' },
        { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
        { type: 'pull_request', parameters: { required_approving_review_count: 2 } },
      ]),
    ).toBe(2)
  })

  test('combines rulesets with classic branch protection', () => {
    expect(
      requiredApprovalCount(
        [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }],
        3,
      ),
    ).toBe(3)
  })

  test('returns zero when no active pull request rule requires approval', () => {
    expect(requiredApprovalCount([{ type: 'required_status_checks' }])).toBe(0)
  })
})
