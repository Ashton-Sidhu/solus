import { hostPathBaseName, isInsideHostPath } from '@solus/contracts/host-path'
import { EDITOR_IDS, type DetectedEditor, type EditorId } from '@solus/contracts/types'

export type OpenInTarget = EditorId | 'terminal'

export function parseOpenInTarget(value: string | null): OpenInTarget | null {
  if (value === 'terminal') return value
  return EDITOR_IDS.find((id) => id === value) ?? null
}

/** A removed app must never leave the primary action pointing at a stale choice. */
export function openInTarget(
  chosen: OpenInTarget | null,
  defaultEditor: EditorId | null,
  editors: readonly DetectedEditor[],
): OpenInTarget {
  if (chosen === 'terminal') return chosen
  const installed = editors.find((editor) => editor.id === chosen)
  if (installed) return installed.id
  return editors.find((editor) => editor.id === defaultEditor)?.id ?? 'terminal'
}

/**
 * The editors that open each folder they are given in one window (`zed a b`,
 * `code a b`, `subl a b`). A JetBrains IDE opens each folder as its own
 * project, and an editor in a terminal opens a folder as a buffer, so those
 * get one folder.
 */
const MANY_FOLDER_EDITOR_IDS = ['vscode', 'cursor', 'zed', 'sublime'] as const satisfies readonly EditorId[]

export interface EditorFolders {
  /** The folders that the editor opens: the working folder first. */
  paths: string[]
  /** The folders of the session that the editor does not open: its menu in the folders menu opens each one. */
  leftOut: number
}

/**
 * The folders that "Open in" gives an editor: the working folder, then each
 * other folder of the session that is not inside it. A container and a task
 * folder hold their repositories, so they open as one folder. A link to a
 * remote host names one folder, and some editors open one folder in a window:
 * those get the working folder only.
 */
export function editorFolders(input: {
  workingFolder: string
  otherFolders: readonly string[]
  editorId: EditorId
  isRemote: boolean
}): EditorFolders {
  const paths = [input.workingFolder]
  for (const path of input.otherFolders) {
    if (!paths.some((each) => isInsideHostPath(each, path))) paths.push(path)
  }
  const opensMany = !input.isRemote && MANY_FOLDER_EDITOR_IDS.some((id) => id === input.editorId)
  return opensMany ? { paths, leftOut: 0 } : { paths: [input.workingFolder], leftOut: paths.length - 1 }
}

/** One line for the "Open in" row: which folders it opens, and why it leaves some out. Undefined for one folder. */
export function editorFoldersTooltip(folders: EditorFolders, input: { editorName: string; isRemote: boolean }): string | undefined {
  const names = folders.paths.map(hostPathBaseName)
  if (folders.leftOut > 0) {
    const reason = input.isRemote ? 'a link to a different host opens one folder' : `${input.editorName} opens one folder in a window`
    return `Opens ${names[0]} only: ${reason}. The folders menu opens the others.`
  }
  return names.length > 1 ? `Opens ${names.join(', ')}` : undefined
}
