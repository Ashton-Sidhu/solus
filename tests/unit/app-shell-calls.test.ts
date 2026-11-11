import { describe, expect, test } from 'bun:test'
import { appFunctionCallName, appStorageCallName, parseAppCallName } from '@solus/contracts/apps'
import { createStorage } from '../../packages/app-shell/src/app-storage'
import type { ToolArguments, ToolValue } from '../../packages/app-shell/src/host-bridge'
import { createCallProxy, functionWireName, SERVER_ROOT, TOOLS_ROOT, toolWireName } from '../../packages/app-shell/src/tools-proxy'

/**
 * The shell is built on its own and does not import the contracts, so the
 * names it puts on the wire are written twice. These tests hold the two
 * copies together: a name the server cannot read is a call that goes nowhere.
 */
describe('the shell\'s call names', () => {
  test('storage sends the names the server reads as storage operations', async () => {
    const sent: Array<{ name: string; args: ToolArguments }> = []
    const storage = createStorage(async (name, args) => {
      sent.push({ name, args })
      return name.endsWith('keys') ? ['a', 'b'] : null
    })
    await storage.get('todos')
    await storage.set('todos', [1])
    await storage.delete('todos')
    expect(await storage.keys()).toEqual(['a', 'b'])
    expect(sent).toEqual([
      { name: appStorageCallName('get'), args: { key: 'todos' } },
      { name: appStorageCallName('set'), args: { key: 'todos', value: [1] } },
      { name: appStorageCallName('delete'), args: { key: 'todos' } },
      { name: appStorageCallName('keys'), args: {} },
    ])
  })

  test('server.<function> and tools.<integration>.<tool> send names the server reads as a host function and an integration tool', async () => {
    const calls: string[] = []
    const answer = async (name: string): Promise<ToolValue> => {
      calls.push(name)
      return null
    }
    const server = createCallProxy(SERVER_ROOT, ({ path }) => answer(functionWireName(path)))
    const tools = createCallProxy(TOOLS_ROOT, ({ path }) => answer(toolWireName(path)))
    await server.tables({ db: 'main' })
    await tools.linear.list_issues({ team: 'ENG' })
    expect(calls).toEqual([appFunctionCallName('tables'), 'linear/list_issues'])
    expect(parseAppCallName(calls[0])).toEqual({ kind: 'function', name: 'tables' })
    expect(parseAppCallName(calls[1])).toEqual({ kind: 'tool', slug: 'linear', tool: 'list_issues' })
  })

  test('a path too short to name a call fails with what to write, and the query helpers key by path', async () => {
    const tools = createCallProxy(TOOLS_ROOT, async () => null)
    const server = createCallProxy(SERVER_ROOT, async () => null)
    await expect(tools.linear()).rejects.toThrow('tools.<integration>.<tool>(args)')
    await expect(server()).rejects.toThrow('server.<function>(input)')
    // A host function is callable at depth one, so its helpers are there too.
    expect(server.tables.queryKey({ db: 'main' })).toEqual(['solus-server', 'tables', { args: { db: 'main' }, type: 'query' }])
    expect(tools.linear.list_issues.pathFilter()).toEqual({ queryKey: ['solus-tools', 'linear', 'list_issues'] })
  })
})
