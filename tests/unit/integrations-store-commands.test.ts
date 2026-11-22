import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { Integration, IntegrationAuthChoice, IntegrationConnection, IntegrationConnectSubmitRequest, IntegrationCreateRequest, IntegrationFacts } from '@solus/contracts/integration-types'
import { COMMAND_ADMIN_ONLY } from '@solus/contracts/integrations/command-server'
import type { AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'
import { singleHostServerConnections } from './helpers/server-connections-mock'
import { SvelteRunes } from './helpers/svelte-runes'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { mcpStore } = await import('@solus/workspace-ui/contexts/mcp')
const store = mcpStore.integrations
// The two forms hold runes: they run compiled on Svelte's client runtime, against the same store.
const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const file = SvelteRunes.file
const shared = {
  'svelte/reactivity': file('node_modules/svelte/src/reactivity/index-client.js'),
  '../../../contexts/mcp': file('packages/workspace-ui/src/contexts/mcp/index.ts'),
  '@solus/contracts/integrations/command-line': file('packages/contracts/src/integrations/command-line.ts'),
  '@solus/contracts/integrations/command-server': file('packages/contracts/src/integrations/command-server.ts'),
  '@solus/contracts/integrations/integration-sign-in': file('packages/contracts/src/integrations/integration-sign-in.ts'),
  '@solus/contracts/integrations/setup-handoff': file('packages/contracts/src/integrations/setup-handoff.ts'),
}
// Both compile before the first import: Bun reads the folder once.
const commandModule = runes.source('mcp-command', 'packages/workspace-ui/src/components/settings/lib/mcp-command.svelte.ts', shared)
const addressModule = runes.source('mcp-address-form', 'packages/workspace-ui/src/components/settings/lib/mcp-address-form.svelte.ts', {
  ...shared,
  '@solus/contracts/integrations/auth-choice': file('packages/contracts/src/integrations/auth-choice.ts'),
  './integration-labels': file('packages/workspace-ui/src/components/settings/lib/integration-labels.ts'),
})
const connectModule = runes.source('mcp-connect', 'packages/workspace-ui/src/components/settings/lib/mcp-connect.svelte.ts', {
  ...shared,
  './integration-labels': file('packages/workspace-ui/src/components/settings/lib/integration-labels.ts'),
  './mcp-command.svelte': commandModule,
  './mcp-address-form.svelte': addressModule,
})
const { McpCommandForm } = await import(commandModule) as typeof import('@solus/workspace-ui/components/settings/lib/mcp-command.svelte')
const { McpConnect } = await import(connectModule) as typeof import('@solus/workspace-ui/components/settings/lib/mcp-connect.svelte')
type Catalog = ConstructorParameters<typeof McpConnect>[2]

// docs/plans/mcp-first-class.md §7.7 on desktop and web: a command in
// Settings → MCP. A value is a secret and never stays in client state; a
// person without host.admin cannot add or change a command from a client; the
// process state follows the host's events, so a second client is never stale.

const SECRET = 'ghp_secret_value_never_kept'
const capabilities = { prompts: false, resources: false, resourceSubscribe: false, tasks: false }
const facts = (process: IntegrationFacts['process'], era: IntegrationFacts['era'] = null): IntegrationFacts => ({ era, instructions: null, capabilities, process })
const command = (id: string, names: string[] = []): Integration => ({
  id, organizationId: 'local', ownerKey: 'local:test', kind: 'stdio', slug: id, name: id, url: 'stdio:0123456789abcdef',
  auth: names.length ? { kind: 'env', names } : { kind: 'none' }, launch: { command: 'npx', args: ['-y', `${id}-mcp`] },
  disabledTools: [], createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z',
})
const connected = (integrationId: string): IntegrationConnection => ({ integrationId, accountId: 'default', status: 'connected', source: 'host', label: null, info: null, error: null, updatedAt: '' })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
/** Everything the store holds for a host, as text, to look for a value in. */
function stateText(serverId: string): string {
  const state = store.states.get(serverId)
  return JSON.stringify({ ...state, processes: undefined, flows: [...(state?.connectFlows ?? [])], connections: [...(state?.connections ?? [])], errors: (state?.integrations ?? []).map((integration) => state?.processes.errorOf(integration.id)) })
}
// The command form never reads the catalog.
const noCatalog = {} as Catalog

describe('environment values of a command', () => {
  test('Connect on a command asks for its values, and a saved value stays nowhere in the store, after a save or a refusal', async () => {
    const submitted: IntegrationConnectSubmitRequest[] = []
    let refuse = true
    const connectionsOnHost: IntegrationConnection[] = []
    connections.registerHost('values', {
      integrationList: async () => [command('files', ['GITHUB_TOKEN'])],
      integrationConnectionList: async () => [...connectionsOnHost],
      integrationFacts: async () => facts({ state: 'stopped' }),
      integrationConnectStart: async ({ id }: { id: string }) => ({ kind: 'env', integrationId: id, names: ['GITHUB_TOKEN'] }),
      integrationConnectSubmit: async (request: IntegrationConnectSubmitRequest) => {
        submitted.push(request)
        if (refuse) throw new Error('Give a value for GITHUB_TOKEN.')
        connectionsOnHost.push(connected('files'))
        return { connected: true }
      },
    })
    await store.load('values')
    await flush()
    await store.connect('values', 'files')
    expect(store.connectFlow('values', 'files')).toEqual({ kind: 'values', names: ['GITHUB_TOKEN'] })

    expect(await store.submitValues('values', 'files', [{ name: 'GITHUB_TOKEN', value: SECRET }])).toBe(false)
    expect(store.connectFlow('values', 'files')).toEqual({ kind: 'values', names: ['GITHUB_TOKEN'], error: 'Give a value for GITHUB_TOKEN.' })
    expect(stateText('values')).not.toContain(SECRET)

    refuse = false
    expect(await store.submitValues('values', 'files', [{ name: 'GITHUB_TOKEN', value: SECRET }])).toBe(true)
    expect(store.connectFlow('values', 'files')).toBeNull()
    expect(store.connection('values', 'files')?.status).toBe('connected')
    expect(stateText('values')).not.toContain(SECRET)
    expect(submitted.at(-1)).toEqual({ id: 'files', values: [{ name: 'GITHUB_TOKEN', value: SECRET }] })
  })

  test('the values of a command stay on the host even when the person signs in through Solus Cloud', async () => {
    let cloudCalls = 0
    const requests = new Proxy({}, { get: () => async () => { cloudCalls++; return { kind: 'ok', start: { kind: 'key' } } } })
    store.useCloudSignIn({
      // SAFETY: any account call counts as a leak; the proxy only counts them.
      requests: () => requests as AgentProfileCloudRequests,
      accountUserId: () => 'user-a',
      pullHosts: async () => {},
      setTimer: () => () => {},
    })
    try {
      connections.registerHost('cloud-values', {
        integrationList: async () => [command('files', ['TOKEN'])],
        integrationConnectionList: async () => [],
        integrationFacts: async () => facts({ state: 'stopped' }),
        integrationConnectStart: async ({ id }: { id: string }) => ({ kind: 'env', integrationId: id, names: ['TOKEN'] }),
      })
      await store.load('cloud-values')
      await flush()
      await store.connect('cloud-values', 'files')
      expect(store.connectFlow('cloud-values', 'files')?.kind).toBe('values')
      expect(cloudCalls).toBe(0)
    } finally {
      store.useCloudSignIn(null)
    }
  })

  test('the form hands the typed values over once and keeps none', () => {
    const form = new McpCommandForm('values', () => true)
    form.envNames = 'A, B'
    form.values.set('A', SECRET)
    expect(form.takeValues()).toEqual([{ name: 'A', value: SECRET }, { name: 'B', value: '' }])
    expect(form.values.size).toBe(0)
    expect(form.takeValues()).toBeNull()
  })
})

describe('who may add or change a command', () => {
  test('without host.admin the form sends nothing and gives the host\'s reason; with it, the host gets the command', async () => {
    const created: IntegrationCreateRequest[] = []
    let isAdmin = false
    connections.registerHost('admin', {
      integrationList: async () => [],
      integrationConnectionList: async () => [],
      integrationCreate: async (request: IntegrationCreateRequest) => { created.push(request); return command('files') },
    })
    await store.load('admin')
    const form = new McpCommandForm('admin', () => isAdmin)
    form.line = 'npx -y files-mcp'
    expect(form.refusal).toBe(COMMAND_ADMIN_ONLY)
    expect(await form.save()).toBeNull()
    expect(form.problem).toEqual({ field: 'form', reason: COMMAND_ADMIN_ONLY })
    expect(created).toEqual([])

    isAdmin = true
    expect((await form.save())?.id).toBe('files')
    expect(created).toEqual([{ name: 'files-mcp', launch: { command: 'npx', args: ['-y', 'files-mcp'] }, envNames: [] }])
  })

  test('the edit form of a person without host.admin changes nothing on the host', async () => {
    let updates = 0
    connections.registerHost('admin-edit', {
      integrationList: async () => [command('files')],
      integrationConnectionList: async () => [],
      integrationFacts: async () => facts({ state: 'stopped' }),
      integrationUpdate: async () => { updates++; return command('files') },
    })
    await store.load('admin-edit')
    const form = new McpCommandForm('admin-edit', () => false, command('files'))
    form.line = 'npx -y other-mcp'
    expect(await form.save()).toBeNull()
    expect(updates).toBe(0)
  })

  test('the add dialog of a person without host.admin creates nothing and starts nothing', async () => {
    const calls: string[] = []
    connections.registerHost('admin-dialog', {
      integrationList: async () => [],
      integrationConnectionList: async () => [],
      integrationCreate: async () => { calls.push('create'); return command('files') },
      integrationProcessStart: async () => { calls.push('start'); return facts({ state: 'running' }) },
    })
    await store.load('admin-dialog')
    const run = new McpConnect('admin-dialog', { name: '', url: '', addsServer: true }, noCatalog, () => false)
    run.command!.line = 'npx -y files-mcp'
    await run.startCommand()
    expect(calls).toEqual([])
    expect(run.step).toBe('command')
    expect(run.command?.problem?.reason).toBe(COMMAND_ADMIN_ONLY)
  })
})

describe('the process of a command', () => {
  test('Start and test in the dialog adds the command, saves the values, starts it, and goes to the tools; Cancel before the end removes it', async () => {
    const calls: string[] = []
    const connectionsOnHost: IntegrationConnection[] = []
    connections.registerHost('dialog', {
      integrationList: async () => [],
      integrationConnectionList: async () => [...connectionsOnHost],
      integrationCreate: async () => { calls.push('create'); return command('files', ['TOKEN']) },
      integrationConnectSubmit: async () => { calls.push('values'); connectionsOnHost.push(connected('files')); return { connected: true } },
      integrationProcessStart: async () => { calls.push('start'); return facts({ state: 'running' }, 'modern') },
      integrationTools: async () => [],
      integrationFacts: async () => facts({ state: 'running' }, 'modern'),
      integrationRemove: async () => { calls.push('remove'); return { removed: true } },
    })
    await store.load('dialog')
    const run = new McpConnect('dialog', { name: '', url: '', addsServer: true }, noCatalog, () => true)
    const form = run.command!
    form.line = 'npx -y files-mcp'
    form.envNames = 'TOKEN'
    form.values.set('TOKEN', SECRET)
    await run.startCommand()
    expect(calls).toEqual(['create', 'values', 'start'])
    expect(run.step).toBe('tools')
    expect(form.values.size).toBe(0)
    await run.dismiss()
    expect(calls.at(-1)).toBe('remove')
  })

  test('a failed start keeps the host\'s reason beside the state it reads again, and the start ends', async () => {
    let state: IntegrationFacts = facts({ state: 'stopped' })
    connections.registerHost('start', {
      integrationList: async () => [command('files')],
      integrationConnectionList: async () => [],
      integrationFacts: async () => state,
      integrationProcessStart: async () => {
        expect(store.states.get('start')?.processes.isStarting('files')).toBe(true)
        state = facts({ state: 'failed', message: '`npx` is not installed on this host.', startFailure: 'not-installed' })
        throw new Error('`npx` is not installed on this host.')
      },
    })
    await store.load('start')
    await flush()
    expect(await store.states.get('start')?.processes.start('files')).toBe(false)
    await flush()
    const host = store.states.get('start')
    expect(host?.processes.isStarting('files')).toBe(false)
    expect(host?.processes.errorOf('files')).toBe('`npx` is not installed on this host.')
    expect(host?.facts.get('files')?.process?.startFailure).toBe('not-installed')
  })

  test('a start or stop on another client reaches this one: the row reads the state again on the host\'s event', async () => {
    let state: IntegrationFacts = facts({ state: 'stopped' })
    let record = command('files')
    connections.registerHost('two-clients', {
      integrationList: async () => [record],
      integrationGet: async () => record,
      integrationConnectionList: async () => [],
      integrationFacts: async () => state,
    })
    const stop = store.watch('two-clients')
    try {
      await flush()
      await flush()
      expect(store.states.get('two-clients')?.facts.get('files')?.process).toEqual({ state: 'stopped' })

      state = facts({ state: 'running' }, 'modern')
      connections.emit('two-clients', 'integration.changed', { integrationId: 'files', change: 'facts' })
      await flush()
      expect(store.states.get('two-clients')?.facts.get('files')?.process).toEqual({ state: 'running' })

      // Another client edited the command: the host stopped it and dropped its facts.
      record = { ...command('files'), launch: { command: 'uvx', args: ['files-mcp'] } }
      state = facts({ state: 'stopped' })
      connections.emit('two-clients', 'integration.changed', { integrationId: 'files', change: 'updated' })
      await flush()
      await flush()
      expect(store.states.get('two-clients')?.integrations?.[0]?.launch?.command).toBe('uvx')
      expect(store.states.get('two-clients')?.facts.get('files')?.process).toEqual({ state: 'stopped' })
    } finally {
      stop()
    }
  })
})

// Add server takes a remote server too: its address goes on as a catalog entry does.
describe('a server added by its address', () => {
  const remote = (id: string, url: string): Integration => ({
    id, organizationId: 'local', ownerKey: 'local:test', kind: 'mcp', slug: id, name: id, url,
    auth: { kind: 'none' }, disabledTools: [], createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z',
  })
  function recordingCatalog(installed: Integration | null) {
    const installs: { name: string; url: string; auth?: IntegrationAuthChoice }[] = []
    const catalog = { installs: new Map(), dismiss: () => {}, install: async (name: string, url: string, auth?: IntegrationAuthChoice) => { installs.push(auth ? { name, url, auth } : { name, url }); return installed } } as Catalog
    return { catalog, installs }
  }

  test('the chosen authentication goes to the host with the add, and header values follow once the record exists', async () => {
    const submitted: IntegrationConnectSubmitRequest[] = []
    connections.registerHost('headers', {
      integrationList: async () => [],
      integrationConnectionList: async () => [],
      integrationConnectSubmit: async (request: IntegrationConnectSubmitRequest) => { submitted.push(request); return { connected: true } },
    })
    await store.load('headers')
    const { catalog, installs } = recordingCatalog({ ...remote('acme', 'https://mcp.acme.dev/mcp'), auth: { kind: 'headers', names: ['X-API-Key', 'X-Tenant'] } })
    const run = new McpConnect('headers', { name: '', url: '', addsServer: true }, catalog)
    run.chooseKind('url')
    const form = run.addressForm
    form.address = 'https://mcp.acme.dev/mcp'
    form.authKind = 'headers'
    form.headers[0] = { name: 'X-API-Key', value: SECRET }
    form.addHeader()
    form.headers[1] = { name: 'X-Tenant', value: '' }
    await run.continueWithAddress()
    expect(installs).toEqual([{ name: 'mcp.acme.dev', url: 'https://mcp.acme.dev/mcp', auth: { kind: 'headers', names: ['X-API-Key', 'X-Tenant'] } }])
    // Only the value typed goes; the empty one is given later. The form keeps no value.
    expect(submitted).toEqual([{ id: 'acme', values: [{ name: 'X-API-Key', value: SECRET }] }])
    expect(form.headers.every((header) => header.value === '')).toBe(true)
  })

  test('OAuth settings go with the add; a secret without a client ID or a bad scope is refused before anything is sent', async () => {
    connections.registerHost('oauth-choice', { integrationList: async () => [], integrationConnectionList: async () => [] })
    await store.load('oauth-choice')
    const { catalog, installs } = recordingCatalog(remote('docs', 'https://mcp.example.com/mcp'))
    const run = new McpConnect('oauth-choice', { name: '', url: '', addsServer: true }, catalog)
    run.chooseKind('url')
    const form = run.addressForm
    form.address = 'https://mcp.example.com/mcp'
    form.authKind = 'oauth'
    form.clientSecret = SECRET
    await run.continueWithAddress()
    expect(form.problemOf('clientId')).not.toBeNull()
    form.clientId = 'client-1'
    form.scopes = 'read "write"'
    await run.continueWithAddress()
    expect(form.problemOf('scopes')).not.toBeNull()
    expect(installs).toEqual([])
    form.scopes = 'read, write read'
    await run.continueWithAddress()
    expect(installs).toEqual([{ name: 'mcp.example.com', url: 'https://mcp.example.com/mcp', auth: { kind: 'oauth', scopes: ['read', 'write'], client: { clientId: 'client-1', clientSecret: SECRET } } }])
    expect(form.clientSecret).toBe('')
  })

  test('a refused address adds nothing and says why; a good one is checked under the typed name and goes on to the sign-in', async () => {
    connections.registerHost('address', { integrationList: async () => [], integrationConnectionList: async () => [] })
    await store.load('address')
    const { catalog, installs } = recordingCatalog(remote('docs', 'https://mcp.example.com/mcp'))
    const run = new McpConnect('address', { name: '', url: '', addsServer: true }, catalog, () => false)
    // A person who may not run commands can still add a remote server.
    run.chooseKind('url')
    expect(run.step).toBe('address')

    run.addressForm.address = 'ftp://mcp.example.com'
    await run.continueWithAddress()
    expect(run.addressForm.problemOf('address')).not.toBeNull()
    expect(installs).toEqual([])
    expect(run.step).toBe('address')

    run.addressForm.address = ' https://mcp.example.com/mcp '
    run.addressForm.name = 'Docs'
    await run.continueWithAddress()
    expect(installs).toEqual([{ name: 'Docs', url: 'https://mcp.example.com/mcp', auth: { kind: 'automatic' } }])
    expect(run.integrationId).toBe('docs')
    expect(run.addKind).toBeNull()
    expect(run.canChangeKind).toBe(false)
  })

  test('an address the host refuses can be changed: the dialog goes back to the address form and checks the new one', async () => {
    connections.registerHost('refused', { integrationList: async () => [], integrationConnectionList: async () => [] })
    await store.load('refused')
    const { catalog, installs } = recordingCatalog(null)
    const run = new McpConnect('refused', { name: '', url: '', addsServer: true }, catalog)
    run.chooseKind('url')
    run.addressForm.address = 'https://wrong.example.com/mcp'
    await run.continueWithAddress()
    expect(run.step).toBe('adding')
    run.editAddress()
    expect(run.step).toBe('address')
    run.addressForm.address = 'https://right.example.com/mcp'
    await run.continueWithAddress()
    expect(installs.map((install) => install.url)).toEqual(['https://wrong.example.com/mcp', 'https://right.example.com/mcp'])
  })

  test('an address the host has already opens that server and adds no second one', async () => {
    connections.registerHost('known', { integrationList: async () => [remote('docs', 'https://mcp.example.com/mcp')], integrationConnectionList: async () => [] })
    await store.load('known')
    const { catalog, installs } = recordingCatalog(null)
    const run = new McpConnect('known', { name: '', url: '', addsServer: true }, catalog)
    run.chooseKind('url')
    run.addressForm.address = 'https://mcp.example.com/mcp'
    await run.continueWithAddress()
    expect(installs).toEqual([])
    expect(run.integrationId).toBe('docs')
  })

  test('once the host has a command record, the dialog stays on the command, so Cancel removes the record it added', async () => {
    connections.registerHost('locked', {
      integrationList: async () => [],
      integrationConnectionList: async () => [],
      integrationCreate: async () => command('files'),
      integrationProcessStart: async () => { throw new Error('`npx` is not installed on this host.') },
      integrationFacts: async () => facts({ state: 'failed', message: '`npx` is not installed on this host.' }),
    })
    await store.load('locked')
    const run = new McpConnect('locked', { name: '', url: '', addsServer: true }, noCatalog, () => true)
    run.command!.line = 'npx -y files-mcp'
    await run.startCommand()
    expect(run.integrationId).toBe('files')
    run.chooseKind('url')
    expect(run.addKind).toBe('command')
    expect(run.step).toBe('command')
  })
})
