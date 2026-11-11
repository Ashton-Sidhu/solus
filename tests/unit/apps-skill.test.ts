import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appFunctionCallName, appManifestBlock as contractManifestBlock, appManifestSchema, appStorageCallName, parseAppCallName, readAppPage } from '@solus/contracts/apps'
// @ts-expect-error The skill's scripts are plain JavaScript modules that agents run with Node.
import { appManifestBlock, collectSources, integrationsOf } from '../../resources/plugins/solus/skills/visual-artifacts/scripts/bundle-artifact.mjs'

/**
 * An app is built by the visual-artifacts skill on the agent's side and run by
 * Solus. The two sides share no code: the build writes a manifest that the
 * contract reads, and the project's `@solus/app` module posts names that the
 * server reads. These tests hold the two copies together.
 */
type AppModule = typeof import('../../resources/plugins/solus/skills/visual-artifacts/assets/react/src/solus-app')

const sent: Array<{ name: string; args: object }> = []
let app: AppModule

beforeAll(async () => {
  // The module reaches its host through the one function Solus puts in an app's page.
  Object.assign(globalThis, { window: { solusApp: { call: async (name: string, args: object) => { sent.push({ name, args }); return null } } } })
  app = await import('../../resources/plugins/solus/skills/visual-artifacts/assets/react/src/solus-app')
})
afterAll(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('the app build and the contract', () => {
  test('the manifest block the build writes is the block Solus reads', () => {
    // WHY: a page whose block Solus cannot read is saved as a plain artifact,
    // with an open network and no host behind it.
    const manifest = { solusApp: 1, permissions: { network: ['api.example.com'] }, integrations: ['linear'], server: 'exports.page = async () => "</script>"', sources: { 'src/App.tsx': 'a < b' } }
    const block: string = appManifestBlock(manifest)
    expect(block).toBe(contractManifestBlock(appManifestSchema.parse(manifest)).replace('"permissions":{"tools":"all","writes":"ask","network":["api.example.com"],"files":{"read":[],"write":[]}}', '"permissions":{"network":["api.example.com"]}'))
    expect(block.split('</script>')).toHaveLength(2)
    expect(readAppPage(`<body></body>${block}`)).toMatchObject({ kind: 'app', manifest: { integrations: ['linear'], server: manifest.server, permissions: { network: ['api.example.com'], writes: 'ask' } } })
  })

  test('the build reads integrations from the page\'s code, not from comments or another object\'s field', () => {
    // WHY: the server cannot read them from built code, so the manifest's
    // list is the only list. A slug in a comment would ask the viewer to connect a service the app never uses.
    const code = `
      import { tools } from '@solus/app'
      // tools.github.create_issue is in a comment
      const a = tools.linear.list_issues({}); const b = tools["slack"].post_message; const c = other.tools.jira
    `
    expect(integrationsOf(code)).toEqual(['linear', 'slack'])
  })

  test('an app carries the project\'s own sources and not the template\'s files or its packages', async () => {
    // WHY: a later session rebuilds the app from these. The template's files are in every new project already.
    const project = mkdtempSync(join(tmpdir(), 'solus-app-project-'))
    try {
      mkdirSync(join(project, 'src/parts'), { recursive: true })
      mkdirSync(join(project, 'node_modules/pkg'), { recursive: true })
      writeFileSync(join(project, 'package.json'), '{}')
      writeFileSync(join(project, 'app.json'), '{}')
      writeFileSync(join(project, 'index.html'), '<title>App</title>')
      writeFileSync(join(project, 'server.ts'), 'export async function rows() { return [] }')
      writeFileSync(join(project, 'src/App.tsx'), 'export default function App() { return null }')
      writeFileSync(join(project, 'src/parts/Row.tsx'), 'export function Row() { return null }')
      writeFileSync(join(project, 'src/solus-app.ts'), 'export const storage = {}')
      writeFileSync(join(project, 'src/logo.png'), 'not text')
      writeFileSync(join(project, 'node_modules/pkg/index.js'), 'module.exports = 1')
      expect(Object.keys(await collectSources(project))).toEqual(['package.json', 'app.json', 'index.html', 'server.ts', 'src/App.tsx', 'src/parts/Row.tsx'])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

describe('the project\'s @solus/app module', () => {
  test('storage, server, and tools post the call names the server reads', async () => {
    // WHY: a name the server cannot read is a call that goes nowhere.
    sent.length = 0
    await app.storage.get('todos')
    await app.storage.set('todos', [1])
    await app.storage.delete('todos')
    await app.storage.keys()
    await app.server.tables({ db: 'main' })
    await app.tools.linear.list_issues({ team: 'ENG' })
    expect(sent).toEqual([
      { name: appStorageCallName('get'), args: { key: 'todos' } },
      { name: appStorageCallName('set'), args: { key: 'todos', value: [1] } },
      { name: appStorageCallName('delete'), args: { key: 'todos' } },
      { name: appStorageCallName('keys'), args: {} },
      { name: appFunctionCallName('tables'), args: { db: 'main' } },
      { name: 'linear/list_issues', args: { team: 'ENG' } },
    ])
    expect(sent.map(({ name }) => parseAppCallName(name)?.kind)).toEqual(['storage', 'storage', 'storage', 'storage', 'function', 'tool'])
  })

  test('a path too short to name a call fails with what to write, and awaiting a path does not hang', async () => {
    await expect(app.tools.linear()).rejects.toThrow('tools.<integration>.<tool>(args) names nothing to call.')
    await expect(app.server()).rejects.toThrow('server.<function>(input) names nothing to call.')
    // A proxy that answered `then` would be awaited forever.
    expect(await Promise.race([Promise.resolve(app.server.tables).then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('hung'), 50))])).toBe('settled')
  })
})
