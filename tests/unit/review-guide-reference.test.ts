import { describe, expect, test } from 'bun:test'
import type { ReviewTarget } from '@solus/contracts/review'
import type { Message } from '@solus/contracts/types'
import {
  runningReviewGuideReference,
} from '@solus/workspace-ui/components/review/lib/review-guide-reference'

describe('running review-guide reference', () => {
  test.each([
    [{ kind: 'working-tree' }, 'working-tree-main'],
    [{ kind: 'session' }, 'session-session-1'],
    [{ kind: 'branch', targetBranch: 'main' }, 'main'],
    [{ kind: 'pr', host: 'github.com', owner: 'acme', repo: 'app', number: 42 }, 'pr-github.com-acme-app-42'],
  ] as Array<[ReviewTarget, string]>)('derives and settles the %s skeleton from the request tool row', (target, key) => {
    const tools = [{
      id: 'review-1',
      role: 'tool',
      content: '',
      timestamp: 1,
      toolName: 'request_review_guide',
      toolInput: JSON.stringify({ target }),
      toolStatus: 'running',
    }] as Message[]

    // WHY: provider tool input is already rendered in the activity row. Using
    // that same row keeps the skeleton independent of synthetic event order.
    expect(runningReviewGuideReference(tools, 'main', 'session-1')).toEqual({
      target,
      key,
    })

    tools[0].toolStatus = 'completed'
    expect(runningReviewGuideReference(tools, 'main', 'session-1')).toBeNull()
  })
})
