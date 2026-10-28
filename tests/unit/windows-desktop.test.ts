import { describe, expect, mock, test } from 'bun:test'
import { renameRetrying } from '@solus/server/platform/rename-retry'
import { EDITOR_APPS, editorApp } from '@solus/desktop-main/editor-apps'
import { windowsEditorProgram, windowsInstallRoots, type InstallFiles } from '@solus/desktop-main/platform/win32-editors'
import { windowsTerminalLaunch } from '@solus/desktop-main/platform/win32-terminal'
import { BADGE_PIXELS, badgeBitmap, badgeLabel } from '@solus/desktop-main/platform/win32-badge'
import { LINUX_KEYS, MAC_KEYS, WINDOWS_KEYS } from '@solus/workspace-ui/lib/keybindings/key-platform'

// The desktop app on Windows (docs/plans/windows.md §7.3). These pin the
// Windows choices without starting any program, so they run on every platform.

// The adapters import Electron, which only loads inside Electron.
mock.module('electron', () => ({ app: {}, Menu: {}, desktopCapturer: {}, nativeImage: {}, screen: {} }))
const { desktopPlatformFor } = await import('@solus/desktop-main/platform/desktop-platform')

describe('the desktop adapter for each operating system', () => {
  // WHY: the main process asks the adapter instead of `process.platform`, so a
  // wrong pick puts one platform's behaviour on another.
  test('each operating system gets its own adapter and keys; anything else is Linux', () => {
    expect(desktopPlatformFor('darwin').keys).toBe(MAC_KEYS)
    expect(desktopPlatformFor('win32').keys).toBe(WINDOWS_KEYS)
    expect(desktopPlatformFor('linux').keys).toBe(LINUX_KEYS)
    expect(desktopPlatformFor('freebsd').id).toBe('linux')
  })

  test('Windows locks to one instance, quits with its windows, and shows from a left click', () => {
    const windows = desktopPlatformFor('win32')
    expect(windows.singleInstance).toBe(true)
    expect(windows.quitsWhenWindowsClose).toBe(true)
    expect(windows.trayShowsOnClick).toBe(true)
    expect(windows.holdsHiddenUntilTrayShow).toBe(false)
  })

  test('macOS keeps its reopen model and its title bar; Linux and Windows draw the system one', () => {
    const mac = desktopPlatformFor('darwin')
    expect(mac.singleInstance).toBe(false)
    expect(mac.quitsWhenWindowsClose).toBe(false)
    expect(mac.windowOptions.titleBarStyle).toBe('hiddenInset')
    expect(desktopPlatformFor('linux').windowOptions).toEqual({})
    expect(desktopPlatformFor('win32').windowOptions).toEqual({})
  })

  test('a worktree terminal opens a login shell through tmux, and PowerShell itself on Windows', () => {
    // WHY: Windows has no tmux and no `exec`, so the POSIX command would fail in PowerShell.
    expect(desktopPlatformFor('win32').terminal.shellCommand({ SHELL: '/bin/zsh' })).toBe('')
    expect(desktopPlatformFor('linux').terminal.shellCommand({})).toBe("exec '/bin/sh' -l")
    expect(desktopPlatformFor('darwin').terminal.shellCommand({})).toBe("exec '/bin/zsh' -l")
  })

  test('only macOS hides Solus after a terminal launch', () => {
    expect(desktopPlatformFor('darwin').terminal.hidesAppAfterLaunch).toBe(true)
    expect(desktopPlatformFor('linux').terminal.hidesAppAfterLaunch).toBe(false)
    expect(desktopPlatformFor('win32').terminal.hidesAppAfterLaunch).toBe(false)
  })
})

function busy(code: string, failures: number) {
  let attempts = 0
  return {
    attempts: () => attempts,
    rename: async () => {
      attempts++
      if (attempts <= failures) throw Object.assign(new Error(code), { code })
    },
  }
}

describe('server rename on Windows', () => {
  test('a rename held by antivirus is retried on Windows only', async () => {
    // WHY: the packaged plugin copy failed with EPERM on the Windows machine, so
    // agents ran without the bundled plugins.
    const windows = busy('EPERM', 2)
    await renameRetrying('a', 'b', 'win32', windows.rename, 0)
    expect(windows.attempts()).toBe(3)

    const linux = busy('EPERM', 1)
    await expect(renameRetrying('a', 'b', 'linux', linux.rename, 0)).rejects.toThrow('EPERM')
    expect(linux.attempts()).toBe(1)

    const missing = busy('ENOENT', 1)
    await expect(renameRetrying('a', 'b', 'win32', missing.rename, 0)).rejects.toThrow('ENOENT')
    expect(missing.attempts()).toBe(1)
  })
})

