import { describe, expect, test } from 'bun:test'
import { getStartedItems, type GetStartedFacts } from '@solus/workspace-ui/components/onboarding/lib/get-started'

// The "Get started" list on a cloud account's new-tab home (docs/plans/cloud-onboarding.md §3.7):
// what onboarding asked and the person skipped, read as live facts.

const DONE: GetStartedFacts = { hasMachine: true, hasSignedInAgent: true, githubConnected: true, hasProject: true }
const ids = (facts: Partial<GetStartedFacts>) => getStartedItems({ ...DONE, ...facts }).map((item) => item.id)

describe('the Get started list', () => {
  test('a set-up account sees nothing', () => {
    expect(getStartedItems(DONE)).toEqual([])
  })

  test('everything skipped reads in onboarding order, and each row reopens the stage that answers it', () => {
    const items = getStartedItems({ hasMachine: false, hasSignedInAgent: null, githubConnected: false, hasProject: false })
    expect(items.map((item) => [item.id, item.stage])).toEqual([
      ['machine', 'compute'],
      ['github', 'github'],
    ])
  })

  test('agents are asked about only once there is a machine to sign in on', () => {
    expect(ids({ hasMachine: false, hasSignedInAgent: false })).toEqual(['machine'])
    expect(ids({ hasSignedInAgent: false })).toEqual(['agents'])
  })

  test('a project waits for GitHub, since the project stage lists GitHub repositories', () => {
    expect(ids({ githubConnected: false, hasProject: false })).toEqual(['github'])
    expect(ids({ hasProject: false })).toEqual(['project'])
  })

  test('a fact not answered yet is not shown as open, so no row appears and then vanishes', () => {
    expect(ids({ hasSignedInAgent: null, githubConnected: null, hasProject: null })).toEqual([])
    expect(ids({ hasProject: null })).toEqual([])
  })
})
