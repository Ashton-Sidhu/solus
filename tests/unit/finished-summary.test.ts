import { describe, expect, test } from 'bun:test'
import { finishedSummary } from '../../packages/server/src/attention/finished-summary'
import { payloadForAttentionEntry } from '@solus/contracts/notification-types'

describe('completion toast context', () => {
  test('identifies the session using its displayed name', () => {
    const summary = finishedSummary({ customTitle: 'Fix login', slug: 'old-name', firstMessage: 'Help' })
    const payload = payloadForAttentionEntry({ sessionId: 's1', kind: 'finished', since: 1, summary })
    expect(payload.title).toBe('Turn finished')
    expect(payload.body).toBe('Fix login')
  })

  test('falls back to the slug, prompt, project, then a neutral message', () => {
    expect(finishedSummary({ customTitle: ' ', slug: 'Login fix', firstMessage: 'Help' })).toBe('Login fix')
    expect(finishedSummary({ slug: null, firstMessage: 'Fix\n the login' })).toBe('Fix the login')
    expect(finishedSummary(null, '/work/solus/')).toBe('solus')
    expect(finishedSummary(null)).toBe('Your session has finished.')
  })

  test('bounds long prompts and retains remote host context', () => {
    const summary = finishedSummary({ slug: null, firstMessage: 'word '.repeat(100) })
    expect(summary.length).toBeLessThanOrEqual(160)
    expect(summary.endsWith('…')).toBe(true)
    const payload = payloadForAttentionEntry(
      { sessionId: 's1', kind: 'finished', since: 1, summary },
      { hostLabel: 'Build machine' },
    )
    expect(payload.body).toBe(`${summary} on Build machine`)
  })
})
