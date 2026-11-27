import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { appLinkOf, appWindowRequestOf, appWindowSearch, parseAppLink } from '@solus/contracts/app-shortcuts'
import { appLinkTargetIn } from '@solus/desktop-main/app-shortcuts/app-links'
import { AppShortcutRecords } from '@solus/desktop-main/app-shortcuts/app-shortcut-records'
import { ICNS_SIZES, ICO_SIZES, icnsFile, icoFile } from '@solus/desktop-main/app-shortcuts/icon-files'
import {
  appShortcutIdentifier,
  bundleIdentifierOf,
  desktopEntryArgument,
  launcherFileName,
  linuxDesktopEntry,
  macLauncherInfoPlist,
  macLauncherScript,
  windowsShortcutArguments,
} from '@solus/desktop-main/app-shortcuts/launcher-files'
import type { AppLauncher } from '@solus/desktop-main/app-shortcuts/launchers'
import { restoredWindowBounds } from '@solus/desktop-main/app-shortcuts/window-bounds'
import { macAppLaunchers, solusBundleIdentifier } from '@solus/desktop-main/platform/darwin-app-launchers'
import { linuxAppLaunchers } from '@solus/desktop-main/platform/linux-app-launchers'
import { windowsAppLaunchers } from '@solus/desktop-main/platform/win32-app-launchers'
import { appWindowHost } from '../../apps/desktop/src/renderer/shell/app-window-host'

// App windows and app shortcuts (docs/app-shortcuts.md). These pin the rules of
// the three operating systems without starting a program, so they run on any
// machine: what a launcher opens, which file it may replace or remove, and
// what the desktop app reads as an app link.

const notes = { host: '0123456789abcdef0123456789abcdef', appId: '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b' }
const tasks = { host: notes.host, appId: '11111111-2222-4333-8444-555555555555' }
const notesLink = `solus://app/${notes.host}/${notes.appId}`

function launcher(target: typeof notes, name: string, previousPath: string | null = null): AppLauncher {
  return { target, name, iconPng: (size) => new Uint8Array([size % 256, 1, 2, 3]), previousPath }
}

