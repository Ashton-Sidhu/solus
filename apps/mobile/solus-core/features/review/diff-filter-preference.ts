import { parseChangeKinds, type ChangeKind } from '@solus/client-core/change-breakdown'
import { Listeners } from '../../lib/listeners'
import type { KeyValueStore } from '../../platform/ports'

const KEY = 'solus-diff-kind'

/** One saved classification filter for every diff opened on this device. */
export class DiffFilterPreference {
  readonly changes = new Listeners()

  private selected: ChangeKind[] | null

  constructor(private readonly storage: KeyValueStore) {
    this.selected = parseChangeKinds(storage.getItem(KEY))
  }

  current = (): ChangeKind[] | null => this.selected

  set(kinds: ChangeKind[] | null): void {
    this.selected = kinds
    this.storage.setItem(KEY, JSON.stringify(kinds))
    this.changes.notify()
  }
}
