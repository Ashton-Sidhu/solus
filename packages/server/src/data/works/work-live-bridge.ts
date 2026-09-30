import type { Attribution } from '@solus/contracts/user'

/**
 * What a work's live doc must know when its body is read or written outside it
 * (docs/plans/work-review-and-live-editing.md, phase 3b). The live manager
 * installs it at boot; the data layer calls it and never imports the manager.
 */
export interface WorkLiveBridge {
  /** Write the live doc's edits to `works.content` if some are not there yet,
   *  so a read, and a version check, see what people typed. */
  flush(workId: string): Promise<void>
  /**
   * Run a body write that did not come from the live doc: hold the work (the
   * agent edit lock) while its version is checked and it writes, then fold the
   * written body into the live doc as a structural change. A work nobody has
   * edited live just runs the write. `run` answers the body after the write.
   */
  write(workId: string, by: Attribution | null, run: () => Promise<string>): Promise<void>
}

let installed: WorkLiveBridge | null = null

export function installWorkLiveBridge(bridge: WorkLiveBridge): () => void {
  installed = bridge
  return () => { if (installed === bridge) installed = null }
}

export function workLiveBridge(): WorkLiveBridge | null {
  return installed
}
