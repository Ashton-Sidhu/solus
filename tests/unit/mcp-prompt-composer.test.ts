import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { IntegrationPrompt, IntegrationPromptGetRequest, IntegrationPromptList, IntegrationPromptText } from '@solus/contracts/integrations/prompts'
import type { Attachment } from '@solus/contracts/types'
import { argumentHint, missingArguments, promptFromLine, promptStart } from '@solus/client-core/integration-prompts'
import { buildRows, isSelectable, type MenuItem, type RowInput } from '@solus/workspace-ui/components/editor/unified-autocomplete/rows'
import { findAnchor, readTrigger } from '@solus/workspace-ui/components/editor/unified-autocomplete/trigger'
import { mcpPromptItems } from '@solus/workspace-ui/components/editor/unified-autocomplete/mcp-prompt-items'
import { mcpPromptSections } from '../../apps/mobile/src/features/threads/lib/mcp-prompt-sheet'
import { singleHostServerConnections } from './helpers/server-connections-mock'

// The composer keeps its form in `$state`; outside the Svelte compiler a plain value stands in, as in git-refs-store.test.ts.
const previousState = (globalThis as unknown as { $state?: unknown }).$state
Object.defineProperty(globalThis, '$state', { configurable: true, writable: true, value: <T>(value: T) => value })
afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { integrationPromptsStore } = await import('@solus/workspace-ui/components/input/lib/integration-prompts.store.svelte')
const { useMcpPromptComposer } = await import('@solus/workspace-ui/components/input/lib/mcp-prompt-composer.svelte')

/**
 * MCP prompts in the composer (docs/plans/mcp-first-class.md §10): what the
 * slash menu lists, when a prompt opens the argument form instead of
 * sending, and that the host's text is sent unchanged as the person's own
 * message on every client.
 */

