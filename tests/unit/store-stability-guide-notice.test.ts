import { describe, expect, mock, spyOn, test } from 'bun:test'
import type { ReactElement } from 'react'
import type { GuideNotice } from '../../apps/mobile/src/features/prs/lib/pull-request-guide-state'

// The card's native parts cannot load in Bun; the card is called as a plain
// function, so only their names are needed.
mock.module('react-native', () => ({ Pressable: 'Pressable', View: 'View' }))
mock.module('../../apps/mobile/src/components/AppSymbol', () => ({ SymbolView: 'SymbolView' }))
mock.module('../../apps/mobile/src/components/AppText', () => ({ AppText: 'Text' }))

const { GuideNoticeCard } = await import('../../apps/mobile/src/features/prs/detail/GuideNoticeCard')

const notice = (kind: GuideNotice['kind']): GuideNotice => ({ kind, title: kind, description: '', action: 'Write guide' })
const props = { compact: false, canWrite: true, onWrite: () => {}, onReload: () => {} }

describe('guide notice card', () => {
  test('the card calls no hook in any state, so a guide that becomes ready or stops being ready keeps the hook order', () => {
    // WHY: the card returned early for a ready guide before its `useState`.
    // React then throws when the same card renders a ready guide and then a
    // failed one ("Rendered more hooks than during the previous render").
    // Outside a render, any hook call throws here, so these calls prove the
    // card itself has no hooks in either branch.
    const transitions: GuideNotice['kind'][] = ['loading', 'ready', 'writing', 'ready', 'failed', 'stale', 'ready', 'empty', 'unavailable']
    for (const kind of transitions) {
      const element = GuideNoticeCard({ ...props, notice: notice(kind) }) as ReactElement<{ notice: GuideNotice }> | null
      if (kind === 'ready') expect(element).toBeNull()
      else expect(element?.props.notice.kind).toBe(kind)
    }
  })

  test('the details toggle state lives in the body that a non-ready guide mounts', () => {
    const element = GuideNoticeCard({ ...props, notice: { ...notice('failed'), details: 'stack' } }) as ReactElement<{ notice: GuideNotice }>
    const body = element.type as (bodyProps: typeof element.props) => unknown
    // The same check that passes for the card fails for the body: it holds `useState`.
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    expect(() => body(element.props)).toThrow()
    quiet.mockRestore()
  })
})
