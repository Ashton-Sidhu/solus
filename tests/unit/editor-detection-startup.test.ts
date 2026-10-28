import { expect, mock, test } from 'bun:test'
import { tmpdir } from 'os'
import type { DetectedEditor, DetectedTerminal } from '@solus/contracts/types'
import { EDITOR_APPS } from '../../apps/desktop/src/main/editor-apps'
import { DatabaseSync } from './helpers/bun-sqlite'

interface DetectedTools { editors: DetectedEditor[]; terminals: DetectedTerminal[] }

// Each platform's detection is its adapter's (apps/desktop/src/main/platform);
// these give it a fake PATH and fake app bundles, so macOS and Linux are both
// checked on any machine.
let finishPath!: (path: string) => void
const bootPath = new Promise<string>((resolve) => { finishPath = resolve })
const probes: Array<{ bin: string; path: string }> = []
let bundles: string[] = []

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  dialog: {},
  shell: {},
  utilityProcess: { fork: () => ({ on() {}, postMessage() {}, kill() {} }) },
  Menu: {},
  desktopCapturer: {},
  nativeImage: {},
  screen: {},
}))
mock.module('node:sqlite', () => ({ DatabaseSync }))
const cliEnv = await import('@solus/server/cli-env')
mock.module('@solus/server/cli-env', () => ({
  ...cliEnv,
  warmCliPath: () => bootPath,
  findOnPath: (bin: string, path: string) => {
    probes.push({ bin, path })
    return bin === 'code' || bin === 'nvim' || bin === 'ghostty' ? `/login/bin/${bin}` : null
  },
}))
mock.module('@solus/desktop-main/mac-apps', () => ({
  findAppBundle: (name: string) => (bundles.includes(name) ? `/Applications/${name}` : null),
}))
const { linuxTerminalApps } = await import('@solus/desktop-main/platform/linux-terminal')
mock.module('@solus/desktop-main/platform/linux-terminal', () => ({
  // Some terminal can fill the default role on this Linux machine.
  linuxTerminalApps: { ...linuxTerminalApps, available: async () => ({ id: 'ghostty' }) },
}))

const { desktopPlatformFor } = await import('@solus/desktop-main/platform/desktop-platform')
const { registerFileHandlers } = await import('@solus/desktop-main/server/handlers/file-handlers')

async function detected(platform: 'darwin' | 'linux', path: string): Promise<DetectedTools> {
  const adapter = desktopPlatformFor(platform)
  return {
    editors: EDITOR_APPS.map((app) => adapter.editors.detect(app, path)).filter((editor): editor is DetectedEditor => !!editor),
    terminals: await adapter.terminal.detect(path),
  }
}

test('cold editor detection waits for the async boot PATH rather than probing the login shell again', async () => {
  // WHY: a probe before the boot PATH resolves would start a second, blocking login-shell probe.
  let detect!: () => Promise<DetectedTools>
  const server = { register(method: string, handler: () => Promise<DetectedTools>) { if (method === 'detectEditors') detect = handler } }
  // SAFETY: the stub implements the one `register` method these handlers call.
  registerFileHandlers(server as unknown as Parameters<typeof registerFileHandlers>[0], {} as Parameters<typeof registerFileHandlers>[1])
  const pending = detect()
  await Promise.resolve()
  expect(probes).toEqual([])
  finishPath('/login/bin:/usr/bin')
  await pending
  expect(probes.length).toBeGreaterThan(0)
  expect(probes.every((probe) => probe.path === '/login/bin:/usr/bin')).toBe(true)
})

test('macOS counts an installed app bundle as an editor even without its shell command', async () => {
  bundles = ['PyCharm.app', 'Ghostty.app']
  const tools = await detected('darwin', '/login/bin:/usr/bin')
  expect(tools.editors.map((editor) => editor.id)).toEqual(['vscode', 'pycharm', 'nvim'])
  expect(tools.editors.find((editor) => editor.id === 'pycharm')?.binPath).toBeNull()
  expect(tools.terminals.map((terminal) => terminal.id)).toEqual(['default-terminal', 'ghostty'])
})

test('Linux detection keeps terminal editors, installed terminal commands, and the default terminal', async () => {
  bundles = []
  const tools = await detected('linux', '/login/bin:/usr/bin')
  expect(tools.editors.map((editor) => editor.id)).toEqual(['vscode', 'nvim'])
  expect(tools.terminals.map((terminal) => terminal.id)).toEqual(['default-terminal', 'ghostty'])
})
