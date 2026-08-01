/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from 'bun:test'
import { captureBridgedLogEvent } from '../../src/main/analytics'
import { createLogger, setLogEventSink } from '../../src/main/logger'

afterEach(() => {
  setLogEventSink(null)
})

describe('analytics log event bridge', () => {
  test('does not capture non-allowlisted events', () => {
    const captured: string[] = []

    captureBridgedLogEvent('session_started', (event) => captured.push(event))

    expect(captured).toEqual([])
  })

  test('captures allowlisted event names without properties', () => {
    const captured: Array<{ event: string; props: object }> = []

    captureBridgedLogEvent('worktree_created', (event, props) => captured.push({ event, props }))

    expect(captured).toEqual([{ event: 'worktree_created', props: {} }])
  })

  test('does not let sink errors escape logging', () => {
    setLogEventSink(() => { throw new Error('analytics unavailable') })

    expect(() => createLogger('test', 'analytics-bridge.test.ts').info('worktree_created')).not.toThrow()
  })
})
