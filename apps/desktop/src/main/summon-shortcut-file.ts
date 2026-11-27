import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type { AppGlobalShortcuts } from '@solus/contracts/types'

/**
 * The global shortcut that summons Solus, kept as plain JSON in the desktop
 * app's data folder. The file keeps its old name, so a person's shortcut
 * stays after an update. The app shortcut records have their own file
 * (`app-shortcut-records.ts`).
 */
export const SUMMON_SHORTCUT_FILE = 'app-shortcuts.json'

const comboSchema = z.object({
  code: z.string(),
  alt: z.boolean().optional(),
  mod: z.boolean().optional(),
  shift: z.boolean().optional(),
  ctrl: z.boolean().optional(),
  meta: z.boolean().optional(),
})

const fileSchema = z.object({
  toggle: comboSchema,
})

/** The saved shortcut, or `fallback` when there is none or the file has another form. */
export function loadSummonShortcut(userDataDirectory: string, fallback: AppGlobalShortcuts): AppGlobalShortcuts {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(join(userDataDirectory, SUMMON_SHORTCUT_FILE), 'utf-8')))
    if (parsed.success) return parsed.data
  } catch {}
  return fallback
}

export function saveSummonShortcut(userDataDirectory: string, shortcuts: AppGlobalShortcuts): void {
  writeFileSync(join(userDataDirectory, SUMMON_SHORTCUT_FILE), JSON.stringify(shortcuts, null, 2), { mode: 0o600 })
}
