import { createHash } from 'node:crypto'
import type { AppShortcutTarget } from '@solus/contracts/app-shortcuts'

/**
 * The text of each operating system's launcher for one app
 * (docs/app-shortcuts.md §4). Pure, so the rules of all three are tested on
 * any machine; the platform adapters write the files.
 */

/** One app on one host, as 16 hex digits: a part of a file name and of an identifier. */
export function appShortcutId(target: AppShortcutTarget): string {
  return createHash('sha256').update(`${target.host}\n${target.appId}`).digest('hex').slice(0, 16)
}

/**
 * The identifier of an app's launcher: the bundle identifier of the macOS
 * launcher and the AppUserModelID of the Windows shortcut and its window. A
 * launcher that carries it is this app's, so it is safe to replace or remove.
 */
export function appShortcutIdentifier(target: AppShortcutTarget): string {
  return `com.solus.app.shortcut.${appShortcutId(target)}`
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** The app's name as a file name that macOS, Windows, and Linux all accept. */
export function launcherFileName(name: string): string {
  const cleaned = name
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^\.+/u, '')
    .slice(0, 80)
    .replace(/[. ]+$/u, '')
  if (!cleaned) return 'App'
  return WINDOWS_RESERVED_NAME.test(cleaned) ? `${cleaned} App` : cleaned
}

/**
 * The file names a launcher tries, in order. Another file can hold the app's
 * name already (a second app with that name, or a file of the person's): the
 * later names add a part of the app's id, and the last one is unique.
 */
export function launcherNameCandidates(name: string, target: AppShortcutTarget): string[] {
  const base = launcherFileName(name)
  const id = appShortcutId(target)
  return [base, `${base} ${id.slice(0, 6)}`, `${base} ${id}`]
}

function xmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;' : character === '"' ? '&quot;' : '&apos;')
}

const BUNDLE_IDENTIFIER_KEY = /<key>CFBundleIdentifier<\/key>\s*<string>([A-Za-z0-9.-]+)<\/string>/

/** The bundle identifier an `Info.plist` names; null when it names none this code can use. */
export function bundleIdentifierOf(infoPlist: string): string | null {
  return BUNDLE_IDENTIFIER_KEY.exec(infoPlist)?.[1] ?? null
}

/** `LSUIElement` keeps the launcher itself out of the Dock: it only hands the link to Solus and exits. */
export function macLauncherInfoPlist(name: string, target: AppShortcutTarget): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>${xmlText(name)}</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleIdentifier</key><string>${appShortcutIdentifier(target)}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${xmlText(name)}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`
}

/**
 * The executable of the macOS launcher. macOS gives a link to an app that
 * runs only through `open`, so the launcher is one `open` of the app link,
 * sent to the Solus with this bundle identifier.
 */
export function macLauncherScript(link: string, solusBundleId: string): string {
  if (!/^[A-Za-z0-9.-]+$/.test(solusBundleId)) throw new Error('The bundle identifier of Solus is not valid.')
  if (!/^[A-Za-z0-9:/_-]+$/.test(link)) throw new Error('The app link is not valid.')
  return `#!/bin/sh\nexec /usr/bin/open -b '${solusBundleId}' '${link}'\n`
}

/**
 * One argument of an `Exec` line (Desktop Entry Specification, "The Exec key"):
 * quoted, with the quote's own escapes, then the escapes of every string
 * value, then `%`, which starts a field code.
 */
export function desktopEntryArgument(value: string): string {
  const quoted = `"${value.replace(/(["`$\\])/g, '\\$1')}"`
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')
}

function desktopEntryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
}

export interface LinuxDesktopEntry {
  name: string
  /** The program that starts Solus, and its arguments; the app link is the last one. */
  command: readonly string[]
  iconPath: string
}

export function linuxDesktopEntry(entry: LinuxDesktopEntry): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${desktopEntryString(launcherFileName(entry.name))}`,
    `Exec=${entry.command.map(desktopEntryArgument).join(' ')}`,
    `Icon=${desktopEntryString(entry.iconPath)}`,
    'Terminal=false',
    'Categories=Utility;',
    '',
  ].join('\n')
}

/**
 * The desktop entry that opens `solus:` links: `%u` is the link, which the
 * desktop adds as the last argument. It is not an app to list.
 */
export function linuxLinkHandlerEntry(command: readonly string[]): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Solus',
    `Exec=${command.map(desktopEntryArgument).join(' ')} %u`,
    'Terminal=false',
    'NoDisplay=true',
    'MimeType=x-scheme-handler/solus;',
    '',
  ].join('\n')
}

/** The arguments of a Windows shortcut as one command line. */
export function windowsShortcutArguments(values: readonly string[]): string {
  return values.map((value) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`).join(' ')
}