/** A Trash that keeps what it was given, as `shell.trashItem` does. `refuses` makes it fail, as a volume with no Trash does. */
function fakeTrash(options: { refuses?: boolean } = {}) {
  const trashed: string[] = []
  return {
    trashed,
    async trashItem(path: string) {
      if (options.refuses) throw new Error('The Trash is not available here.')
      mkdirSync(join(dir, '.Trash'), { recursive: true })
      renameSync(path, join(dir, '.Trash', basename(path)))
      trashed.push(path)
    },
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'solus-app-shortcuts-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the app link', () => {
  test('a link names one app on one host and reads back to the same app', () => {
    expect(appLinkOf(notes)).toBe(notesLink)
    expect(parseAppLink(notesLink)).toEqual(notes)
  })

  // WHY: any website and any program can open a link, so a link with a part
  // the desktop app does not know must open nothing.
  test('a link with any other part opens nothing', () => {
    expect(parseAppLink(`${notesLink}?next=evil`)).toBeNull()
    expect(parseAppLink(`${notesLink}/more`)).toBeNull()
    expect(parseAppLink(`${notesLink}#frag`)).toBeNull()
    expect(parseAppLink(`https://app/${notes.host}/${notes.appId}`)).toBeNull()
    expect(parseAppLink(`solus://app/${notes.host}/../${notes.appId}`)).toBeNull()
    expect(parseAppLink(`solus://install/${notes.host}/${notes.appId}`)).toBeNull()
  })

  // WHY: on Windows and Linux the launcher gives the link as an argument, beside
  // the switches that Chromium and a development run add.
  test('the link is found among the arguments of a launch, and a launch without one is a normal launch', () => {
    expect(appLinkTargetIn(['/opt/Solus/solus', '--no-sandbox', notesLink, '--allow-file-access'])).toEqual(notes)
    expect(appLinkTargetIn(['/opt/Solus/solus', '--headless', '/home/sam/project'])).toBeNull()
  })

  test("an app window's page reads its app from its address, and the workspace page reads none", () => {
    const search = appWindowSearch({ ...notes, name: 'Notes & Lists' }).toString()
    expect(appWindowRequestOf(`?${search}`)).toEqual({ ...notes, name: 'Notes & Lists' })
    expect(appWindowRequestOf('?skip-onboarding=')).toBeNull()
    expect(appWindowRequestOf('?app-window-host=../x&app-window-app=y')).toBeNull()
  })
})

describe('the name of a launcher file', () => {
  // WHY: one name must be a valid file name on all three operating systems.
  test('characters and names that an operating system refuses are changed', () => {
    expect(launcherFileName('Notes: "today" / tomorrow?')).toBe('Notes today tomorrow')
    expect(launcherFileName('...hidden')).toBe('hidden')
    expect(launcherFileName('Report. ')).toBe('Report')
    expect(launcherFileName('CON')).toBe('CON App')
    expect(launcherFileName(' / ')).toBe('App')
  })
})

describe('the macOS launcher', () => {
  const install = () => ({ isPackaged: true, executablePath: join(dir, 'Solus.app/Contents/MacOS/Solus'), homeDirectory: dir })
  const launchersDirectory = () => join(dir, 'Applications', 'Solus Apps')

  test('the launcher is an app bundle whose program opens the app link with Solus', async () => {
    const path = await macAppLaunchers(install(), fakeTrash()).write(launcher(notes, 'Notes'))
    expect(path).toBe(join(launchersDirectory(), 'Notes.app'))
    const program = join(path, 'Contents', 'MacOS', 'launcher')
    expect(readFileSync(program, 'utf-8')).toBe(`#!/bin/sh\nexec /usr/bin/open -b 'com.solus.app' '${notesLink}'\n`)
    expect(statSync(program).mode & 0o111).not.toBe(0)
    expect(bundleIdentifierOf(readFileSync(join(path, 'Contents', 'Info.plist'), 'utf-8'))).toBe(appShortcutIdentifier(notes))
    expect(readFileSync(join(path, 'Contents', 'Resources', 'icon.icns')).subarray(0, 4).toString('ascii')).toBe('icns')
  })

  // WHY: a development run must not make launchers that open the installed Solus, or replace its launchers.
  test('a development run opens its own bundle and keeps its launchers in its own folder', async () => {
    const executablePath = join(dir, 'Electron.app/Contents/MacOS/Electron')
    mkdirSync(join(dir, 'Electron.app/Contents'), { recursive: true })
    writeFileSync(join(dir, 'Electron.app/Contents/Info.plist'), '<key>CFBundleIdentifier</key>\n<string>com.github.Electron</string>')
    expect(solusBundleIdentifier(executablePath)).toBe('com.github.Electron')
    const path = await macAppLaunchers({ isPackaged: false, executablePath, homeDirectory: dir }, fakeTrash()).write(launcher(notes, 'Notes'))
    expect(path).toBe(join(dir, 'Applications', 'Solus Apps (Dev)', 'Notes.app'))
    expect(readFileSync(join(path, 'Contents', 'MacOS', 'launcher'), 'utf-8')).toContain("-b 'com.github.Electron'")
  })

  test('a name in the app is text, never markup of the property list', () => {
    const plist = macLauncherInfoPlist('Tom & <Jerry>', notes)
    expect(plist).toContain('<string>Tom &amp; &lt;Jerry&gt;</string>')
    expect(bundleIdentifierOf(plist)).toBe(appShortcutIdentifier(notes))
  })

  test('a value that could end the quoted text of the program is refused', () => {
    expect(() => macLauncherScript(`${notesLink}'; rm -rf ~; '`, 'com.solus.app')).toThrow()
    expect(() => macLauncherScript(notesLink, "com.solus.app' x")).toThrow()
  })

  // WHY: the launchers folder is the person's. A file there that Solus did not write for this app is not Solus's to replace.
  test("a second app with the same name gets its own file, and a file of the person's stays", async () => {
    const launchers = macAppLaunchers(install(), fakeTrash())
    mkdirSync(join(launchersDirectory(), 'Journal.app'), { recursive: true })
    writeFileSync(join(launchersDirectory(), 'Journal.app', 'mine.txt'), 'keep')
    const first = await launchers.write(launcher(notes, 'Journal'))
    const second = await launchers.write(launcher(tasks, 'Journal'))
    expect(first).not.toBe(join(launchersDirectory(), 'Journal.app'))
    expect(second).not.toBe(first)
    expect(readFileSync(join(launchersDirectory(), 'Journal.app', 'mine.txt'), 'utf-8')).toBe('keep')
    // Writing the same app again takes its own file back and makes no third one.
    expect(await launchers.write(launcher(notes, 'Journal', first))).toBe(first)
  })

  // WHY: the launcher at the new name replaces the old one, so nothing is lost and the Trash does not fill with each rename.
  test('a rename moves the launcher, so the app never has two, and the old one is not put in the Trash', async () => {
    const trash = fakeTrash()
    const launchers = macAppLaunchers(install(), trash)
    const before = await launchers.write(launcher(notes, 'Notes'))
    const after = await launchers.write(launcher(notes, 'Notebook', before))
    expect(after).toBe(join(launchersDirectory(), 'Notebook.app'))
    expect(existsSync(before)).toBe(false)
    expect(trash.trashed).toEqual([])
  })

  // WHY: a removal the person did not mean must be undoable. The launcher goes to the Trash, where the Finder puts it back.
  test("remove moves this app's launcher to the Trash and touches no other file", async () => {
    const trash = fakeTrash()
    const launchers = macAppLaunchers(install(), trash)
    const path = await launchers.write(launcher(notes, 'Notes'))
    const outside = join(dir, 'Elsewhere.app')
    mkdirSync(outside)
    expect(await launchers.remove(notes, outside)).toEqual({ launcher: 'removed' })
    expect(await launchers.remove(tasks, path)).toEqual({ launcher: 'removed' })
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(trash.trashed).toEqual([])
    expect(await launchers.remove(notes, path)).toEqual({ launcher: 'trashed' })
    expect(trash.trashed).toEqual([path])
    expect(existsSync(path)).toBe(false)
    // Taken back from the Trash, the launcher is this app's again: a new shortcut takes it and makes no second one.
    renameSync(join(dir, '.Trash', 'Notes.app'), path)
    expect(await launchers.write(launcher(notes, 'Notes'))).toBe(path)
  })

  // WHY: Solus does not delete a launcher for good without asking. A Trash that refuses it leaves it, and the answer says where.
  test('a Trash that refuses the launcher leaves it in its place', async () => {
    const launchers = macAppLaunchers(install(), fakeTrash({ refuses: true }))
    const path = await launchers.write(launcher(notes, 'Notes'))
    expect(await launchers.remove(notes, path)).toEqual({ launcher: 'kept', launcherPath: path })
    expect(existsSync(path)).toBe(true)
  })
})

describe('the Linux launcher', () => {
  const install = (env: NodeJS.ProcessEnv = {}) => ({
    isPackaged: true,
    executablePath: '/opt/Solus/solus',
    launchArguments: [],
    filesDirectory: join(dir, 'files'),
    homeDirectory: dir,
    env,
  })

  test('the launcher is a desktop entry that starts Solus with the app link', async () => {
    const launchers = linuxAppLaunchers(install())
    const path = await launchers.write(launcher(notes, 'Notes'))
    expect(path.startsWith(join(dir, '.local', 'share', 'applications', 'solus-app-'))).toBe(true)
    const entry = readFileSync(path, 'utf-8')
    expect(entry).toContain('Type=Application\n')
    expect(entry).toContain('Name=Notes\n')
    expect(entry).toContain(`Exec="/opt/Solus/solus" "${notesLink}"\n`)
    const icon = /^Icon=(.+)$/m.exec(entry)?.[1] ?? ''
    expect(existsSync(icon)).toBe(true)
    expect(launchers.windowIdentity(notes, 'Notes')).toEqual({ iconPath: icon, taskbar: null })
  })

  // WHY: an AppImage runs from a mount that is gone when it quits, so the program inside it cannot start Solus later.
  test('an AppImage starts from its image file, and the entry goes where the desktop is told to look', async () => {
    const launchers = linuxAppLaunchers(install({ APPIMAGE: '/home/sam/Apps/Solus.AppImage', XDG_DATA_HOME: join(dir, 'data') }))
    const path = await launchers.write(launcher(notes, 'Notes'))
    expect(path.startsWith(join(dir, 'data', 'applications'))).toBe(true)
    expect(readFileSync(path, 'utf-8')).toContain(`Exec="/home/sam/Apps/Solus.AppImage" "${notesLink}"\n`)
  })

  // WHY: the desktop expands `$`, a backquote, and `%` in an Exec line. A folder name with one must stay a folder name.
  test('an argument is quoted so the desktop reads it as one text', () => {
    expect(desktopEntryArgument('/home/sam/My Apps/solus')).toBe('"/home/sam/My Apps/solus"')
    expect(desktopEntryArgument('/opt/$HOME/100%`x`')).toBe('"/opt/\\\\$HOME/100%%\\\\`x\\\\`"')
    expect(linuxDesktopEntry({ name: 'A\nB', command: ['/x'], iconPath: '/i.png' })).toContain('Name=A B\n')
  })

  // WHY: Linux deletes the entry (docs/app-shortcuts.md §4): its Trash needs a program many desktops do not have, and a new shortcut writes the same entry.
  test('remove deletes the entry and its icon, and only at the path of this app', async () => {
    const launchers = linuxAppLaunchers(install())
    const path = await launchers.write(launcher(notes, 'Notes'))
    const other = await launchers.write(launcher(tasks, 'Tasks'))
    await launchers.remove(notes, other)
    expect(existsSync(other)).toBe(true)
    expect(await launchers.remove(notes, path)).toEqual({ launcher: 'removed' })
    expect(existsSync(path)).toBe(false)
    expect(launchers.windowIdentity(notes, 'Notes').iconPath).toBeNull()
  })
})

describe('the Windows launcher', () => {
  interface WrittenShortcut { target: string; args?: string; appUserModelId?: string; icon?: string; description?: string }
  const install = () => ({
    isPackaged: true,
    executablePath: 'C:\\Program Files\\Solus\\Solus.exe',
    launchArguments: [],
    filesDirectory: join(dir, 'files'),
    appDataDirectory: join(dir, 'Roaming'),
  })
  /** A Start menu that keeps what was written, as `shell` of Electron does on Windows. */
  function startMenu(trash = fakeTrash()) {
    const written = new Map<string, WrittenShortcut>()
    const launchers = windowsAppLaunchers(install(), {
      trashItem: trash.trashItem,
      writeShortcutLink: (path: string, _operation: string, options: WrittenShortcut) => {
        written.set(path, options)
        writeFileSync(path, 'shortcut')
        return true
      },
      readShortcutLink: (path: string) => {
        const shortcut = written.get(path)
        if (!shortcut) throw new Error('not a shortcut')
        return shortcut
      },
    })
    return { written, launchers }
  }

  test('the shortcut starts Solus with the app link and carries the identifier of the app', async () => {
    const { written, launchers } = startMenu()
    const path = await launchers.write(launcher(notes, 'Notes'))
    expect(path).toBe(join(dir, 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Solus Apps', 'Notes.lnk'))
    const shortcut = written.get(path)
    expect(shortcut?.target).toBe('C:\\Program Files\\Solus\\Solus.exe')
    expect(shortcut?.args).toBe(`"${notesLink}"`)
    expect(shortcut?.appUserModelId).toBe(appShortcutIdentifier(notes))
    expect(readFileSync(shortcut?.icon ?? '').readUInt16LE(2)).toBe(1)
  })

  // WHY: the window and the shortcut share one identifier, so Windows gives the app its own taskbar button, and a pin of it starts the app.
  test('the window of the app takes the identifier and the icon of its shortcut', async () => {
    const { launchers } = startMenu()
    expect(launchers.windowIdentity(notes, 'Notes').iconPath).toBeNull()
    await launchers.write(launcher(notes, 'Notes'))
    const identity = launchers.windowIdentity(notes, 'Notes')
    expect(identity.taskbar?.appId).toBe(appShortcutIdentifier(notes))
    expect(identity.taskbar?.appIconPath).toBe(identity.iconPath ?? undefined)
    expect(identity.taskbar?.relaunchCommand).toBe(`"C:\\Program Files\\Solus\\Solus.exe" "${notesLink}"`)
  })

  test('a rename moves the shortcut and keeps its icon; remove puts the shortcut in the Recycle Bin and takes its icon', async () => {
    const trash = fakeTrash()
    const { launchers } = startMenu(trash)
    const before = await launchers.write(launcher(notes, 'Notes'))
    const after = await launchers.write(launcher(notes, 'Notebook', before))
    expect(existsSync(before)).toBe(false)
    expect(trash.trashed).toEqual([])
    const icon = launchers.windowIdentity(notes, 'Notebook').iconPath
    expect(icon).not.toBeNull()
    expect(await launchers.remove(tasks, after)).toEqual({ launcher: 'removed' })
    expect(existsSync(after)).toBe(true)
    expect(await launchers.remove(notes, after)).toEqual({ launcher: 'trashed' })
    expect(trash.trashed).toEqual([after])
    expect(existsSync(after)).toBe(false)
    expect(launchers.windowIdentity(notes, 'Notebook').iconPath).toBeNull()
  })

  // WHY: a shortcut that stays still opens its app, so it keeps the icon it shows.
  test('a Recycle Bin that refuses the shortcut leaves it with its icon', async () => {
    const { launchers } = startMenu(fakeTrash({ refuses: true }))
    const path = await launchers.write(launcher(notes, 'Notes'))
    expect(await launchers.remove(notes, path)).toEqual({ launcher: 'kept', launcherPath: path })
    expect(existsSync(path)).toBe(true)
    expect(launchers.windowIdentity(notes, 'Notes').iconPath).not.toBeNull()
  })

  test('an argument with a space or a quote is one argument to the program', () => {
    expect(windowsShortcutArguments(['C:\\My Apps\\solus', 'say "hi"'])).toBe('"C:\\My Apps\\solus" "say \\"hi\\""')
    expect(windowsShortcutArguments(['C:\\dir\\'])).toBe('"C:\\dir\\\\"')
  })
})

describe('the icon files', () => {
  const images = [...new Set([...ICNS_SIZES, ...ICO_SIZES])].map((size) => ({ size, png: new Uint8Array(size % 97 + 5).fill(7) }))

  test('the macOS icon is one container whose length is the sum of its entries', () => {
    const icns = icnsFile(images)
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.byteLength)
    let offset = 8
    const types: string[] = []
    while (offset < icns.byteLength) {
      types.push(icns.subarray(offset, offset + 4).toString('ascii'))
      offset += icns.readUInt32BE(offset + 4)
    }
    expect(offset).toBe(icns.byteLength)
    expect(types).toEqual(['ic11', 'ic12', 'ic07', 'ic08', 'ic13', 'ic09', 'ic14', 'ic10'])
  })

  test('the Windows icon lists each image at the place its data starts', () => {
    const ico = icoFile(images)
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, ICO_SIZES.length])
    ICO_SIZES.forEach((size, index) => {
      const entry = 6 + 16 * index
      const png = images.find((image) => image.size === size)?.png ?? new Uint8Array()
      // 256 does not fit one byte: the format writes it as 0.
      expect(ico.readUInt8(entry)).toBe(size === 256 ? 0 : size)
      expect(ico.readUInt32LE(entry + 8)).toBe(png.byteLength)
      const start = ico.readUInt32LE(entry + 12)
      expect([...ico.subarray(start, start + png.byteLength)]).toEqual([...png])
    })
  })

  test('an icon with a missing size is refused, not written with a hole', () => {
    expect(() => icoFile(images.filter((image) => image.size !== 48))).toThrow()
  })
})