const review: IntegrationPrompt = {
  integrationId: 'github', integrationName: 'GitHub', command: '/github:review_pr', name: 'review pr',
  description: 'Review one pull request.',
  arguments: [{ name: 'number', required: true }, { name: 'focus', required: false }],
}
const triage: IntegrationPrompt = {
  integrationId: 'github', integrationName: 'GitHub', command: '/github:triage', name: 'triage',
  arguments: [{ name: 'label', required: true }],
}
const standup: IntegrationPrompt = { integrationId: 'linear', integrationName: 'Linear', command: '/linear:standup', name: 'standup', arguments: [] }
const LIST: IntegrationPromptList = {
  prompts: [review, triage, standup],
  signIn: [{ integrationId: 'sentry', integrationName: 'Sentry', slug: 'sentry', needs: 'sign-in' }],
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function rowsFor(text: string, items: MenuItem[], commands: MenuItem[] = []): ReturnType<typeof buildRows> {
  const trigger = readTrigger(text, findAnchor(text))
  if (!trigger) throw new Error(`no trigger in ${text}`)
  const empty = { plan: [], doc: [], pr: [], session: [], task: [], automation: [], host: [] }
  const input: RowInput = {
    trigger, commands, mcpPrompts: items, openFiles: [], worktreeFiles: [], worktreeFileCount: null,
    byKind: empty, linked: [], linkedLabel: '', counts: { plan: 0, doc: 0, pr: 0, session: 0, task: 0, automation: 0, host: 0 },
  }
  return buildRows(input)
}

describe('starting an MCP prompt', () => {
  test('a prompt with a required argument cannot be sent without it: it opens the form', () => {
    // WHY: the server would answer with an error, or expand a prompt with a hole in it.
    expect(promptStart(triage, '')).toEqual({ kind: 'form', values: [{ name: 'label', value: '' }] })
    expect(promptStart(review, '42')).toEqual({ kind: 'form', values: [{ name: 'number', value: '42' }, { name: 'focus', value: '' }] })
    expect(missingArguments(review.arguments, [{ name: 'number', value: '   ' }])).toEqual(['number'])
  })

  test('one argument takes the rest of the line; no argument sends at once; a stray argument is refused', () => {
    expect(promptStart(triage, 'bug')).toEqual({ kind: 'send', values: [{ name: 'label', value: 'bug' }] })
    expect(promptStart(standup, '')).toEqual({ kind: 'send', values: [] })
    expect(promptStart(standup, 'today')).toEqual({ kind: 'refused', message: '/linear:standup takes no arguments.' })
  })

  test('a typed line names a prompt only by its whole command', () => {
    expect(promptFromLine('/github:triage  bug ', LIST.prompts)).toEqual({ prompt: triage, rest: 'bug' })
    expect(promptFromLine('/github:triager', LIST.prompts)).toBeNull()
    expect(promptFromLine('see /github:triage', LIST.prompts)).toBeNull()
    expect(argumentHint(review)).toBe('<number> [focus]')
  })
})

describe('the slash menu', () => {
  test('MCP prompts list under their own label after the commands, with the sign-in rows', () => {
    const items = mcpPromptItems(LIST, ['clear'])
    const clear: MenuItem = { id: 'cmd:/clear', title: 'clear', meta: 'Clear', when: '', icon: '', mono: true, monoMeta: false, token: { kind: 'slash', command: '/clear' } }
    const rows = rowsFor('/', items, [clear])
    expect(rows.map((row) => (row.type === 'label' ? `label:${row.label}` : row.type === 'item' ? row.item.title : row.type))).toEqual([
      'clear', 'label:MCP', 'github:review_pr', 'github:triage', 'linear:standup', 'sentry:',
    ])
    const signIn = rows.find((row) => row.type === 'item' && row.item.title === 'sentry:')
    // WHY: a server the person is not connected to offers its sign-in, not an error.
    expect(signIn?.type === 'item' && signIn.item.mcpPrompt).toEqual({ kind: 'sign-in', server: LIST.signIn[0] })
    expect(signIn?.type === 'item' && signIn.item.meta).toBe('Sign in to Sentry to use its prompts')
  })

  test('a prompt whose command a Solus command already has is left out', () => {
    const items = mcpPromptItems({ prompts: [{ ...standup, command: '/review:pr' }], signIn: [] }, ['review:pr'])
    expect(items).toEqual([])
  })

  test('a query matches the MCP band too, and nothing matching is a dead end, not an empty menu', () => {
    const items = mcpPromptItems(LIST, [])
    expect(rowsFor('/triage', items).filter(isSelectable).map((row) => row.type === 'item' && row.item.title)).toEqual(['github:triage'])
    expect(rowsFor('/zzzz', items).map((row) => row.type)).toEqual(['deadEnd'])
  })

  test('the phone sheet groups the same prompts by server and searches them', () => {
    expect(mcpPromptSections(LIST, '').map((section) => [section.title, section.data.length])).toEqual([['GitHub', 2], ['Linear', 1], ['Sign in to use', 1]])
    expect(mcpPromptSections(LIST, 'stand').map((section) => section.title)).toEqual(['Linear'])
  })
})

describe('the prompt list store', () => {
  test('opening the menu reads the list once; typing reads nothing; a change on the host reads it again', async () => {
    let reads = 0
    let answer: IntegrationPromptList = LIST
    connections.registerHost('prompts-host', { integrationPromptList: async () => { reads++; return answer } })
    integrationPromptsStore.ensure('prompts-host', '/repo')
    await flush()
    // WHY: the slash menu is in the typing path; a keystroke must cost no request.
    for (let index = 0; index < 5; index++) integrationPromptsStore.ensure('prompts-host', '/repo')
    expect(reads).toBe(1)
    expect(integrationPromptsStore.stateFor('prompts-host', '/repo').prompts).toHaveLength(3)
    // A removed integration takes its prompts with it.
    answer = { prompts: [standup], signIn: [] }
    connections.emit('prompts-host', 'integration.changed', { integrationId: 'github', change: 'removed' })
    expect(integrationPromptsStore.stateFor('prompts-host', '/repo').prompts).toHaveLength(3)
    await flush()
    expect(reads).toBe(2)
    expect(integrationPromptsStore.stateFor('prompts-host', '/repo').prompts.map((prompt) => prompt.command)).toEqual(['/linear:standup'])
  })
})

describe('sending an MCP prompt', () => {
  function composer(serverId: string, answer: (request: IntegrationPromptGetRequest) => Promise<IntegrationPromptText>) {
    const requests: IntegrationPromptGetRequest[] = []
    connections.registerHost(serverId, {
      integrationPromptList: async () => LIST,
      integrationPromptGet: async (request: IntegrationPromptGetRequest) => { requests.push(request); return answer(request) },
    })
    const sent: Array<{ text: string; attachments: Attachment[] }> = []
    const reports: string[] = []
    const signIns: string[] = []
    let composerText = ''
    const prompts = useMcpPromptComposer({
      serverId: () => serverId,
      projectPath: () => '/repo',
      sessionId: () => 'session-1',
      draftId: () => undefined,
      send: (text, attachments) => { sent.push({ text, attachments }); return true },
      report: (message) => reports.push(message),
      openSignIn: (server) => signIns.push(server.integrationName),
      setComposerText: (text) => { composerText = text },
      clearComposer: () => { composerText = '' },
      refocus: () => {},
    })
    return { prompts, requests, sent, reports, signIns, text: () => composerText }
  }

  test('the host\'s text is sent unchanged as the person\'s message, with its attachments on that host', async () => {
    // WHY: the text is the person's message for Claude and Codex alike; the client must not rewrite it.
    const image: Attachment = { id: 'a1', type: 'image', name: 'shot.png', path: '/host/a/shot.png', hostPath: '/host/a/shot.png', mimeType: 'image/png' }
    const { prompts, requests, sent } = composer('send-host', async () => ({ kind: 'text', text: 'Sort the bugs.\n\nAssistant:\nOK.', attachments: [image] }))
    integrationPromptsStore.ensure('send-host', '/repo')
    await flush()
    expect(prompts.startFromLine('/github:triage bug')).toBe(true)
    await flush()
    expect(requests).toEqual([{ integrationId: 'github', name: 'triage', arguments: [{ name: 'label', value: 'bug' }], sessionId: 'session-1' }])
    expect(sent).toEqual([{ text: 'Sort the bugs.\n\nAssistant:\nOK.', attachments: [{ ...image, hostServerId: 'send-host' }] }])
  })

  test('a required argument left empty in the form sends nothing; filled, it sends', async () => {
    const { prompts, requests, sent } = composer('form-host', async () => ({ kind: 'text', text: 'Review 42.', attachments: [] }))
    integrationPromptsStore.ensure('form-host', '/repo')
    await flush()
    prompts.choose({ kind: 'prompt', prompt: review })
    expect(prompts.form?.prompt).toBe(review)
    expect(requests).toEqual([])
    prompts.submitForm([{ name: 'number', value: '42' }, { name: 'focus', value: '' }])
    await flush()
    expect(requests[0].arguments).toEqual([{ name: 'number', value: '42' }])
    expect(sent.map((entry) => entry.text)).toEqual(['Review 42.'])
    expect(prompts.form).toBeNull()
  })

  test('a server that needs a sign-in opens the sign-in, not an error, and the line stays', async () => {
    const { prompts, sent, reports, signIns } = composer('signin-host', async () => ({ kind: 'connection-required', integrationId: 'linear', integrationName: 'Linear', needs: 'sign-in' }))
    integrationPromptsStore.ensure('signin-host', '/repo')
    await flush()
    expect(prompts.startFromLine('/linear:standup')).toBe(true)
    await flush()
    expect(signIns).toEqual(['Linear'])
    expect(reports).toEqual([])
    expect(sent).toEqual([])
  })

  test('a failed prompts/get reports the reason and sends nothing', async () => {
    const { prompts, sent, reports } = composer('error-host', async () => { throw new Error('Linear could not give the prompt standup: timeout') })
    integrationPromptsStore.ensure('error-host', '/repo')
    await flush()
    prompts.startFromLine('/linear:standup')
    await flush()
    expect(reports).toEqual(['Linear could not give the prompt standup: timeout'])
    expect(sent).toEqual([])
  })

  test('choosing a one-argument prompt puts its command in the line, to take the rest of it', async () => {
    const { prompts, text, requests } = composer('one-host', async () => ({ kind: 'text', text: '', attachments: [] }))
    prompts.choose({ kind: 'prompt', prompt: triage })
    expect(text()).toBe('/github:triage ')
    expect(requests).toEqual([])
  })
})
