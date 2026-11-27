import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { appLinkOf, appWindowRequestOf, appWindowSearch, hostAddressOf, parseAppLink } from '@solus/contracts/app-shortcuts'
import { appShortcutLinkOf, parseAppLinkAction, parseAppShortcutLink, type AppLinkAction } from '@solus/contracts/app-shortcut-links'
import { appLinkActionIn, appWindowRequestFor, MAX_WAITING_APP_LINKS, queueAppLink } from '@solus/desktop-main/app-shortcuts/app-links'
import { AppShortcutRecords } from '@solus/desktop-main/app-shortcuts/app-shortcut-records'
import { ICNS_SIZES, ICO_SIZES, icnsFile, icoFile } from '@solus/desktop-main/app-shortcuts/icon-files'
import {
  appShortcutIdentifier,
  bundleIdentifierOf,
  desktopEntryArgument,
  launcherFileName,
  linuxDesktopEntry,
  linuxLinkHandlerEntry,
  macLauncherInfoPlist,
  macLauncherScript,
  windowsShortcutArguments,
} from '@solus/desktop-main/app-shortcuts/launcher-files'
import type { AppLauncher } from '@solus/desktop-main/app-shortcuts/launchers'
import { restoredWindowBounds } from '@solus/desktop-main/app-shortcuts/window-bounds'
import { macAppLaunchers, solusBundleIdentifier } from '@solus/desktop-main/platform/darwin-app-launchers'
import { linuxAppLaunchers, writeLinuxLinkHandler } from '@solus/desktop-main/platform/linux-app-launchers'
import { windowsAppLaunchers } from '@solus/desktop-main/platform/win32-app-launchers'
import { appWindowHost, appWindowHostGapView, checkLinkAddress } from '../../apps/desktop/src/renderer/shell/app-window-host'

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
    expect(appLinkActionIn(['/opt/Solus/solus', '--no-sandbox', notesLink, '--allow-file-access'])).toEqual({ kind: 'open', target: notes })
    expect(appLinkActionIn(['/opt/Solus/solus', '--headless', '/home/sam/project'])).toBeNull()
  })

  test("an app window's page reads its app from its address, and the workspace page reads none", () => {
    const search = appWindowSearch({ ...notes, name: 'Notes & Lists' }).toString()
    expect(appWindowRequestOf(`?${search}`)).toEqual({ ...notes, name: 'Notes & Lists' })
    expect(appWindowRequestOf('?skip-onboarding=')).toBeNull()
    expect(appWindowRequestOf('?app-window-host=../x&app-window-app=y')).toBeNull()
  })
})

