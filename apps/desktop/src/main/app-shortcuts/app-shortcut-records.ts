import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { z } from 'zod'
import { isSameAppShortcutTarget, type AppShortcutTarget, type AppShortcutView } from '@solus/contracts/app-shortcuts'
import { appDesktopPermissionSchema, type AppDesktopGrant, type AppDesktopPermission } from '@solus/contracts/app-desktop'
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

const grantsSchema = z.object({
  host: z.string(),
  appId: z.string(),
  /** The app's name when the person last answered, for Settings when the app is not open. */
  name: z.string(),
  grants: z.partialRecord(appDesktopPermissionSchema, z.enum(['granted', 'denied'])),
})
export type AppGrantsRecord = z.infer<typeof grantsSchema>

const fileSchema = z.object({
  version: z.literal(1),
  shortcuts: z.array(shortcutSchema),
  /** Where the person left each app window, by the app's shortcut id. An app window needs no shortcut. */
  windowBounds: z.record(z.string(), boundsSchema),
  /** The person's answers for the desktop capabilities of each app (docs/plans/app-desktop-capabilities.md §2). */
  permissions: z.array(grantsSchema).default([]),
  /** Solus turned its login item on for an app that starts at login, so only Solus turns it off again. */
  loginItemForApps: z.boolean().default(false),
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
    return { version: 1, shortcuts: [], windowBounds: {}, permissions: [], loginItemForApps: false }
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

  /** Every app with an answer on this device. */
  grantsList(): readonly AppGrantsRecord[] {
    return this.file.permissions
  }

  grantOf(target: AppShortcutTarget, permission: AppDesktopPermission): AppDesktopGrant | null {
    return this.file.permissions.find((record) => isSameAppShortcutTarget(record, target))?.grants[permission] ?? null
  }

  /** Keeps one answer; null clears it, so the app asks again. An app with no answer left has no record. */
  setGrant(target: AppShortcutTarget, name: string, permission: AppDesktopPermission, grant: AppDesktopGrant | null): void {
    const before = this.file.permissions.find((record) => isSameAppShortcutTarget(record, target))
    const grants = { ...before?.grants }
    if (grant) grants[permission] = grant
    else delete grants[permission]
    const others = this.file.permissions.filter((record) => record !== before)
    const hasAnswers = Object.keys(grants).length > 0
    this.file.permissions = hasAnswers ? [...others, { host: target.host, appId: target.appId, name: name || before?.name || '', grants }] : others
    this.write()
  }

  /** A deleted app keeps no answer on this device. */
  forgetGrants(target: AppShortcutTarget): void {
    if (!this.file.permissions.some((record) => isSameAppShortcutTarget(record, target))) return
    this.file.permissions = this.file.permissions.filter((record) => !isSameAppShortcutTarget(record, target))
    this.write()
  }

  get loginItemForApps(): boolean {
    return this.file.loginItemForApps
  }

  set loginItemForApps(isOn: boolean) {
    if (this.file.loginItemForApps === isOn) return
    this.file.loginItemForApps = isOn
    this.write()
  }
}

/** The file of the app shortcut records in the desktop app's data folder. */
export const APP_SHORTCUT_RECORDS_FILE = 'app-shortcut-records.json'

/**
 * The file that the records shared with the summon shortcut before they had
 * their own (`summon-shortcut-file.ts` keeps it). Each save of one feature
 * destroyed the other's data.
 */
const SHARED_FILE = 'app-shortcuts.json'

/**
 * The records of this device, from the desktop app's data folder. Records in
 * the shared file of an older Solus move to their own file first, so the
 * person's shortcuts stay; a summon shortcut in that file stays there.
 */
export function openAppShortcutRecords(userDataDirectory: string): AppShortcutRecords {
  const path = join(userDataDirectory, APP_SHORTCUT_RECORDS_FILE)
  const sharedPath = join(userDataDirectory, SHARED_FILE)
  if (!existsSync(path) && holdsRecords(sharedPath)) {
    // A move that fails leaves the old file; the records then start empty, as for a file that cannot be read.
    try {
      renameSync(sharedPath, path)
    } catch {}
  }
  return new AppShortcutRecords(path)
}

function holdsRecords(path: string): boolean {
  try {
    return fileSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8'))).success
  } catch {
    return false
  }
}