describe('the records of this device', () => {
  test('a shortcut and the place of a window hold across a restart', () => {
    const path = join(dir, 'app-shortcuts.json')
    const records = new AppShortcutRecords(path)
    records.save({ ...notes, name: 'Notes', launcherPath: '/a/Notes.app' })
    records.save({ ...notes, name: 'Notebook', launcherPath: '/a/Notebook.app' })
    records.saveWindowBounds(notes, { x: 10, y: 20, width: 900, height: 700 })
    const reopened = new AppShortcutRecords(path)
    expect(reopened.list()).toEqual([{ ...notes, name: 'Notebook', launcherPath: '/a/Notebook.app' }])
    expect(reopened.windowBounds(notes)).toEqual({ x: 10, y: 20, width: 900, height: 700 })
    expect(reopened.windowBounds(tasks)).toBeNull()
    reopened.remove(notes)
    expect(new AppShortcutRecords(path).find(notes)).toBeNull()
  })

  // WHY: a damaged file must not stop the desktop app, and a launcher needs no record to open its app.
  test('a damaged file starts empty', () => {
    const path = join(dir, 'app-shortcuts.json')
    writeFileSync(path, '{ "version": 1, "shortcuts": [')
    expect(new AppShortcutRecords(path).list()).toEqual([])
  })
})