describe('the shortcut link', () => {
  const offer = { address: 'https://studio.example.com', account: 'user_01H8XYZ' }
  const shortcutLink = appShortcutLinkOf({ target: notes, name: 'Notes & Lists', offer })!

  test('a link names one app on one host, with what the web client knew of the host, and reads back the same', () => {
    expect(shortcutLink.startsWith(`solus://app-shortcut/${notes.host}/${notes.appId}?`)).toBe(true)
    expect(parseAppShortcutLink(shortcutLink)).toEqual({ target: notes, name: 'Notes & Lists', offer })
    const bare = appShortcutLinkOf({ target: notes, name: null, offer: { address: null, account: null } })!
    expect(bare).toBe(`solus://app-shortcut/${notes.host}/${notes.appId}`)
    expect(parseAppShortcutLink(bare)).toEqual({ target: notes, name: null, offer: { address: null, account: null } })
  })

  // WHY: any website can open a link. A part the desktop app does not know, or a
  // second copy of a part, must open nothing, so a page cannot slip in a path,
  // a command, or a second address.
  test('a link with any other part, or a part given twice, opens nothing', () => {
    const base = `solus://app-shortcut/${notes.host}/${notes.appId}`
    expect(parseAppShortcutLink(`${base}?run=open`)).toBeNull()
    expect(parseAppShortcutLink(`${base}?address=https%3A%2F%2Fa.example&address=https%3A%2F%2Fb.example`)).toBeNull()
    expect(parseAppShortcutLink(`${base}#x`)).toBeNull()
    expect(parseAppShortcutLink(`${base}/more`)).toBeNull()
    expect(parseAppShortcutLink(`solus://app-shortcut/${notes.host}/..%2F${notes.appId}`)).toBeNull()
    expect(parseAppShortcutLink(`solus://app-shortcut/${notes.host}`)).toBeNull()
    expect(parseAppShortcutLink(`${base}?name=${encodeURIComponent('Notes\nrm -rf')}`)).toBeNull()
    expect(parseAppShortcutLink(`${base}?account=${encodeURIComponent('a b')}`)).toBeNull()
    expect(parseAppShortcutLink(`${base}?name=${'x'.repeat(2100)}`)).toBeNull()
  })

  // WHY: the address only names where to look for the host. A local path, a
  // credential, or a page of a site must never reach the desktop app as one.
  test('an address is a bare http or https origin, and nothing else', () => {
    expect(hostAddressOf('https://studio.example.com')).toBe('https://studio.example.com')
    expect(hostAddressOf('http://192.168.1.20:4317')).toBe('http://192.168.1.20:4317')
    expect(hostAddressOf('http://[::1]:4317')).toBe('http://[::1]:4317')
    for (const refused of ['file:///etc/passwd', 'https://sam:secret@studio.example.com', 'https://studio.example.com/x', 'https://studio.example.com/', 'https://studio.example.com?x=1', 'javascript:alert(1)', 'ws://studio.example.com', '/home/sam', 'C:\\Users\\sam']) {
      expect(hostAddressOf(refused)).toBeNull()
      expect(parseAppShortcutLink(`solus://app-shortcut/${notes.host}/${notes.appId}?address=${encodeURIComponent(refused)}`)).toBeNull()
    }
  })

  // WHY: the desktop app acts on two kinds of link only, and each opens an app.
  test('a link the desktop app takes is an app link or a shortcut link, and nothing else', () => {
    expect(parseAppLinkAction(notesLink)).toEqual({ kind: 'open', target: notes })
    expect(parseAppLinkAction(shortcutLink)).toEqual({ kind: 'add-shortcut', target: notes, name: 'Notes & Lists', offer })
    expect(parseAppLinkAction('solus://approve-app?host=x&request=y')).toBeNull()
    expect(parseAppLinkAction('solus://pair?link=http%3A%2F%2F10.0.0.2')).toBeNull()
    expect(appLinkActionIn(['C:\\Solus\\Solus.exe', shortcutLink])).toEqual({ kind: 'add-shortcut', target: notes, name: 'Notes & Lists', offer })
  })

  test("an app window's page reads the offer of a shortcut link from its address, and drops a part it would refuse", () => {
    const search = appWindowSearch({ ...notes, name: 'Notes', offer }).toString()
    expect(appWindowRequestOf(`?${search}`)).toEqual({ ...notes, name: 'Notes', offer })
    const forged = `${appWindowSearch({ ...notes, name: 'Notes', offer: { address: null, account: null } })}&app-window-address=file%3A%2F%2F%2Fetc`
    expect(appWindowRequestOf(`?${forged}`)).toEqual({ ...notes, name: 'Notes', offer: { address: null, account: null } })
  })
})

