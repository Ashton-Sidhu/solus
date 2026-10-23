import { describe, expect, test } from 'bun:test'
import { connectsInOneLine, type IntegrationConnectFacts } from '@solus/workspace-ui/components/connections/lib/connect-card-layout'

/**
 * A connect card whose only task is Connect is one line: the button sits on
 * the card line beside Not now. A body that held only that button left an
 * empty row with the button stranded at its right edge.
 */
const ready: IntegrationConnectFacts = { connectionsStatus: 'loaded', hasConnection: false, flow: null, needsClient: false }

describe('connect card layout', () => {
  test('Connect alone keeps the card to one line', () => {
    expect(connectsInOneLine(ready)).toBe(true)
  })

  test('anything more to show or do opens the body', () => {
    expect(connectsInOneLine({ ...ready, connectionsStatus: 'loading' })).toBe(false)
    expect(connectsInOneLine({ ...ready, connectionsStatus: 'error' })).toBe(false)
    expect(connectsInOneLine({ ...ready, hasConnection: true })).toBe(false)
    expect(connectsInOneLine({ ...ready, flow: { kind: 'starting' } })).toBe(false)
    expect(connectsInOneLine({ ...ready, flow: { kind: 'failed', message: 'Denied' } })).toBe(false)
    expect(connectsInOneLine({ ...ready, needsClient: true })).toBe(false)
  })
})
