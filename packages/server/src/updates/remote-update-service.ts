import { randomUUID } from 'node:crypto'
import { isServerUpdateActive, type ServerUpdateSupport, type SupervisorMessage } from '@solus/contracts/server-update'
import type { HostUpdateStatus } from '@solus/contracts/host-update-types'

interface RemoteUpdateDeps {
  status(): HostUpdateStatus
  publish(support: ServerUpdateSupport): void
  blockNewTurns(blocked: boolean): void
  hasWork(): boolean
  send(message: SupervisorMessage): void
}

/** Owns admission while the CLI parent owns installation and process lifetime. */
export class RemoteUpdateService {
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(private readonly deps: RemoteUpdateDeps, private support: ServerUpdateSupport) {
    deps.blockNewTurns(support.operation?.phase === 'waiting' || support.operation?.phase === 'restarting')
    deps.publish(support)
  }

  install(): void {
    if (!this.support.supported) throw new Error(this.support.reason ?? 'Remote updates are not supported by this host.')
    if (isServerUpdateActive(this.support.operation)) return
    const check = this.deps.status().check
    if (check.kind !== 'available') throw new Error('Check for an available server update first.')
    this.deps.blockNewTurns(false)
    this.support = { ...this.support, operation: { operationId: randomUUID(), version: check.latestVersion, phase: 'downloading' } }
    this.deps.publish(this.support)
    // Return the RPC acknowledgement before installation can disconnect clients.
    queueMicrotask(() => {
      try { this.deps.send({ type: 'solus:update', operation: this.support.operation! }) }
      catch (error) { this.apply({ ...this.support, operation: { ...this.support.operation!, phase: 'failed', message: String(error) } }) }
    })
  }

  advance(): void {
    if (this.support.operation?.phase !== 'waiting' || this.deps.hasWork()) return
    this.stopTimer()
    this.support = { ...this.support, operation: { ...this.support.operation, phase: 'restarting' } }
    this.deps.publish(this.support)
    try { this.deps.send({ type: 'solus:drained', operationId: this.support.operation!.operationId }) }
    catch (error) {
      this.apply({ ...this.support, operation: { ...this.support.operation!, phase: 'failed', message: error instanceof Error ? error.message : String(error) } })
    }
  }

  cancel(): void {
    if (this.support.operation?.phase !== 'waiting') throw new Error('An update can only be cancelled while waiting for active work.')
    this.stopTimer()
    this.deps.send({ type: 'solus:cancel-update', operationId: this.support.operation.operationId })
    this.apply({ ...this.support, operation: { ...this.support.operation, phase: 'cancelled' } })
  }

  apply(support: ServerUpdateSupport): void {
    if (isServerUpdateActive(this.support.operation) && support.operation?.operationId !== this.support.operation?.operationId) return
    this.support = support
    this.deps.blockNewTurns(support.operation?.phase === 'waiting' || support.operation?.phase === 'restarting')
    this.deps.publish(support)
    if (support.operation?.phase === 'waiting' && !this.timer) {
      this.timer = setInterval(() => this.advance(), 250)
      this.timer.unref?.()
    }
  }

  canStop(operationId: string): boolean {
    return this.support.operation?.operationId === operationId && this.support.operation.phase === 'restarting' && !this.deps.hasWork()
  }

  stop(): void { this.stopTimer() }
  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = null }
}
