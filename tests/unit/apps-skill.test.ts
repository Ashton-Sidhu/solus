import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { initApp } from '../../resources/plugins/solus/skills/create-app/scripts/init-app.mjs'
import { assembleHtml } from '../../resources/plugins/solus/skills/visual-artifacts/scripts/bundle-artifact.mjs'
import { APP_FILE_CHUNK_BYTES, APP_PROTOCOL, appDescriptorSchema, parseAppCallName } from '@solus/contracts/apps'
import { defineApp, mutation, query, signal, webhookRequest, workflow, NonRetryableError } from '../../resources/plugins/solus/skills/visual-artifacts/assets/react/src/solus-app-backend'

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

  test('the template writes the protocol the host runs now, with what the fifth model adds', () => {
    // WHY: the template and the host share no code. A template that writes a
    // protocol the host does not run fails every deploy, and a field the
    // contract does not read is lost with no message.
    const definition = defineApp({
      name: 'Reports',
      instructions: 'Call list first.',
      signals: { 'report.ready': signal({ description: 'A report is ready.', payload: z.object({ title: z.string() }) }) },
      operations: {
        list: query({ output: z.array(z.object({ title: z.string() })) }, () => []),
        importCsv: mutation({ input: z.object({ fileId: z.string() }), timeoutSeconds: 300 }, () => null),
      },
      workflows: { build: workflow({ description: 'Makes one report.', input: z.object({ title: z.string() }) }, async () => null) },
    })
    const read = appDescriptorSchema.parse(definition.descriptor())
    expect(read.solusApp).toBe(APP_PROTOCOL)
    expect(read.instructions).toBe('Call list first.')
    expect(read.signals).toEqual([{ name: 'report.ready', description: 'A report is ready.', payload: expect.objectContaining({ required: ['title'] }) }])
    expect(read.workflows).toEqual([{ name: 'build', description: 'Makes one report.', input: expect.objectContaining({ required: ['title'] }) }])
    expect(read.operations[0]?.output).toMatchObject({ type: 'array' })
    expect(read.operations[1]).toMatchObject({ timeoutSeconds: 300 })
    expect(read.operations[1]).not.toHaveProperty('output')
    // The runner tells this error from one that more attempts can help by its name.
    expect(new NonRetryableError('x').name).toBe('NonRetryableError')
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
    await app.files.list()
    await app.files.remove('file-1')
    expect(sent.map((call) => parseAppCallName(call.name))).toEqual([
      { kind: 'operation', name: 'list' },
      { kind: 'operation', name: 'save' },
      { kind: 'storage', operation: 'set' },
      { kind: 'storage', operation: 'get' },
      { kind: 'storage', operation: 'delete' },
      { kind: 'storage', operation: 'keys' },
      { kind: 'tool', slug: 'linear', tool: 'list_issues' },
      { kind: 'files', operation: 'list' },
      { kind: 'files', operation: 'remove' },
    ])
    expect(sent[0]?.args).toEqual({ limit: 5 })
  })

  test('a file crosses in parts that the server reads, and a file for the person goes to the client', async () => {
    // WHY: the template slices a file, and the server puts the parts
    // together. If the two do not agree on the size of a part or on a name,
    // every upload of every app fails.
    sent.length = 0
    const answers: { [name: string]: unknown } = { '@files/begin': { uploadId: 'u1' }, '@files/commit': { id: 'f1', name: 'big.bin', type: 'application/octet-stream', size: 0, createdAt: 0 }, '@files/read': { data: btoa('hello'), nextOffset: null } }
    // SAFETY: the module's host is this test's own object.
    ;(globalThis as unknown as { window: { solusApp: { call: (name: string, args: object) => Promise<unknown> } } }).window.solusApp.call = async (name, args) => {
      sent.push({ name, args })
      return answers[name] ?? null
    }
    const bytes = new Uint8Array(APP_FILE_CHUNK_BYTES + 10).fill(7)
    const progress: number[] = []
    await app.files.upload(new Blob([bytes]), 'big.bin', (fraction) => progress.push(fraction))
    expect(sent.map((call) => parseAppCallName(call.name))).toEqual([
      { kind: 'files', operation: 'begin' }, { kind: 'files', operation: 'chunk' }, { kind: 'files', operation: 'chunk' }, { kind: 'files', operation: 'commit' },
    ])
    expect(sent[0]?.args).toEqual({ name: 'big.bin', type: 'application/octet-stream', size: APP_FILE_CHUNK_BYTES + 10 })
    // SAFETY: a chunk call has these fields.
    const parts = sent.slice(1, 3).map((call) => call.args as { index: number; data: string })
    expect(parts.map((part) => [part.index, atob(part.data).length])).toEqual([[0, APP_FILE_CHUNK_BYTES], [1, 10]])
    expect(progress.at(-1)).toBe(1)

    sent.length = 0
    await app.files.saveAs('export.csv', 'a,b\n')
    expect(parseAppCallName(sent[0]?.name ?? '')).toEqual({ kind: 'client', operation: 'save' })
    expect(sent[0]?.args).toMatchObject({ name: 'export.csv', data: btoa('a,b\n') })
    expect(await (await app.files.read('f1')).text()).toBe('hello')
  })

  test('a tool path with no tool names nothing to call', async () => {
    await expect(app.tools.linear()).rejects.toThrow('names nothing to call')
  })

  test('the desktop capabilities are calls the client reads, and give typed errors (docs/plans/app-desktop-capabilities.md)', async () => {
    // WHY: outside a desktop app window an app must see that the capability is
    // absent, not wait on a call nobody answers; inside it, each call must be
    // a name the client answers, and a refusal an error the app can tell apart.
    // SAFETY: the module's host is this test's own object.
    const host = (globalThis as unknown as { window: { solusApp: { desktop?: boolean; call: (name: string, args: object) => Promise<unknown> } } }).window.solusApp
    expect(app.desktop.available).toBe(false)
    expect(await app.desktop.permission('camera')).toBe('unavailable')
    await expect(app.desktop.badge.set(2)).rejects.toBeInstanceOf(app.DesktopUnavailable)

    sent.length = 0
    host.desktop = true
    host.call = async (name, args) => {
      sent.push({ name, args })
      if (name === '@desktop/shortcut-register') {
        throw Object.assign(new Error('Alt+K is in use.'), { name: 'ShortcutTaken', failure: { code: 'ShortcutTaken', accelerator: 'Alt+K', message: 'Alt+K is in use.' } })
      }
      return null
    }
    try {
      await app.desktop.menuBar.setTitle('3 unread')
      await app.desktop.window.toggle()
      await app.desktop.notify({ title: 'Ready', route: '#/reports/1' })
      const taken = await app.desktop.shortcuts.register('Alt+K', () => {}).catch((error: unknown) => error)
      expect(taken).toBeInstanceOf(app.ShortcutTaken)
      expect(taken).toMatchObject({ accelerator: 'Alt+K' })
      expect(sent.map((call) => parseAppCallName(call.name))).toEqual([
        { kind: 'desktop', operation: 'menu-bar-title' },
        { kind: 'desktop', operation: 'window' },
        { kind: 'desktop', operation: 'notify' },
        { kind: 'desktop', operation: 'shortcut-register' },
      ])
    } finally {
      host.desktop = false
    }
  })

  test('system audio readies the capture, keeps only its audio, and names a block on macOS', async () => {
    // WHY: getDisplayMedia gives a video track too; an app asked for audio only. A macOS block must be an error the app can tell apart.
    // SAFETY: the module's host and the media devices are this test's own objects.
    const host = (globalThis as unknown as { window: { solusApp: { desktop?: boolean; call: (name: string, args: object) => Promise<unknown> } } }).window.solusApp
    const stopped: string[] = []
    const track = (kind: string) => ({ kind, stop: () => { stopped.push(kind) } })
    const tracks = [track('audio'), track('video')]
    const stream = {
      getVideoTracks: () => tracks.filter((entry) => entry.kind === 'video'),
      getAudioTracks: () => tracks.filter((entry) => entry.kind === 'audio'),
      removeTrack: (removed: { kind: string }) => { tracks.splice(tracks.indexOf(removed as never), 1) },
    }
    const navigatorHost = globalThis as unknown as { navigator: { mediaDevices?: { getDisplayMedia(options: object): Promise<unknown> } } }
    const devices = navigatorHost.navigator.mediaDevices
    navigatorHost.navigator.mediaDevices = { getDisplayMedia: async () => stream }
    sent.length = 0
    host.desktop = true
    let isBlocked = false
    host.call = async (name, args) => {
      sent.push({ name, args })
      if (isBlocked) throw Object.assign(new Error('Blocked.'), { name: 'SystemAudioBlocked', failure: { code: 'SystemAudioBlocked', message: 'Blocked.' } })
      return null
    }
    try {
      const captured = await app.desktop.audio.system()
      expect(captured.getAudioTracks()).toHaveLength(1)
      expect(captured.getVideoTracks()).toHaveLength(0)
      expect(stopped).toEqual(['video'])
      expect(sent.map((call) => parseAppCallName(call.name))).toEqual([{ kind: 'desktop', operation: 'system-audio' }])
      isBlocked = true
      await expect(app.desktop.audio.system()).rejects.toBeInstanceOf(app.SystemAudioBlocked)
    } finally {
      host.desktop = false
      navigatorHost.navigator.mediaDevices = devices
    }
  })
})

