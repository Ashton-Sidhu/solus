import { describe, expect, test } from 'bun:test'
import type { Message, QuestionRequest } from '@solus/contracts/types'
import { canSubmitSecret, canSubmitSecrets, isSecretRequest, secretAnswer, secretOutcomesFromResult, secretPrivacyNote, secretPageUrl, secretReceiptRows, secretRequestLink, secretRequestPrompts } from '@solus/contracts/secret-request'
import { projectSessionEvent, projectSessionHistory } from '@solus/server/data/sessions/result-projection'
import { groupMessages } from '@solus/workspace-ui/components/conversation/lib/turns'
import { summarizeToolGroup, toolRowLabel } from '../../apps/mobile/src/features/threads/thread-work-log-presentation'

function request(patch: Partial<QuestionRequest>): QuestionRequest {
  return { questionId: 'q1', questions: [{ header: 'GitHub webhook secret', question: 'To verify GitHub requests.', options: [], multiSelect: false }], kind: 'secret', ...patch }
}

// A request_secret card is answered through secretRequestAnswer, never
// respondQuestion (docs/plans/webhooks.md §3.6), so the card must be told apart.
describe('secret request card', () => {
  test('only the secret kind is a secret request', () => {
    expect(isSecretRequest(request({}))).toBe(true)
    expect(isSecretRequest(request({ kind: 'standard' }))).toBe(false)
    expect(isSecretRequest(request({ kind: undefined }))).toBe(false)
  })

  test('the header names the secret and the question says why', () => {
    expect(secretRequestPrompts(request({}))).toEqual([{ name: 'GitHub webhook secret', reason: 'To verify GitHub requests.', delivery: 'ref' }])
    expect(secretRequestPrompts(request({ questions: [] }))).toEqual([{ name: 'A secret', reason: 'The agent did not say why it asks.', delivery: 'ref' }])
  })

  test('an empty value is not an answer; a value is sent as typed', () => {
    expect(canSubmitSecret('')).toBe(false)
    expect(canSubmitSecret(' x ')).toBe(true)
  })

  test('a group card has one field per secret; each is typed or declined before it sends', () => {
    // WHY: the person declines only the secrets they do not want to give (docs/plans/webhooks.md §3.6).
    const group = request({ questions: [
      { header: 'Stripe key', question: 'To call the API.', options: [], multiSelect: false },
      { header: 'Slack token', question: '', options: [], multiSelect: false },
    ], message: 'For the deploy.' })
    expect(secretRequestPrompts(group)).toEqual([{ name: 'Stripe key', reason: 'To call the API.', delivery: 'ref' }, { name: 'Slack token', reason: 'For the deploy.', delivery: 'ref' }])
    expect(canSubmitSecrets([{ value: 'sk', isDeclined: false }, { value: '', isDeclined: false }])).toBe(false)
    expect(canSubmitSecrets([{ value: 'sk', isDeclined: false }, { value: '', isDeclined: true }])).toBe(true)
    expect(secretAnswer([{ value: 'sk', isDeclined: false }, { value: 'stale', isDeclined: true }])).toEqual(['sk', null])
  })

  test('a file secret never tells the person that the agent cannot see it', () => {
    // WHY: a `file` secret is readable by the agent's commands. The person must know
    // that before they type it; the ref promise would be false for it.
    const [ref] = secretRequestPrompts(request({}))
    expect(secretPrivacyNote(ref)).toContain('never sees it')
    const [file] = secretRequestPrompts(request({ questions: [{ header: 'Cloudflare token', question: 'For wrangler.', options: [], multiSelect: false, secretDelivery: 'file' }] }))
    expect(file.delivery).toBe('file')
    expect(secretPrivacyNote(file)).not.toMatch(/never/)
    expect(secretPrivacyNote(file)).toContain("agent's commands can read it")
  })
})

