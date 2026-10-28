import { existsSync, readdirSync } from 'fs'
import { win32 } from 'path'
import type { EditorApp } from '@solus/desktop-main/editor-apps'

/** The folders Windows editors install under: per user first, then per machine. */
export function windowsInstallRoots(env: NodeJS.ProcessEnv): string[] {
  return [
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs'),
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
  ].filter((root): root is string => !!root)
}

/** The folder reads the Windows lookup needs. Tests pass their own. */
export interface InstallFiles {
  exists(file: string): boolean
  /** The names in a folder, or an empty list when it cannot be read. */
  list(dir: string): string[]
}

const diskInstallFiles: InstallFiles = {
  exists: existsSync,
  list(dir) {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
}

/**
 * A GUI editor's program in the Windows install folders, or null. The PATH
 * command of a Windows editor is a `.cmd` that Node cannot start, so the
 * program is the one to run. JetBrains IDEs live in a folder per version under
 * `JetBrains` (or `Programs` for the Toolbox); the newest one wins.
 */
export function windowsEditorProgram(app: EditorApp, roots: readonly string[], files: InstallFiles = diskInstallFiles): string | null {
  if (app.isTerminal) return null
  if (app.windowsProgram) {
    for (const root of roots) {
      const program = win32.join(root, app.windowsProgram)
      if (files.exists(program)) return program
    }
    return null
  }
  if (!app.isJetBrains) return null
  for (const root of roots) {
    for (const parent of [win32.join(root, 'JetBrains'), root]) {
      const versions = files.list(parent)
        .filter((name) => name === app.name || name.startsWith(`${app.name} `))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      for (const version of versions) {
        const program = win32.join(parent, version, 'bin', `${app.bin}64.exe`)
        if (files.exists(program)) return program
      }
    }
  }
  return null
}
