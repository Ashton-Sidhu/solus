import { SvelteSet } from 'svelte/reactivity'
import { z } from 'zod'

/** View state of this client only, like the width of a pane: not synced. */
export const CLOSED_FOLDERS_STORAGE_KEY = 'solus.sidebar.closed-project-folders'

const closedFoldersSchema = z.array(z.string())

/**
 * Which project folders the person closed in the sidebar's project view, by
 * project key. A folder is open until it is closed, so a new project shows its
 * sessions. Kept across reloads.
 */
export class SidebarFolderState {
  private readonly closedKeys: SvelteSet<string>

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.closedKeys = new SvelteSet(readClosedKeys(storage))
  }

  isOpen(folderKey: string): boolean {
    return !this.closedKeys.has(folderKey)
  }

  setOpen(folderKey: string, isOpen: boolean): void {
    if (isOpen === this.isOpen(folderKey)) return
    if (isOpen) this.closedKeys.delete(folderKey)
    else this.closedKeys.add(folderKey)
    try {
      this.storage?.setItem(CLOSED_FOLDERS_STORAGE_KEY, JSON.stringify([...this.closedKeys]))
    } catch {
      // A full or blocked storage loses only the saved state; the folder still moves.
    }
  }

  toggle(folderKey: string): void {
    this.setOpen(folderKey, !this.isOpen(folderKey))
  }
}

function readClosedKeys(storage: Pick<Storage, 'getItem'> | null): string[] {
  try {
    const raw = storage?.getItem(CLOSED_FOLDERS_STORAGE_KEY)
    if (!raw) return []
    const parsed = closedFoldersSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}