describe('where an app window opens', () => {
  const display = { x: 0, y: 0, width: 1440, height: 900 }

  // WHY: a window that opens on a display that is gone is a window the person cannot find.
  test('the window opens where the person left it only while that place is on a display', () => {
    const saved = { x: 200, y: 100, width: 900, height: 700 }
    expect(restoredWindowBounds(saved, [display])).toEqual(saved)
    expect(restoredWindowBounds({ ...saved, x: 2000 }, [display])).toBeNull()
    expect(restoredWindowBounds({ ...saved, x: 2000 }, [display, { x: 1440, y: 0, width: 1920, height: 1080 }])).toEqual({ ...saved, x: 2000 })
    expect(restoredWindowBounds({ ...saved, x: 1400 }, [display])).toBeNull()
    expect(restoredWindowBounds(null, [display])).toBeNull()
  })
})

describe("the host of an app window's app", () => {
  const hosts = [{ id: 'local', installationId: notes.host }, { id: 'h-2', installationId: 'ffff' }]

  // WHY: "not on the list yet" and "not on the list" are different answers. The first waits; the second tells the person what to do.
  test('a host is known by its installation id; an unknown host waits only while the list is read', () => {
    expect(appWindowHost(hosts, 'loading', notes.host)).toEqual({ kind: 'known', serverId: 'local' })
    expect(appWindowHost(hosts, 'loading', 'aaaa')).toEqual({ kind: 'finding' })
    expect(appWindowHost(hosts, 'ready', 'aaaa')).toEqual({ kind: 'unknown' })
    expect(appWindowHost(hosts, 'failed', 'aaaa')).toEqual({ kind: 'unknown' })
  })
})
