import { EventEmitter } from 'events'
import type { RunHandle } from './agent-backend'
import type { EnrichedError } from '../../shared/types'

/**
 * Shared run-tracking base for ClaudeBackend, CodexBackend, and MockAgentBackend.
 * Owns the three run maps and provides the common lifecycle helpers used by all backends.
 */
export class BaseAgentBackend<H extends RunHandle = RunHandle> extends EventEmitter {
  protected activeRuns = new Map<string, H>()
  protected pendingRuns: H[] = []
  protected finishedRuns = new Map<string, RunHandle>()

  cancelSession(sessionId: string): boolean {
    const handle = this.activeRuns.get(sessionId)
    if (!handle) return false
    handle.abortController.abort()
    return true
  }

  isSessionRunning(sessionId: string): boolean {
    return this.activeRuns.has(sessionId)
  }

  getSessionHandle(sessionId: string): RunHandle | undefined {
    return this.activeRuns.get(sessionId)
  }

  getPendingHandles(): RunHandle[] {
    return [...this.pendingRuns]
  }

  getEnrichedError(sessionId: string | null, exitCode: number | null): EnrichedError {
    const handle = (sessionId ? (this.activeRuns.get(sessionId) ?? this.finishedRuns.get(sessionId)) : undefined)
      ?? this.pendingRuns[0]
    return {
      message: this._errorMessage(exitCode),
      stderrTail: [],
      stdoutTail: [],
      exitCode,
      elapsedMs: handle ? Date.now() - handle.startedAt : 0,
      toolCallCount: handle?.toolCallCount || 0,
      sawPermissionRequest: handle?.sawPermissionRequest || false,
      permissionDenials: handle?.permissionDenials || [],
    }
  }

  protected _errorMessage(exitCode: number | null): string {
    return `Run failed with exit code ${exitCode}`
  }

  protected promoteToActive(handle: H, sessionId: string): void {
    handle.sessionId = sessionId
    const idx = this.pendingRuns.indexOf(handle)
    if (idx !== -1) this.pendingRuns.splice(idx, 1)
    this.activeRuns.set(sessionId, handle)
  }

  protected finishRun(handle: H): void {
    const sessionId = handle.sessionId
    if (sessionId) {
      this.finishedRuns.set(sessionId, handle)
      this.activeRuns.delete(sessionId)
      setTimeout(() => this.finishedRuns.delete(sessionId!), 5000)
    } else {
      const idx = this.pendingRuns.indexOf(handle)
      if (idx !== -1) this.pendingRuns.splice(idx, 1)
    }
  }
}