function installFiles(files: string[]): InstallFiles {
  const existing = new Set(files.map((file) => file.toLowerCase()))
  return {
    exists: (file) => existing.has(file.toLowerCase()),
    list: (dir) => {
      const prefix = `${dir}\\`.toLowerCase()
      const names = new Set<string>()
      for (const file of files) {
        if (file.toLowerCase().startsWith(prefix)) names.add(file.slice(prefix.length).split('\\')[0])
      }
      return [...names]
    },
  }
}

describe('editors on Windows', () => {
  const roots = windowsInstallRoots({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files' })

  test('install roots are per user first, then per machine', () => {
    expect(roots).toEqual(['C:\\Users\\me\\AppData\\Local\\Programs', 'C:\\Program Files'])
  })

  test('VS Code opens through Code.exe, not the code.cmd that Node cannot start', () => {
    const vscode = editorApp('vscode')!
    const files = installFiles(['C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'])
    expect(windowsEditorProgram(vscode, roots, files)).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe')
    expect(windowsEditorProgram(vscode, roots, installFiles([]))).toBeNull()
  })

  test('a JetBrains IDE is found in its versioned folder, newest first', () => {
    const idea = editorApp('intellij')!
    const files = installFiles([
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.3\\bin\\idea64.exe',
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.10\\bin\\idea64.exe',
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.9\\bin\\idea64.exe',
    ])
    expect(windowsEditorProgram(idea, roots, files)).toBe('C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.10\\bin\\idea64.exe')
  })

  test('terminal editors run in the terminal and have no Windows program', () => {
    for (const app of EDITOR_APPS.filter((editor) => editor.isTerminal)) {
      expect(windowsEditorProgram(app, roots, installFiles([`C:\\Program Files\\${app.name}\\${app.bin}.exe`]))).toBeNull()
    }
  })
})

describe('Open in terminal on Windows', () => {
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

  test('Windows Terminal opens PowerShell in the folder and runs the command', () => {
    const launch = windowsTerminalLaunch({ windowsTerminal: 'C:\\wt.exe', powershell }, "claude --resume 'abc'", 'C:\\code\\repo')
    expect(launch).toEqual({
      file: 'C:\\wt.exe',
      args: ['-d', 'C:\\code\\repo', powershell, '-NoExit', '-Command', "claude --resume 'abc'"],
      name: 'Windows Terminal',
    })
  })

  test('a semicolon stays in the command instead of splitting the Windows Terminal line', () => {
    // WHY: wt.exe reads `;` as "open another tab" whatever the quoting.
    const launch = windowsTerminalLaunch({ windowsTerminal: 'C:\\wt.exe', powershell }, 'vim "a;b.txt"', undefined)
    expect(launch.args).toEqual([powershell, '-NoExit', '-Command', 'vim "a\\;b.txt"'])
  })

  test('without Windows Terminal, PowerShell opens its own console; an empty command opens a shell', () => {
    expect(windowsTerminalLaunch({ windowsTerminal: null, powershell }, '', 'C:\\code')).toEqual({
      file: powershell,
      args: ['-NoExit'],
      name: 'PowerShell',
    })
  })
})

describe('taskbar badge on Windows', () => {
  const pixel = (bitmap: Buffer, x: number, y: number) => [...bitmap.subarray((y * BADGE_PIXELS + x) * 4, (y * BADGE_PIXELS + x) * 4 + 4)]

  test('the overlay is a raster image, because Electron cannot decode an SVG one', () => {
    // WHY: an SVG data URL gave an empty image, so Windows showed no count at all.
    const bitmap = badgeBitmap('3')
    expect(bitmap.length).toBe(BADGE_PIXELS * BADGE_PIXELS * 4)
    expect(pixel(bitmap, 0, 0)[3]).toBe(0)
    expect(pixel(bitmap, 4, BADGE_PIXELS / 2)).toEqual([0x4d, 0x48, 0xe5, 0xff])
    expect(bitmap.includes(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toBe(true)
  })

  test('a count above nine reads 9+', () => {
    expect(badgeLabel(4)).toBe('4')
    expect(badgeLabel(12)).toBe('9+')
  })
})
