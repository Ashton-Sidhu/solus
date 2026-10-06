import { tick } from 'svelte'
import { uuid } from '@solus/contracts/uuid'
import type { TaskOpenTiming } from '@solus/contracts/task-types'

/** One bounded report per activation. No RPC runs on the navigation path. */
export class TaskOpenTrace {
  private readonly startedAt = performance.now()
  private readonly activationId = uuid()
  private readonly marks: TaskOpenTiming['marks'] = []
  private shownFrame: Promise<void> | undefined

  constructor(
    private readonly taskId: string | null,
    private readonly report: (timing: TaskOpenTiming) => Promise<void>,
  ) {
    this.mark('activated')
  }

  mark(stage: string): void {
    this.marks.push({ stage, elapsedMs: Math.round((performance.now() - this.startedAt) * 10) / 10 })
  }

  shown(): void {
    if (this.shownFrame) return
    this.mark('destination_selected')
    this.shownFrame = this.afterFrame('destination_frame')
  }

  private async afterFrame(stage: string): Promise<void> {
    await tick()
    // The second callback follows a paint opportunity. It does not establish
    // that content (including separately loaded task details) finished painting.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    this.mark(stage)
  }

  async finish(outcome: TaskOpenTiming['outcome']): Promise<void> {
    this.mark(`navigation_${outcome}`)
    await Promise.all([this.shownFrame, this.afterFrame('settled_frame')])
    const timing: TaskOpenTiming = { activationId: this.activationId, taskId: this.taskId, outcome, marks: this.marks }
    // Keep the report available on clients connected to a host that predates
    // this RPC. Diagnostic delivery must never break navigation.
    console.info('task_sidebar_open_timing', timing)
    try { await this.report(timing) } catch { /* Older or disconnected host. */ }
  }
}