describe('the create-app skill and the project template', () => {
  const skills = join(import.meta.dir, '../../resources/plugins/solus/skills')
  const createApp = join(skills, 'create-app')
  const template = join(skills, 'visual-artifacts/assets/react')

  test('every module of Solus that the skill imports is a file the template has', () => {
    // WHY: an agent copies the skill's imports and the starter's. A name the
    // template does not resolve fails the build, or sends the agent to npm for
    // a package that is not there. The chapter named a control kit once; the kit is gone.
    const texts = [
      join(createApp, 'SKILL.md'),
      ...readdirSync(join(createApp, 'references')).map((name) => join(createApp, 'references', name)),
      join(createApp, 'assets/starter/app.ts'),
      ...readdirSync(join(createApp, 'assets/starter/src')).map((name) => join(createApp, 'assets/starter/src', name)),
    ].map((path) => readFileSync(path, 'utf8'))
    const config: { compilerOptions: { paths: { [name: string]: string[] } } } = JSON.parse(readFileSync(join(template, 'tsconfig.json'), 'utf8'))
    const imported = new Set(texts.flatMap((text) => [...text.matchAll(/from '(@solus\/[a-z/-]+)'/g)].map((match) => match[1]!)))

    expect([...imported].sort()).toEqual(['@solus/app', '@solus/app/backend'])
    for (const name of imported) {
      const file = config.compilerOptions.paths[name]?.[0]
      expect(file !== undefined && existsSync(join(template, file))).toBe(true)
    }
  })

  test('a new app project is the starter app on the template, ready to build', async () => {
    // WHY: an agent starts every app from what the initializer writes. If the
    // starter loses the template's build script, its modules, or its page
    // markers, the agent's first build fails before it writes any code.
    const directory = mkdtempSync(join(tmpdir(), 'solus-create-app-'))
    try {
      const project = await initApp(join(directory, 'notes'), { install: false })
      for (const file of ['app.ts', 'migrations/0001_notes.sql', 'src/App.tsx', 'src/schema.ts', 'src/solus-app.ts', 'src/solus-app-backend.ts', 'tsconfig.json', '.artifact/bundle-artifact.mjs']) {
        expect(existsSync(join(project, file))).toBe(true)
      }
      expect(readFileSync(join(project, 'src/App.tsx'), 'utf8')).toContain("appClient<typeof app>()")
      expect(() => assembleHtml(readFileSync(join(project, 'index.html'), 'utf8'), '', '')).not.toThrow()
      const manifest: { scripts: { bundle: string } } = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
      expect(manifest.scripts.bundle).toBe('node .artifact/bundle-artifact.mjs')
      await expect(initApp(project, { install: false })).rejects.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('the starter app declares what its UI calls, in a descriptor Solus reads', async () => {
    // WHY: the starter is the example every app copies. A starter that the
    // host refuses, or whose UI calls an operation it does not declare, teaches
    // each new app the same failure.
    const backend = join(template, 'src/solus-app-backend.ts')
    const built = await Bun.build({
      entrypoints: [join(createApp, 'assets/starter/app.ts')],
      target: 'node',
      format: 'cjs',
      plugins: [{ name: 'solus-app', setup: (build) => { build.onResolve({ filter: /^@solus\/app\/backend$/ }, () => ({ path: backend })) } }],
    })
    const directory = mkdtempSync(join(tmpdir(), 'solus-create-app-build-'))
    try {
      const file = join(directory, 'backend.cjs')
      writeFileSync(file, await built.outputs[0]!.text())
      const loaded = createRequire(file)(file)
      const read = appDescriptorSchema.parse((loaded.default ?? loaded).descriptor())
      expect(read.solusApp).toBe(APP_PROTOCOL)
      expect(read.operations.map((operation) => [operation.name, operation.kind])).toEqual([['list', 'query'], ['get', 'query'], ['add', 'mutation'], ['remove', 'mutation']])
      // An agent chooses the tool by its description and reads its output shape.
      for (const operation of read.operations) {
        expect(operation.description).not.toBe('')
        expect(operation.output).toBeDefined()
      }
      const ui = readFileSync(join(createApp, 'assets/starter/src/App.tsx'), 'utf8')
      const called = new Set([...ui.matchAll(/api\.(?:useQuery|mutate|query)\('([a-zA-Z]+)'/g)].map((match) => match[1]))
      expect([...called].sort()).toEqual(['add', 'get', 'list', 'remove'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
