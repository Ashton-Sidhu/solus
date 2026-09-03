import type { CodeIntelStatus } from '@solus/contracts/code-intel'
import type { ProgressToast } from '../../../lib/toasts'

type ProgressToastFactory = (message: string) => ProgressToast

/** Keeps one toast alive for each host/root/language index run, then changes
 *  that same toast into its terminal result. */
export class CodeIntelIndexToastTracker {
  private readonly active = new Map<string, ProgressToast>()

  constructor(private readonly progress: ProgressToastFactory) {}

  update(serverId: string, status: CodeIntelStatus): void {
    if (!status.root) return
    for (const language of status.languages) {
      const key = `${serverId}|${status.root}|${language.language}`
      const current = this.active.get(key)
      if (language.state === 'indexing') {
        if (!current) this.active.set(key, this.progress(`Indexing ${language.label} symbols…`))
        continue
      }
      if (!current) continue
      this.active.delete(key)
      if (language.state === 'ready') {
        current.success(`${language.label} symbols are ready`)
      } else if ((language.state === 'error' || language.state === 'stale') && language.error) {
        current.error(`Couldn’t index ${language.label} symbols`, { description: language.error })
      } else {
        current.dismiss()
      }
    }
  }
}
