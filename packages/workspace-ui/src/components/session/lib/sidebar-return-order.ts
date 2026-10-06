import { isInWorkingSection, type SidebarTask } from './task-list'

/**
 * When each row came back to the user, as this client saw it: the moment a row
 * left the Working section. Only a seen change of status stamps a row, so
 * opening a session or loading its transcript never moves it. The first
 * observation only takes a baseline, so mounting or reloading never reshuffles
 * the list; until a row returns, it keeps its creation order.
 *
 * Not reactive on purpose: the store observes inside the derived pass that
 * rebuilds the rows, and every status change already rebuilds that pass.
 */
export class SidebarReturnOrder {
  private returnedAtByRowId = new Map<string, number>()
  private workingRowIds: Set<string> | null = null

  observe(rows: readonly SidebarTask[], now: number): void {
    const working = new Set<string>()
    const present = new Set<string>()
    for (const row of rows) {
      present.add(row.id)
      if (isInWorkingSection(row)) working.add(row.id)
    }
    // A row that left the column forgets its stamp, so the map stays bounded.
    for (const rowId of this.returnedAtByRowId.keys()) {
      if (!present.has(rowId)) this.returnedAtByRowId.delete(rowId)
    }
    for (const rowId of this.workingRowIds ?? []) {
      if (present.has(rowId) && !working.has(rowId)) this.returnedAtByRowId.set(rowId, now)
    }
    this.workingRowIds = working
  }

  returnedAt(row: SidebarTask): number {
    return Math.max(row.createdAt, this.returnedAtByRowId.get(row.id) ?? 0)
  }
}
