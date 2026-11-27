import { describe, expect, test } from 'bun:test'
import type { AppCallDetail } from '@solus/contracts/apps'
import { callFieldGroups, fieldGroupsMatching } from '@solus/workspace-ui/components/app/manage/lib/call-sheet'

const failedCall = {
  id: 'call-1',
  kind: 'operation',
  operation: 'analyze',
  outcome: 'failed',
  caller: { kind: 'ui' },
  startedAt: Date.UTC(2026, 10, 13, 14, 2, 31),
  durationMs: 1250,
  version: 3,
  resultBytes: null,
  traceId: 'trace-1',
  runId: null,
  input: JSON.stringify({ repo: 'sveltejs/kit', options: { deep: true } }),
  inputTruncated: false,
} as AppCallDetail

describe('the fields of a call in the call sheet', () => {
  test('a field the query knows filters for its value and out of it; ids are copyable machine text', () => {
    // WHY: filter for and filter out add the field's term to the query. A term with the shown
    // word instead of the value the host matches ("The UI" for `ui`) would find no call.
    const [call] = callFieldGroups(failedCall, [])
    const byKey = new Map(call.fields.map((field) => [field.key, field]))
    expect(byKey.get('caller')).toMatchObject({ value: 'The UI', term: { field: 'caller', value: 'ui' }, column: 'caller' })
    expect(byKey.get('outcome')?.term).toEqual({ field: 'outcome', value: 'failed' })
    expect(byKey.get('duration')).toMatchObject({ value: '1.3s', copyValue: '1250', term: null })
    expect(call.fields.filter((field) => field.mono).map((field) => field.key)).toEqual(['trace.id', 'call.id'])
  })

  test('the input shows its flat values as fields, and Find a field narrows every group', () => {
    const groups = callFieldGroups(failedCall, [])
    expect(groups.map((group) => group.label)).toEqual(['Call', 'Input'])
    expect(groups[1].fields.map((field) => field.key)).toEqual(['input.repo'])
    expect(fieldGroupsMatching(groups, 'kit').map((group) => [group.label, group.fields.map((field) => field.key)])).toEqual([['Input', ['input.repo']]])
  })
})