describe('a link that reaches the desktop app', () => {
  const offer = { address: 'https://studio.example.com', account: null }
  const open: AppLinkAction = { kind: 'open', target: notes }
  const add: AppLinkAction = { kind: 'add-shortcut', target: notes, name: 'Notes', offer }
  const record = { ...notes, name: 'Notes (saved)', launcherPath: '/x/Notes.app' }

  // WHY: a link only opens the app. It never adds the shortcut: the window asks,
  // with the name the host gives, and the person answers.
  test('a shortcut link opens the app with the question, and a shortcut this computer has is not asked again', () => {
    expect(appWindowRequestFor(add, { find: () => null })).toEqual({ ...notes, name: 'Notes', offer })
    expect(appWindowRequestFor(add, { find: () => record })).toEqual({ ...notes, name: 'Notes (saved)' })
    expect(appWindowRequestFor(open, { find: () => null })).toEqual({ ...notes, name: '' })
  })

  // WHY: a page can open a link many times before Solus is ready. Each one would be a window.
  test('links that wait for the app are kept once each, and only a few at a time', () => {
    const waiting: AppLinkAction[] = []
    expect(queueAppLink(waiting, add)).toBe(true)
    expect(queueAppLink(waiting, { ...add, offer: { ...offer } })).toBe(false)
    expect(queueAppLink(waiting, open)).toBe(true)
    for (let index = 0; index < 10; index++) queueAppLink(waiting, { kind: 'open', target: { host: notes.host, appId: `app-${index}` } })
    expect(waiting).toHaveLength(MAX_WAITING_APP_LINKS)
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
    const path = await macAppLaunchers(install()).write(launcher(notes, 'Notes'))
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
    const path = await macAppLaunchers({ isPackaged: false, executablePath, homeDirectory: dir }).write(launcher(notes, 'Notes'))
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
    const launchers = macAppLaunchers(install())
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

  test('a rename moves the launcher, so the app never has two', async () => {
    const launchers = macAppLaunchers(install())
    const before = await launchers.write(launcher(notes, 'Notes'))
    const after = await launchers.write(launcher(notes, 'Notebook', before))
    expect(after).toBe(join(launchersDirectory(), 'Notebook.app'))
    expect(existsSync(before)).toBe(false)
  })

  test("remove takes this app's launcher and no other file", async () => {
    const launchers = macAppLaunchers(install())
    const path = await launchers.write(launcher(notes, 'Notes'))
    const outside = join(dir, 'Elsewhere.app')
    mkdirSync(outside)
    await launchers.remove(notes, outside)
    await launchers.remove(tasks, path)
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(path)).toBe(true)
    await launchers.remove(notes, path)
    expect(existsSync(path)).toBe(false)
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

  // WHY: a browser opens a `solus:` link through the desktop entry that names the scheme; `%u` is the link.
  test('the link handler is a hidden entry that starts Solus with the link', async () => {
    const name = await writeLinuxLinkHandler(install({ APPIMAGE: '/home/sam/Apps/Solus.AppImage' }))
    const entry = readFileSync(join(dir, '.local', 'share', 'applications', name), 'utf-8')
    expect(entry).toContain('Exec="/home/sam/Apps/Solus.AppImage" %u\n')
    expect(entry).toContain('MimeType=x-scheme-handler/solus;\n')
    expect(entry).toContain('NoDisplay=true\n')
    expect(linuxLinkHandlerEntry(['/opt/$x/solus'])).toContain('Exec="/opt/\\\\$x/solus" %u\n')
  })

  test('remove takes the entry and its icon, and only at the path of this app', async () => {
    const launchers = linuxAppLaunchers(install())
    const path = await launchers.write(launcher(notes, 'Notes'))
    const other = await launchers.write(launcher(tasks, 'Tasks'))
    await launchers.remove(notes, other)
    expect(existsSync(other)).toBe(true)
    await launchers.remove(notes, path)
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
  function startMenu() {
    const written = new Map<string, WrittenShortcut>()
    const launchers = windowsAppLaunchers(install(), {
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

  test('a rename moves the shortcut and keeps its icon; remove takes both', async () => {
    const { launchers } = startMenu()
    const before = await launchers.write(launcher(notes, 'Notes'))
    const after = await launchers.write(launcher(notes, 'Notebook', before))
    expect(existsSync(before)).toBe(false)
    const icon = launchers.windowIdentity(notes, 'Notebook').iconPath
    expect(icon).not.toBeNull()
    await launchers.remove(tasks, after)
    expect(existsSync(after)).toBe(true)
    await launchers.remove(notes, after)
    expect(existsSync(after)).toBe(false)
    expect(launchers.windowIdentity(notes, 'Notebook').iconPath).toBeNull()
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
    expect(appWindowHost(hosts, 'ready', 'aaaa')).toEqual({ kind: 'unknown', reason: 'not-added' })
    expect(appWindowHost(hosts, 'failed', 'aaaa')).toEqual({ kind: 'unknown', reason: 'not-added' })
  })

  // WHY: "add this host", "sign in", and "you are signed in to another account" need three different next steps.
  test("a shortcut link's account tells a sign-in that is missing or another from a host that is not added", () => {
    const offer = { address: null, account: 'user-a' }
    expect(appWindowHost(hosts, 'ready', 'aaaa', offer, { hasAnswered: false, subject: null })).toEqual({ kind: 'finding' })
    expect(appWindowHost(hosts, 'ready', 'aaaa', offer, { hasAnswered: true, subject: null })).toEqual({ kind: 'unknown', reason: 'signed-out' })
    expect(appWindowHost(hosts, 'ready', 'aaaa', offer, { hasAnswered: true, subject: 'user-b' })).toEqual({ kind: 'unknown', reason: 'other-account' })
    expect(appWindowHost(hosts, 'ready', 'aaaa', offer, { hasAnswered: true, subject: 'user-a' })).toEqual({ kind: 'unknown', reason: 'not-added' })
    expect(appWindowHost(hosts, 'ready', notes.host, offer, { hasAnswered: true, subject: 'user-b' })).toEqual({ kind: 'known', serverId: 'local' })
    expect(appWindowHostGapView('other-account', null, 'checking').action?.request).toEqual({ kind: 'account' })
  })

  // WHY: any page can write the address. The window offers to add that host only
  // when it answers as the host the link names.
  test("the link's address is offered as the host only when it answers with the link's installation id", async () => {
    const answering = (installationId: string | null): typeof fetch => (async () =>
      installationId === null ? new Response('', { status: 502 }) : Response.json({ ok: true, installationId, name: 'studio' })) as unknown as typeof fetch
    const signal = new AbortController().signal
    const address = 'https://studio.example.com'
    expect(await checkLinkAddress(answering('aaaa'), address, 'aaaa', signal)).toBe('same-host')
    expect(await checkLinkAddress(answering('bbbb'), address, 'aaaa', signal)).toBe('other-host')
    expect(await checkLinkAddress(answering(null), address, 'aaaa', signal)).toBe('no-answer')
    expect(appWindowHostGapView('not-added', address, 'same-host').action).toEqual({ label: 'Add host…', request: { kind: 'add-host', address } })
    expect(appWindowHostGapView('not-added', address, 'other-host').action).toBeNull()
    expect(appWindowHostGapView('not-added', address, 'no-answer').action).toBeNull()
  })
})
