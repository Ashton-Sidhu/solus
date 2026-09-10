import { expect, test } from 'bun:test'
import { RemoteUpdateService } from '@solus/server/updates/remote-update-service'
import type { HostUpdateStatus } from '@solus/contracts/host-update-types'
import type { ServerUpdateSupport, SupervisorMessage } from '@solus/contracts/server-update'

function fixture() {
  let work = true
  let blocked = false
  let support: ServerUpdateSupport = { supported: true, reason: null, operation: null }
  const messages: SupervisorMessage[] = []
  const status: HostUpdateStatus = { currentVersion: '1.0.0', install: 'managed', remediation: null, releaseUrl: null, providers: [], check: { kind: 'available', latestVersion: '1.1.0', checkedAt: 0 } }
  const service = new RemoteUpdateService({ status: () => status, publish: (value) => { support = value },
    blockNewTurns: (value) => { blocked = value }, hasWork: () => work, send: (message) => { messages.push(message) },
  }, support)
  return { service, messages, get support() { return support }, get blocked() { return blocked }, idle: () => { work = false } }
}

test('two clients share one operation and existing work must finish before installing', async () => {
  const f = fixture()
  try {
    f.service.install()
    await Promise.resolve()
    const operationId = f.support.operation!.operationId
    f.service.install()
    f.service.advance()
    expect(f.support.operation!.operationId).toBe(operationId)
    expect(f.blocked).toBe(false)
    expect(f.messages).toHaveLength(1)
    f.service.apply({ ...f.support, operation: { ...f.support.operation!, phase: 'waiting' } })
    expect(f.blocked).toBe(true)
    f.idle()
    f.service.advance()
    f.service.advance()
    expect(f.messages).toHaveLength(2)
    expect(f.support.operation?.phase).toBe('restarting')
    expect(() => f.service.cancel()).toThrow('only be cancelled')
  } finally { f.service.stop() }
})

test('cancel and installer failure reopen turn admission', async () => {
  const f = fixture()
  try {
    f.service.install()
    await Promise.resolve()
    f.service.apply({ ...f.support, operation: { ...f.support.operation!, phase: 'waiting' } })
    f.service.cancel()
    expect(f.blocked).toBe(false)
    expect(f.support.operation?.phase).toBe('cancelled')
    f.service.install()
    f.service.apply({ ...f.support, operation: { ...f.support.operation!, phase: 'failed', message: 'Network unavailable' } })
    expect(f.blocked).toBe(false)
    expect(f.service.canStop(f.support.operation!.operationId)).toBe(false)
  } finally { f.service.stop() }
})

test('shutdown requires the matching operation and an idle host', () => {
  const f = fixture()
  try {
    f.service.install()
    f.service.apply({ ...f.support, operation: { ...f.support.operation!, phase: 'restarting' } })
    const operationId = f.support.operation!.operationId
    expect(f.service.canStop(operationId)).toBe(false)
    f.idle()
    expect(f.service.canStop('old-request')).toBe(false)
    expect(f.service.canStop(operationId)).toBe(true)
  } finally { f.service.stop() }
})


test('a completed download automatically drains an idle host without another client request', async () => {
  let resolveDrained!: () => void
  const drained = new Promise<void>((resolve) => { resolveDrained = resolve })
  let support: ServerUpdateSupport = { supported: true, reason: null, operation: null }
  const status: HostUpdateStatus = { currentVersion: '1.0.0', install: 'managed', remediation: null, releaseUrl: null, providers: [], check: { kind: 'available', latestVersion: '1.1.0', checkedAt: 0 } }
  const service = new RemoteUpdateService({ status: () => status, publish: value => { support = value }, blockNewTurns: () => {}, hasWork: () => false,
    send: message => { if (message.type === 'solus:drained') resolveDrained() },
  }, support)
  try {
    service.install()
    await Promise.resolve()
    service.apply({ ...support, operation: { ...support.operation!, phase: 'waiting' } })
    await drained
    expect(support.operation?.phase).toBe('restarting')
  } finally { service.stop() }
})
