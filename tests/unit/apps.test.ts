import { describe, expect, test } from 'bun:test'
import {
  appDescriptorSchema,
  appOperationCallName,
  appSlugOf,
  appStorageCallName,
  describeAppPermissions,
  parseAppCallName,
} from '@solus/contracts/apps'
import { wrapSandboxDocument } from '@solus/contracts/artifact-sandbox'
import { webhookActionSchema } from '@solus/contracts/webhooks'

const descriptor = (extra: object = {}) => ({
  solusApp: 2,
  name: 'Notes',
  operations: [
    { name: 'list', kind: 'query', input: { type: 'object' } },
    { name: 'add', kind: 'mutation', input: { type: 'object' } },
  ],
  ...extra,
})

describe('the app descriptor', () => {
  test('a descriptor fills what the build left out', () => {
    expect(appDescriptorSchema.parse(descriptor())).toMatchObject({
      description: '',
      permissions: { network: [], files: { read: [], write: [] } },
      integrations: [],
      secrets: [],
      schedules: [],
      webhooks: [],
    })
  })

  test('a schedule and a webhook run a mutation of the app, never a query and never a name it does not have', () => {
    // WHY: a schedule and a webhook run with no person there. A query that
    // "runs on a schedule" changes nothing, and a missing name fails at 3 a.m.
    const schedule = (run: string) => appDescriptorSchema.safeParse(descriptor({ schedules: [{ name: 'nightly', trigger: { type: 'interval', everyMinutes: 60 }, run }] }))
    expect(schedule('add').success).toBe(true)
    expect(schedule('list').error?.issues[0]?.message).toBe('The schedule nightly runs list, which is not a mutation of this app.')
    expect(schedule('gone').success).toBe(false)
    const webhook = (run: string) => appDescriptorSchema.safeParse(descriptor({ webhooks: [{ name: 'pushed', verify: { scheme: 'standard_webhooks' }, run }] }))
    expect(webhook('add').success).toBe(true)
    expect(webhook('list').error?.issues[0]?.message).toBe('The webhook pushed runs list, which is not a mutation of this app.')
  })

  test('two operations cannot have one name', () => {
    const repeated = appDescriptorSchema.safeParse(descriptor({ operations: [{ name: 'add', kind: 'query', input: {} }, { name: 'add', kind: 'mutation', input: {} }] }))
    expect(repeated.error?.issues[0]?.message).toBe('The name add is used twice.')
  })

  test('a name is one a program can write, and a slug is one an address can hold', () => {
    expect(appDescriptorSchema.safeParse(descriptor({ operations: [{ name: 'list notes', kind: 'query', input: {} }] })).success).toBe(false)
    expect(appSlugOf('  My Notes! (v2) ')).toBe('my-notes-v2')
    expect(appSlugOf('日本')).toBe('app')
    expect(appSlugOf('x'.repeat(80))).toHaveLength(48)
  })
})

describe('what an app may use, in one sentence', () => {
  test('the sentence says only what the app has', () => {
    expect(describeAppPermissions({ network: [], files: { read: [], write: [] } }, false)).toBeNull()
    expect(describeAppPermissions({ network: [], files: { read: [], write: [] } }, true)).toBe('This app runs its own code on this host.')
    expect(describeAppPermissions({ network: ['api.example.com'], files: { read: [], write: [] } }, false)).toBe('This app reaches api.example.com.')
    expect(describeAppPermissions({ network: ['*'], files: { read: ['~/Documents'], write: ['*'] } }, true))
      .toBe('This app runs its own code on this host, reads ~/Documents, writes every file, and reaches every network host.')
    // File paths mean nothing with no backend to use them.
    expect(describeAppPermissions({ network: [], files: { read: ['*'], write: [] } }, false)).toBeNull()
  })
})

describe('the names a UI puts on the wire', () => {
  test('a call name addresses an operation, the storage, or an integration tool, and nothing else', () => {
    expect(parseAppCallName(appOperationCallName('list'))).toEqual({ kind: 'operation', name: 'list' })
    expect(parseAppCallName(appStorageCallName('set'))).toEqual({ kind: 'storage', operation: 'set' })
    expect(parseAppCallName('linear/list_issues')).toEqual({ kind: 'tool', slug: 'linear', tool: 'list_issues' })
    expect(parseAppCallName('@storage/drop')).toBeNull()
    expect(parseAppCallName('@app/')).toBeNull()
    expect(parseAppCallName('@app/a b')).toBeNull()
    // The earlier model's name for a host function addresses nothing now.
    expect(parseAppCallName('@server/rows')).toBeNull()
    expect(parseAppCallName('noslash')).toBeNull()
  })
})

describe('the app frame', () => {
  const page = '<div id="root"></div>'

  test('a frame is an app frame because its host says so, never because of what the page holds', () => {
    // WHY: the third model read a block in the page. A page must not be able
    // to give itself a bridge to the host.
    const lookalike = `${page}<script type="application/json" id="solus-app">{"solusApp":1}</script>`
    const plain = wrapSandboxDocument(lookalike, '')
    expect(plain).not.toContain('window.solusApp =')
    expect(plain.startsWith('<!doctype html>')).toBe(false)
    const app = wrapSandboxDocument(page, '', false, { network: ['api.example.com'] })
    expect(app.startsWith('<!doctype html>')).toBe(true)
    expect(app).toContain('window.solusApp =')
    expect(app).toContain('https://api.example.com')
  })

  test('an app frame draws with the workspace\'s own chrome and type base, and a render does not', () => {
    // WHY: an app is a pane of Solus. With the render palette and a 14px root,
    // its hairlines, hover wash, and focus ring differ from the panes beside
    // it, and every rem size is an eighth smaller than the workspace's.
    const app = wrapSandboxDocument(page, '', false, { network: [] })
    for (const declaration of ['--border:var(--solus-container-border)', '--muted:var(--solus-surface-hover)', '--ring:var(--solus-input-focus-border)', '--primary:var(--solus-accent)', '--sidebar:var(--solus-sidebar-bg)', '--radius:0.5rem', 'html{font-size:16px}', 'body{font-size:0.875rem']) {
      expect(app).toContain(declaration)
    }
    // It comes after the theme stylesheet, so it wins and a theme change does not remove it.
    expect(app.indexOf('--border:var(--solus-container-border)')).toBeGreaterThan(app.indexOf('id="solus-artifact-theme"'))
    expect(wrapSandboxDocument(page, '')).not.toContain('--solus-container-border)')
  })

  test('the bridge tells the UI when the app\'s data changed', () => {
    // WHY: a schedule or an agent changes an app with no UI in the loop; an open UI must read again.
    const app = wrapSandboxDocument(page, '', false, { network: [] })
    expect(app).toContain('data.type === "solus-app-event"')
    expect(app).toContain('on: function(listener)')
  })
})

describe('a webhook that calls an app', () => {
  test('the action names an app and a mutation, and has no prompt', () => {
    const action = { id: 'app', type: 'call_app', enabled: true, filters: [], template: '', appId: 'app-1', operation: 'add' }
    expect(webhookActionSchema.parse(action)).toEqual(action)
    expect(webhookActionSchema.safeParse({ ...action, operation: '' }).success).toBe(false)
  })
})
