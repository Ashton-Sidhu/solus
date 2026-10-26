import { describe, expect, test } from 'bun:test'
import { CALLOUT_KINDS, calloutKind } from '@solus/document-model/callout'
import { nextCalloutKind } from '../../packages/workspace-ui/src/components/editor/calloutView'

// Plan: docs/plans/unified-prose.md, step 2.5. The callout's label is the one
// control that changes its kind, so stepping through it must reach every kind
// and come back to the first.

describe('the editor callout', () => {
  test('the label reaches every kind and wraps around', () => {
    const seen: string[] = []
    let kind = calloutKind('note')
    for (let step = 0; step < CALLOUT_KINDS.length; step += 1) {
      seen.push(kind)
      kind = nextCalloutKind(kind)
    }
    expect(seen).toEqual([...CALLOUT_KINDS])
    expect(kind).toBe('note')
  })

  test('an unknown kind reads as a note', () => {
    // WHY: a hand-written file may name a kind GitHub does not have. The
    // callout must still open, not drop its content.
    expect(calloutKind('danger')).toBe('note')
    expect(calloutKind('WARNING')).toBe('warning')
  })
})
