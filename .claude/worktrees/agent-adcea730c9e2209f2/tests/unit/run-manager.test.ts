import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { stopProcessGroup } from '../../src/main/run/process-group'

afterEach(() => {
  mock.restore()
})

describe('dev-server process group shutdown', () => {
  test('force-kills the detached process group when the app cannot wait for escalation', () => {
    const signals: Array<[number, NodeJS.Signals | number]> = []
    spyOn(process, 'kill').mockImplementation((pid, signal) => {
      signals.push([pid, signal ?? 0])
      return true
    })
    stopProcessGroup(42, true)

    expect(signals).toEqual([[-42, 'SIGTERM'], [-42, 'SIGKILL']])
  })
})
