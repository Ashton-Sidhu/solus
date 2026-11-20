import { expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { processFact, runningServer } from './running-server-fixtures'
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { isolatedJob, stopJob } = await import('@solus/server/host/running-servers/stop-job')
const { notifyCommandStop, watchCommandStops } = await import('@solus/server/host/running-servers/command-stops')
const table = () => new Map([processFact(123), processFact(124, { groupId: 123, parentPid: 123 })].map((fact) => [fact.pid, fact]))

test('stop refuses a group that also holds a provider, host, terminal shell, or another session', () => {
  for (const fields of [{ protected: true }, { sessionId: 'another-session' }, { terminalId: 'another-terminal' }]) {
    const facts = table()
    Object.assign(facts.get(124)!, fields)
    expect(isolatedJob(facts, 123)).toBeNull()
  }
})

test('stop refuses a replaced PID before any signal or provider notice', async () => {
  const signal = mock(async () => {})
  const beforeStop = mock(() => {})
  const result = await stopJob(runningServer(), 'old-start', { processes: async () => table(), signal, beforeStop, wait: async () => {} })
  expect(result).toEqual({ status: 'refused', reason: 'identity-changed' })
  expect(signal).not.toHaveBeenCalled()
  expect(beforeStop).not.toHaveBeenCalled()
})

test('stop waits for all original job members and never reports success just because TERM was sent', async () => {
  let facts = table()
  const order: string[] = []
  const signal = mock(async (pid: number, kind: string) => { order.push(kind); expect(pid).toBe(-123); facts.delete(123) })
  const wait = mock(async () => { facts.clear() })
  expect(await stopJob(runningServer(), 'started-123', { processes: async () => facts, signal, beforeStop: () => { order.push('notice') }, wait })).toEqual({ status: 'stopped' })
  expect(order).toEqual(['notice', 'SIGTERM'])
  expect(wait).toHaveBeenCalledTimes(1)
})

test('a job that ignores TERM receives KILL only while every member still has its original identity', async () => {
  let facts = table()
  const signal = mock(async (_pid: number, kind: string) => { if (kind === 'SIGKILL') facts = new Map() })
  expect(await stopJob(runningServer(), 'started-123', { processes: async () => facts, signal, beforeStop: () => {}, wait: async () => {} })).toEqual({ status: 'stopped' })
  expect(signal.mock.calls).toEqual([[-123, 'SIGTERM'], [-123, 'SIGKILL']])
})

test('a reused group member prevents escalation', async () => {
  let facts = table()
  const signal = mock(async () => { facts = new Map([[124, processFact(124, { groupId: 123, identity: 'new-start' })]]) })
  expect(await stopJob(runningServer(), 'started-123', { processes: async () => facts, signal, beforeStop: () => {}, wait: async () => {} })).toEqual({ status: 'refused', reason: 'identity-changed' })
  expect(signal).toHaveBeenCalledTimes(1)
})

test('failed signalling undoes the provider notice', async () => {
  const undo = mock(() => {})
  const signal = async () => { throw new Error('EPERM') }
  await expect(stopJob(runningServer(), 'started-123', { processes: async () => table(), signal, beforeStop: () => undo, wait: async () => {} })).rejects.toThrow('EPERM')
  expect(undo).toHaveBeenCalledTimes(1)
})

test('only an exact command ID introduced at the job leader is marked user-stopped', () => {
  const noticed: string[] = []
  const rollback = mock(() => {})
  const unwatch = watchCommandStops((commandId) => { noticed.push(commandId); return rollback })
  try {
    const parent = processFact(10, { commandId: null })
    const leader = processFact(123, { commandId: 'tool-call-123' })
    const facts = new Map([[10, parent], [123, leader]])
    notifyCommandStop([leader], facts)()
    expect(noticed).toEqual(['tool-call-123'])
    expect(rollback).toHaveBeenCalledTimes(1)
    parent.commandId = leader.commandId
    notifyCommandStop([leader], facts)
    expect(noticed).toHaveLength(1)
    parent.commandId = null
    parent.tagsRead = false
    notifyCommandStop([leader], facts)
    expect(noticed).toHaveLength(1)
  } finally { unwatch() }
})
