import { describe, expect, test } from 'bun:test'
import type { AppCallDetail } from '@solus/contracts/apps'
import { callAttributes } from '@solus/workspace-ui/components/app/manage/lib/activity'

const failedCall = {
  id: 'call-1',
  operation: 'analyze',
  outcome: 'failed',
  caller: { kind: 'ui' },
  startedAt: Date.UTC(2026, 10, 13, 14, 2, 31),
  durationMs: 1250,
  version: 3,
  resultBytes: null,
  traceId: 'trace-1',
  runId: null,
} as AppCallDetail

describe('the fields of a call in the Activity section', () => {
  test('a failed call reads as a failure, and its ids are copyable machine text', () => {
    const [outcome, identity] = callAttributes(failedCall, [])

    expect(outcome.attributes.find((attribute) => attribute.key === 'outcome')?.tone).toBe('failure')
    expect(outcome.attributes.find((attribute) => attribute.key === 'duration_ms')).toMatchObject({ value: '1.3s', copyValue: '1250' })
    expect(identity.attributes.filter((attribute) => attribute.mono).map((attribute) => attribute.key)).toEqual(['call_id', 'trace_id'])
  })

  test('the operation and the caller read as words, not code', () => {
    const [, identity] = callAttributes(failedCall, [])

    const operation = identity.attributes.find((attribute) => attribute.key === 'operation')
    expect(operation?.value).toBe('analyze')
    expect(operation?.mono).toBeUndefined()
    expect(identity.attributes.find((attribute) => attribute.key === 'caller')?.value).toBe('The UI')
  })
})
