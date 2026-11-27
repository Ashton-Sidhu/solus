import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import { isSameAppShortcutTarget, type AppShortcutTarget, type AppShortcutView } from '@solus/contracts/app-shortcuts'
import { appShortcutId } from './launcher-files'

const boundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})
export type AppWindowBounds = z.infer<typeof boundsSchema>

/**
 * The format of the launchers this Solus writes. Change it with any change to
 * what a launcher holds (its `Info.plist`, its program, its entry): a launcher
 * of an older format is written again when its app opens.
 */
export const LAUNCHER_FORMAT = 1

const shortcutSchema = z.object({
  host: z.string(),
  appId: z.string(),
  name: z.string(),
  /** The launcher the operating system lists for the app. */
  launcherPath: z.string(),
  /** What the launcher's icon was drawn from. A record from before the key has none, so its launcher is written again once. */
  iconKey: z.string().default(''),
  /** The format of the launcher (`LAUNCHER_FORMAT`) when it was written. */
  launcherFormat: z.number().int().default(1),
})
export type AppShortcutRecord = z.infer<typeof shortcutSchema>

/** A record as the renderer's list names it. */
export function appShortcutView({ host, appId, name, iconKey, launcherFormat }: AppShortcutRecord): AppShortcutView {
  return { host, appId, name, iconKey, isOutdated: launcherFormat < LAUNCHER_FORMAT }
}

const fileSchema = z.object({
  version: z.literal(1),
  shortcuts: z.array(shortcutSchema),
  /** Where the person left each app window, by the app's shortcut id. An app window needs no shortcut. */
  windowBounds: z.record(z.string(), boundsSchema),
})
type AppShortcutFile = z.infer<typeof fileSchema>

/**
 * The app shortcuts and the app window places of this device
 * (docs/app-shortcuts.md §3): one JSON file in the desktop app's own data
 * folder. No host keeps them, because a launcher is a file of one computer.
 *
 * A file that cannot be read starts empty. Its launchers still open their
 * apps, because a link needs no record, and adding a shortcut again takes its
 * launcher back.
 */
export class AppShortcutRecords {
  private file: AppShortcutFile

  constructor(private readonly path: string) {
    this.file = this.read()
  }

  private read(): AppShortcutFile {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf-8')))
      if (parsed.success) return parsed.data
    } catch {}
    return { version: 1, shortcuts: [], windowBounds: {} }
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    // Written beside the file and renamed over it, so a crash never leaves half a file.
    const staging = `${this.path}.staging`
    writeFileSync(staging, JSON.stringify(this.file, null, 2), { mode: 0o600 })
    renameSync(staging, this.path)
  }

  list(): readonly AppShortcutRecord[] {
    return this.file.shortcuts
  }

  find(target: AppShortcutTarget): AppShortcutRecord | null {
    return this.file.shortcuts.find((shortcut) => isSameAppShortcutTarget(shortcut, target)) ?? null
  }

  save(record: AppShortcutRecord): void {
    this.file.shortcuts = [...this.file.shortcuts.filter((shortcut) => !isSameAppShortcutTarget(shortcut, record)), record]
    this.write()
  }

  remove(target: AppShortcutTarget): void {
    this.file.shortcuts = this.file.shortcuts.filter((shortcut) => !isSameAppShortcutTarget(shortcut, target))
    this.write()
  }

  windowBounds(target: AppShortcutTarget): AppWindowBounds | null {
    return this.file.windowBounds[appShortcutId(target)] ?? null
  }

  saveWindowBounds(target: AppShortcutTarget, bounds: AppWindowBounds): void {
    this.file.windowBounds[appShortcutId(target)] = bounds
    this.write()
  }
}
