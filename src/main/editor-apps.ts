import type { EditorId } from '../shared/types'

/**
 * The editors Solus can open files with. An editor counts as installed when
 * either its shell command is on PATH or its application bundle is present —
 * most GUI editors ship their `code`-style command as an opt-in step, so
 * probing only the command hid apps the user plainly has.
 */
export interface EditorApp {
  id: EditorId
  name: string
  /** Shell command, preferred when installed. */
  bin: string
  /** Terminal editors open inside the shared tmux session instead of their own window. */
  isTerminal: boolean
  /** Arguments before the file paths. */
  args?: string[]
  /** Application bundle, used to detect and to open when `bin` is absent. */
  macAppBundle?: string
}

/** One JetBrains IDE. They differ only in name, command, and bundle. */
function jetbrains(id: EditorId, name: string, bin: string): EditorApp {
  return { id, name, bin, isTerminal: false, macAppBundle: `${name}.app` }
}

export const EDITOR_APPS: EditorApp[] = [
  { id: 'vscode', name: 'VS Code', bin: 'code', isTerminal: false, macAppBundle: 'Visual Studio Code.app' },
  { id: 'cursor', name: 'Cursor', bin: 'cursor', isTerminal: false, macAppBundle: 'Cursor.app' },
  { id: 'zed', name: 'Zed', bin: 'zed', isTerminal: false, macAppBundle: 'Zed.app' },
  { id: 'sublime', name: 'Sublime Text', bin: 'subl', isTerminal: false, macAppBundle: 'Sublime Text.app' },

  jetbrains('intellij', 'IntelliJ IDEA', 'idea'),
  jetbrains('pycharm', 'PyCharm', 'pycharm'),
  jetbrains('webstorm', 'WebStorm', 'webstorm'),
  jetbrains('goland', 'GoLand', 'goland'),
  jetbrains('datagrip', 'DataGrip', 'datagrip'),
  jetbrains('dataspell', 'DataSpell', 'dataspell'),
  jetbrains('phpstorm', 'PhpStorm', 'phpstorm'),
  jetbrains('rubymine', 'RubyMine', 'rubymine'),

  { id: 'vim', name: 'Vim', bin: 'vim', isTerminal: true },
  { id: 'nvim', name: 'Neovim', bin: 'nvim', isTerminal: true },
  { id: 'helix', name: 'Helix', bin: 'hx', isTerminal: true },
  // Without -nw a GUI build detaches into its own window and the tmux pane exits
  // immediately, which reads as "nothing happened".
  { id: 'emacs', name: 'Emacs', bin: 'emacs', isTerminal: true, args: ['-nw'] },
]

export function editorApp(id: EditorId): EditorApp | undefined {
  return EDITOR_APPS.find((app) => app.id === id)
}
