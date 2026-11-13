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