// docs/plans/webhooks.md §3.6: when a card closes, a short row stays. The row is
// built from what crosses to clients, so nothing secret may cross.
describe('the row after a secret card closes', () => {
  const answered = JSON.stringify({ secrets: [
    { name: 'Webhook secret', status: 'saved', secretRef: 'secretref_private' },
    { name: 'Cloudflare token', status: 'saved', path: '/host/secret-files/private' },
    { name: 'Sentry DSN', status: 'declined' },
  ] })

  test('it says what happened to each secret, and how a file secret was saved', () => {
    const outcomes = secretOutcomesFromResult(answered) ?? []
    expect(secretReceiptRows(outcomes, undefined).map(({ name, label }) => `${name} · ${label}`)).toEqual([
      'Webhook secret · Saved securely',
      "Cloudflare token · Saved for the agent's commands",
      'Sentry DSN · Declined',
    ])
  })

  test('a card the run ended names the secrets it asked for', () => {
    const input = JSON.stringify({ secrets: [{ name: 'Cloudflare token', reason: 'For wrangler.' }] })
    expect(secretOutcomesFromResult('{"status":"cancelled"}')).toEqual([])
    expect(secretReceiptRows([], input)).toEqual([{ name: 'Cloudflare token', outcome: 'ended', label: 'Request ended' }])
    // A call whose input did not survive still says something true.
    expect(secretReceiptRows([], undefined)[0].name).toBe('Secret request')
  })

  test('the outcome that crosses to a client holds no ref and no path, live or from history', () => {
    // WHY: tool results stay on the host. This projection is the one exception, so it must carry only what the row shows.
    const live = projectSessionEvent({ type: 'tool_result', toolUseId: 't', content: answered })
    const history = projectSessionHistory([
      { role: 'tool', toolId: 't', toolName: 'mcp__solus__request_secret', content: '', timestamp: 1 },
      { role: 'tool_result', toolResultForId: 't', content: answered, timestamp: 2 },
    ])
    for (const projected of [live, history[1]]) {
      expect(JSON.stringify(projected)).not.toContain('private')
      expect(projected).toMatchObject({ secretOutcomes: [
        { name: 'Webhook secret', status: 'saved' },
        { name: 'Cloudflare token', status: 'saved', delivery: 'file' },
        { name: 'Sentry DSN', status: 'declined' },
      ] })
    }
  })

  test('another tool\'s result gives no outcomes, and an open card gives no row', () => {
    // WHY: a reload during an open card must not say the request ended.
    expect(secretOutcomesFromResult('{"secrets":"no"}')).toBeUndefined()
    expect(secretOutcomesFromResult('plain output')).toBeUndefined()
    expect(projectSessionEvent({ type: 'tool_result', toolUseId: 't', content: 'plain output' })).not.toHaveProperty('secretOutcomes')
    const tool = (patch: Partial<Message>): Message => ({ id: 'm', role: 'tool', content: '', timestamp: 1, toolName: 'mcp__solus__request_secret', toolStatus: 'completed', ...patch })
    const kinds = (message: Message) => groupMessages([message]).map((item) => item.kind)
    expect(kinds(tool({ toolStatus: 'running' }))).toEqual(['tool-group'])
    expect(kinds(tool({}))).toEqual(['tool-group'])
    expect(kinds(tool({ secretOutcomes: [] }))).toEqual(['secret-receipt'])
    expect(kinds(tool({ toolName: 'Bash', secretOutcomes: [] }))).toEqual(['tool-group'])
  })

  test('mobile shows the row as the call\'s work-log label', () => {
    const tool = { toolName: 'request_secret', input: null, status: 'completed' as const, secretOutcomes: secretOutcomesFromResult(answered) }
    expect(toolRowLabel(tool)).toContain('Webhook secret · Saved securely, Cloudflare token')
    expect(summarizeToolGroup([tool])).toBe(toolRowLabel(tool))
    expect(toolRowLabel({ ...tool, secretOutcomes: undefined })).toBe('request_secret')
  })
})

// An agent that asks the person to sign a CLI in must give a link the person can
// open. Every card opens it through these rules, so no card opens another scheme.
describe('secret card link', () => {
  test('only an http(s) page with a host is a page the card may open', () => {
    expect(secretPageUrl('https://github.com/login/device')?.href).toBe('https://github.com/login/device')
    expect(secretPageUrl('http://localhost:8080/auth')?.host).toBe('localhost:8080')
    for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://a.dev', 'data:text/html,x', 'https://', 'github.com/login', '']) {
      expect(secretPageUrl(value)).toBeNull()
    }
  })

  test('the card shows the url the agent gave, and says that the reason does not show it', () => {
    expect(secretRequestLink({ url: 'https://github.com/login/device', reason: 'Enter the code.' }))
      .toEqual({ href: 'https://github.com/login/device', host: 'github.com', isInReason: false })
    // The url wins over a link in the reason; a bad url opens nothing.
    expect(secretRequestLink({ url: 'https://a.dev/x', reason: 'See https://b.dev' })?.host).toBe('a.dev')
    expect(secretRequestLink({ url: 'javascript:alert(1)', reason: 'See https://b.dev' })).toBeNull()
  })

  test('without a url, the card finds the one link in the reason', () => {
    const link = (reason: string) => secretRequestLink({ reason })?.href
    expect(link('Open https://github.com/login/device and enter the code.')).toBe('https://github.com/login/device')
    expect(link('Sign in at https://a.dev/login.')).toBe('https://a.dev/login')
    expect(link('Sign in at [the device page](https://a.dev/login?x=1).')).toBe('https://a.dev/login?x=1')
    expect(link('Sign in at **https://a.dev/login**, then paste the code.')).toBe('https://a.dev/login')
    expect(link('Sign in at _https://a.dev/login_.')).toBe('https://a.dev/login')
    expect(link('Sign in at `https://a.dev/login`.')).toBe('https://a.dev/login')
    expect(link('Sign in at <https://a.dev/login>.')).toBe('https://a.dev/login')
    expect(link('The page (https://a.dev/wiki/Foo_(bar)) has it.')).toBe('https://a.dev/wiki/Foo_(bar)')
    expect(secretRequestLink({ reason: 'Open https://a.dev.' })?.isInReason).toBe(true)
  })

  test('repeats of one link count once; no link or two links give no button', () => {
    const link = (reason: string) => secretRequestLink({ reason })?.href
    expect(link('[https://a.dev/login](https://a.dev/login), again https://a.dev/login.')).toBe('https://a.dev/login')
    expect(link('Open https://a.dev or https://a.dev/ to sign in.')).toBe('https://a.dev/')
    expect(link('Run `gh auth login` and paste the token.')).toBeUndefined()
    expect(link('Use https://a.dev/login or https://b.dev/login.')).toBeUndefined()
    expect(link('Not a page: javascript:alert(1)')).toBeUndefined()
  })

  test('a url from the agent reaches the card prompt', () => {
    const [prompt] = secretRequestPrompts(request({ questions: [{ header: 'GitHub code', question: 'Enter the code.', options: [], multiSelect: false, secretUrl: 'https://github.com/login/device' }] }))
    expect(prompt.url).toBe('https://github.com/login/device')
    expect(secretRequestPrompts(request({}))[0].url).toBeUndefined()
  })
})
