import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { appDescriptorSchema, parseAppCallName } from '@solus/contracts/apps'
import { defineApp, mutation, query, webhookRequest } from '../../resources/plugins/solus/skills/visual-artifacts/assets/react/src/solus-app-backend'

/**
 * An app is built by the visual-artifacts skill on the agent's side and run by
 * Solus. The two sides share no code: the project's `@solus/app/backend`
 * module writes a descriptor that the contract reads, and its `@solus/app`
 * module posts names that the server reads. These tests hold the two copies
 * together.
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
  test('the descriptor the project\'s module writes is a descriptor Solus reads', () => {
    // WHY: a deploy refuses a descriptor the contract does not read, so an
    // app that an agent wrote by the skill's own chapter must pass.
    const definition = defineApp({
      name: 'Issue inbox',
      description: 'Issues and the mail that names them.',
      permissions: { network: ['api.example.com'], files: { read: ['~/Documents'] } },
      integrations: ['linear'],
      secrets: { database: { label: 'Database URL' } },
      operations: {
        list: query({ description: 'The newest issues.', input: z.object({ limit: z.number().int().default(20) }) }, () => []),
        save: mutation({ description: 'Save an issue.', input: z.object({ title: z.string() }) }, () => null),
        received: mutation({ input: webhookRequest }, () => null),
      },
      schedules: {
        sync: { every: { minutes: 15 }, run: 'save', input: { title: 'sync' } },
        digest: { cron: '0 9 * * 1-5', timezone: 'America/Toronto', run: 'save' },
      },
      webhooks: {
        opened: {
          verify: { scheme: 'hmac', algorithm: 'sha256', signedText: '{{body}}', signature: { source: { kind: 'header', name: 'x-hub-signature-256' }, format: { encoding: 'hex', prefix: 'sha256=' } } },
          replayKey: '{{headers.x-github-delivery}}',
          run: 'received',
        },
      },
    })
    const read = appDescriptorSchema.parse(definition.descriptor())
    expect(read).toMatchObject({
      name: 'Issue inbox',
      permissions: { network: ['api.example.com'], files: { read: ['~/Documents'], write: [] } },
      integrations: ['linear'],
      secrets: [{ name: 'database', label: 'Database URL', description: '' }],
      schedules: [
        { name: 'sync', trigger: { type: 'interval', everyMinutes: 15 }, run: 'save', input: { title: 'sync' } },
        { name: 'digest', trigger: { type: 'cron', expr: '0 9 * * 1-5', timezone: 'America/Toronto' }, run: 'save', input: {} },
      ],
      webhooks: [{ name: 'opened', replayKey: '{{headers.x-github-delivery}}', run: 'received' }],
    })
    expect(read.operations.map((operation) => [operation.name, operation.kind])).toEqual([['list', 'query'], ['save', 'mutation'], ['received', 'mutation']])
    // An agent's tool takes the operation's own input: a field with a default may be left out.
    expect(read.operations[0]?.input).toMatchObject({ type: 'object', properties: { limit: { type: 'integer', default: 20 } } })
    expect(read.operations[1]?.input).toMatchObject({ required: ['title'] })
  })

  test('an app with no operation has an empty descriptor, not an error', () => {
    expect(appDescriptorSchema.parse(defineApp({ name: 'Board' }).descriptor())).toMatchObject({ name: 'Board', operations: [] })
  })
})

describe('the names the project\'s module posts', () => {
  test('every call the module makes is a name the server reads', async () => {
    // WHY: the module and the server spell the names apart. A name the server
    // does not read fails every call of every app.
    await app.query('list', { limit: 5 })
    await app.mutate('save', { title: 'A' })
    await app.storage.set('view', { sort: 'new' })
    await app.storage.get('view')
    await app.storage.delete('view')
    await app.storage.keys()
    await app.tools.linear.list_issues({ team: 'ENG' })
    expect(sent.map((call) => parseAppCallName(call.name))).toEqual([
      { kind: 'operation', name: 'list' },
      { kind: 'operation', name: 'save' },
      { kind: 'storage', operation: 'set' },
      { kind: 'storage', operation: 'get' },
      { kind: 'storage', operation: 'delete' },
      { kind: 'storage', operation: 'keys' },
      { kind: 'tool', slug: 'linear', tool: 'list_issues' },
    ])
    expect(sent[0]?.args).toEqual({ limit: 5 })
  })

  test('a tool path with no tool names nothing to call', async () => {
    await expect(app.tools.linear()).rejects.toThrow('names nothing to call')
  })
})

describe('the chapter and the project template', () => {
  test('every module of Solus that the chapter imports is a file the template has', () => {
    // WHY: an agent copies the chapter's imports. A name the template does not
    // resolve fails the build, or sends the agent to npm for a package that is
    // not there. The chapter named a control kit once; the kit is gone.
    const skill = join(import.meta.dir, '../../resources/plugins/solus/skills/visual-artifacts')
    const chapter = readFileSync(join(skill, 'references/apps.md'), 'utf8')
    const config: { compilerOptions: { paths: { [name: string]: string[] } } } = JSON.parse(readFileSync(join(skill, 'assets/react/tsconfig.json'), 'utf8'))
    const imported = new Set([...chapter.matchAll(/from '(@solus\/[a-z/-]+)'/g)].map((match) => match[1]!))

    expect([...imported].sort()).toEqual(['@solus/app', '@solus/app/backend'])
    for (const name of imported) {
      const file = config.compilerOptions.paths[name]?.[0]
      expect(file !== undefined && existsSync(join(skill, 'assets/react', file))).toBe(true)
    }
  })
})
