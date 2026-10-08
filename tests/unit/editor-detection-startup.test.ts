import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { EDITOR_APPS } from '../../apps/desktop/src/main/editor-apps'
import { TERMINAL_APPS } from '../../apps/desktop/src/main/terminal-apps'
import type { DetectedEditor, DetectedTerminal } from '@solus/contracts/types'

interface DetectedTools { editors: DetectedEditor[]; terminals: DetectedTerminal[] }

function fixture(platform: 'darwin' | 'linux') {
  const source = readFileSync(new URL('../../apps/desktop/src/main/server/handlers/file-handlers.ts', import.meta.url), 'utf8')
  const handlerSource = source.slice(source.indexOf("  server.register('detectEditors'"), source.indexOf("  server.register('openInEditor'"))
  let detect!: () => Promise<DetectedTools>
  let finishPath!: (path: string) => void
  const path = new Promise<string>((resolve) => { finishPath = resolve })
  const probes: Array<{ bin: string; path: string }> = []
  const dependencies = {
    server: { register(_method: string, handler: () => Promise<DetectedTools>) { detect = handler } },
    log: { info() {} },
    warmCliPath: () => path,
    findOnPath: (bin: string, cliPath: string) => {
      probes.push({ bin, path: cliPath })
      return bin === 'code' || bin === 'nvim' || bin === 'ghostty' ? `/login/bin/${bin}` : null
    },
    findAppBundle: (name: string) => platform === 'darwin' && ['PyCharm.app', 'Ghostty.app'].includes(name) ? `/Applications/${name}` : null,
    EDITOR_APPS, TERMINAL_APPS,
    terminalDisplayName: () => platform === 'darwin' ? 'Terminal' : 'Default Terminal',
    process: { platform },
  }
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(handlerSource)
  new Function(...Object.keys(dependencies), executable)(...Object.values(dependencies))
  return { detect, probes, finishPath }
}

test('cold editor detection waits for the async boot PATH rather than probing the login shell again', async () => {
  const f = fixture('darwin')
  const pending = f.detect()
  expect(f.probes).toEqual([])
  f.finishPath('/login/bin:/usr/bin')
  const tools = await pending
  expect(tools.editors.map((editor) => editor.id)).toEqual(['vscode', 'pycharm', 'nvim'])
  expect(tools.editors.find((editor) => editor.id === 'pycharm')?.binPath).toBeNull()
  expect(tools.terminals.map((terminal) => terminal.id)).toEqual(['default-terminal', 'ghostty'])
  expect(f.probes.every((probe) => probe.path === '/login/bin:/usr/bin')).toBe(true)
})

test('Linux detection keeps terminal editors, installed terminal commands, and the default terminal', async () => {
  const f = fixture('linux')
  f.finishPath('/login/bin:/usr/bin')
  const tools = await f.detect()
  expect(tools.editors.map((editor) => editor.id)).toEqual(['vscode', 'nvim'])
  expect(tools.terminals.map((terminal) => terminal.id)).toEqual(['default-terminal', 'ghostty'])
})
