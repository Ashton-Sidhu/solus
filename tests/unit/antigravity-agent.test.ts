import { afterAll, describe, expect, test } from 'bun:test'
import { PERSONAL_SETTING_SCHEMAS } from '@solus/contracts/settings'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { TurnSeat } from '@solus/server/execution/seats/seat-manager'
import { AcpRequestError } from '@solus/server/execution/agents/acp/acp-connection'
import {
  antigravityAgent,
  antigravityArgs,
  antigravitySessionMeta,
  antigravitySteersWithPrompt,
  isAntigravitySignInRequired,
  antigravityStepsTool,
  nameAntigravityTool,
} from '@solus/server/execution/agents/acp/antigravity'
import { AcpTurnNormalizer, boundToolOutput } from '@solus/server/execution/agents/acp/acp-turn-normalizer'
import {
  ANTIGRAVITY_ADC_FILE,
  ANTIGRAVITY_SIGN_IN_FILE,
  antigravityAuthOf,
  antigravityEnvironment,
  antigravitySignedIn,
  antigravitySignInRecord,
  prepareAntigravityProfile,
} from '@solus/server/execution/agents/acp/antigravity-auth'

const directories: string[] = []
afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }) })
function profileDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'solus-agy-profile-'))
  directories.push(directory)
  return directory
}

describe('Antigravity launch', () => {
  test('the host’s own Google credentials never answer for a profile, and agy cannot update itself', () => {
    const env = antigravityEnvironment({
      PATH: '/bin',
      GEMINI_API_KEY: 'host-key',
      google_api_key: 'host-key-lower',
      GOOGLE_APPLICATION_CREDENTIALS: '/host/adc.json',
      GEMINI_HOME: '/host/.gemini',
      DISPLAY: ':0',
    }, '/seats/antigravity/ada', { method: 'oauth-personal' })
    expect(env.PATH).toBe('/bin')
    expect(env.GEMINI_API_KEY).toBeUndefined()
    expect(env.google_api_key).toBeUndefined()
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined()
    expect(env.DISPLAY).toBeUndefined()
    expect(env.GEMINI_HOME).toBe('/seats/antigravity/ada')
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true')
    expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBe('1')
    // A Google sign-in stays in the profile, not in the one shared OS keyring entry.
    expect(env.SSH_CONNECTION).toBeTruthy()
  })

  test('a pasted Gemini API key is the profile’s credential, and only for that profile', () => {
    const profile = profileDirectory()
    expect(antigravityAuthOf(profile)).toEqual({ method: 'oauth-personal' })
    writeFileSync(join(profile, ANTIGRAVITY_SIGN_IN_FILE), antigravitySignInRecord({ method: 'gemini-api-key', apiKey: 'seat-key' }))
    const auth = antigravityAuthOf(profile)
    expect(auth).toEqual({ method: 'gemini-api-key', apiKey: 'seat-key' })
    const env = antigravityEnvironment({ GEMINI_API_KEY: 'host-key' }, profile, auth)
    expect(env.GEMINI_API_KEY).toBe('seat-key')
    expect(env.SSH_CONNECTION).toBeUndefined()
  })

  test('the profile names its sign-in method and is private to its owner', () => {
    const profile = profileDirectory()
    prepareAntigravityProfile(profile, { method: 'gemini-api-key' })
    const settings = JSON.parse(readFileSync(join(profile, 'antigravity-acp', 'settings.json'), 'utf8'))
    expect(settings).toEqual({ auth: { type: 'gemini-api-key' } })
    expect(statSync(profile).mode & 0o777).toBe(0o700)
  })

  test('Gemini Enterprise and Vertex AI name their Google Cloud project in agy’s settings, never in the environment', () => {
    const profile = profileDirectory()
    const vertex = { method: 'agent-platform' as const, apiKey: 'cloud-key', gcpProject: 'my-project-123', gcpLocation: 'us-central1' }
    prepareAntigravityProfile(profile, vertex)
    expect(JSON.parse(readFileSync(join(profile, 'antigravity-acp', 'settings.json'), 'utf8')))
      .toEqual({ auth: { type: 'agent-platform' }, gcp: { project: 'my-project-123', location: 'us-central1' } })
    const env = antigravityEnvironment({ GOOGLE_CLOUD_PROJECT: 'host-project' }, profile, vertex)
    expect(env.GOOGLE_API_KEY).toBe('cloud-key')
    expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined()
    // Enterprise signs in with agy's own browser sign-in, not the code sign-in a Google account uses.
    expect(antigravityEnvironment({}, profile, { method: 'oauth-business', gcpProject: 'my-project-123', gcpLocation: 'global' }).SSH_CONNECTION).toBeUndefined()
  })

  test('Vertex AI with pasted credentials passes them as Application Default Credentials', () => {
    const profile = profileDirectory()
    const vertex = { method: 'agent-platform' as const, gcpProject: 'my-project-123', gcpLocation: 'global' }
    expect(antigravitySignedIn(profile, vertex)).toBe(false)
    writeFileSync(join(profile, ANTIGRAVITY_ADC_FILE), '{"type":"authorized_user"}')
    expect(antigravitySignedIn(profile, vertex)).toBe(true)
    expect(antigravityEnvironment({}, profile, vertex).GOOGLE_APPLICATION_CREDENTIALS).toBe(join(profile, ANTIGRAVITY_ADC_FILE))
  })

  test('agy runs as an ACP agent on the profile, and --login only for a sign-in', () => {
    expect(antigravityArgs('/p')).toEqual(['acp', '--gemini-dir', '/p', '--app-data-dir', 'antigravity-acp'])
    expect(antigravityArgs('/p', { login: true }).at(-1)).toBe('--login')
  })
})

describe('Antigravity protocol', () => {
  test('a Solus tool called through agy shows as the same card as in a Claude session', () => {
    expect(nameAntigravityTool({ toolCallId: 't', title: 'Run mcp_solus_render_artifact', rawInput: { title: 'Chart' } }))
      .toEqual({ toolName: 'mcp__solus__render_artifact', toolInput: '{"title":"Chart"}' })
    expect(nameAntigravityTool({ toolCallId: 't', title: 'MCP Tool start_sessions', rawInput: { ServerName: 'solus', ToolName: 'start_sessions', Arguments: { sessions: [] } } }))
      .toEqual({ toolName: 'mcp__solus__start_sessions', toolInput: '{"sessions":[]}' })
    // Another server's tool of the same name keeps the agent's own title.
    expect(nameAntigravityTool({ toolCallId: 't', title: 'MCP Tool start_sessions', rawInput: { ServerName: 'other', ToolName: 'start_sessions' } })).toBeNull()
    expect(nameAntigravityTool({ toolCallId: 't', title: 'Read a.ts' })).toBeNull()
  })

  test('agy’s sign-in errors are told apart from other failures', () => {
    expect(isAntigravitySignInRequired(new AcpRequestError('authenticate', -32000, 'Authentication required'))).toBe(true)
    expect(isAntigravitySignInRequired(new AcpRequestError('authenticate', -32603, 'No browser is available here to sign in'))).toBe(true)
    expect(isAntigravitySignInRequired(new AcpRequestError('session/prompt', -32603, 'Internal error'))).toBe(false)
    expect(isAntigravitySignInRequired(new Error('Authentication required'))).toBe(false)
  })

  test('agy 1.5.0 and later steer with a prompt; older and unknown versions do not', () => {
    const version = (value: string | undefined) => antigravitySteersWithPrompt({ protocolVersion: 1, agentInfo: { version: value } })
    expect(version('1.5.0')).toBe(true)
    expect(version('1.12.3')).toBe(true)
    expect(version('2.0.0')).toBe(true)
    expect(version('1.4.9')).toBe(false)
    expect(version('agy_acp_server_1.1.1')).toBe(false)
    expect(version(undefined)).toBe(false)
  })

  test('Solus instructions go to agy only when it says it takes them', () => {
    const takes = { agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } }
    expect(antigravitySessionMeta(takes, 'Be brief.')).toEqual({ antigravity: { systemPrompt: { append: 'Be brief.' } } })
    expect(antigravitySessionMeta({ agentCapabilities: {} }, 'Be brief.')).toBeUndefined()
    expect(antigravitySessionMeta(takes, undefined)).toBeUndefined()
  })
})

describe('Antigravity temp folders', () => {
  // Each launch unpacks about 1 GB; a process that runs as the host's own user unpacks inside its profile, where Solus removes it.
  test("a seat's process gets its temp folders inside its profile", () => {
    const profile = profileDirectory()
    const seat = { home: profile, launch: { env: { PATH: '/bin' } } } as TurnSeat
    const launch = antigravityAgent.launch({ provider: 'antigravity', seat } as AgentRunRequest)
    expect(launch.tempRoot).toBe(join(profile, 'antigravity-acp', 'tmp'))
  })

  // Settings → Providers names the agy a person runs; without one, Solus finds its own.
  test("the binary path of the person's Google Antigravity instance starts agy", () => {
    const seat = { home: profileDirectory(), launch: { env: { PATH: '/bin' } } } as TurnSeat
    const providerRuntime = { binaryPath: '/opt/agy/bin/agy' } as AgentRunRequest['providerRuntime']
    expect(antigravityAgent.launch({ provider: 'antigravity', seat, providerRuntime } as AgentRunRequest).file).toBe('/opt/agy/bin/agy')
    expect(antigravityAgent.launch({ provider: 'antigravity', seat } as AgentRunRequest).file).not.toBe('/opt/agy/bin/agy')
  })
})

describe('Antigravity checklist', () => {
  // agy sends its checklist only as `update_steps` tool calls: it is the session's task list, not a tool card.
  test("update_steps becomes the task list, and its later updates by id follow it", () => {
    const normalizer = new AcpTurnNormalizer(nameAntigravityTool, antigravityStepsTool)
    const steps = (statuses: string[]) => ({ steps: statuses.map((status, index) => ({ title: `Step ${index + 1}`, status })) })
    expect(normalizer.push({ sessionUpdate: 'tool_call', toolCallId: 'steps-1', title: 'Run update_steps', kind: 'other', status: 'pending', rawInput: steps(['in_progress', 'pending']) }))
      .toEqual([{ type: 'progress', todos: [{ content: 'Step 1', status: 'in_progress' }, { content: 'Step 2', status: 'pending' }] }])
    expect(normalizer.push({ sessionUpdate: 'tool_call_update', toolCallId: 'steps-1', rawInput: steps(['done', 'blocked']) }))
      .toEqual([{ type: 'progress', todos: [{ content: 'Step 1', status: 'completed' }, { content: 'Step 2', status: 'pending' }] }])
    expect(normalizer.push({ sessionUpdate: 'tool_call_update', toolCallId: 'steps-1', status: 'completed' })).toEqual([])
    expect(normalizer.summary.toolCallCount).toBe(0)
    // A command with the same words in its title is still a command.
    const command = normalizer.push({ sessionUpdate: 'tool_call', toolCallId: 'cmd-1', title: 'Run update_steps', kind: 'execute', status: 'pending', rawInput: { command: 'update_steps' } })
    expect(command.some((event) => event.type === 'tool_call')).toBe(true)
  })
})

describe('ACP tool output', () => {
  // An update's content replaces the call's content: agy sends a command's whole output on each update.
  test("a command's output shows once, however many times the agent reports it", () => {
    const normalizer = new AcpTurnNormalizer()
    const text = (value: string) => [{ type: 'content', content: { type: 'text', text: value } }]
    normalizer.push({ sessionUpdate: 'tool_call', toolCallId: 'cmd-1', title: 'Run npm test', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } })
    normalizer.push({ sessionUpdate: 'tool_call_update', toolCallId: 'cmd-1', content: text('1 passing\n') })
    const done = normalizer.push({ sessionUpdate: 'tool_call_update', toolCallId: 'cmd-1', status: 'completed', content: text('1 passing\n2 passing\n') })
    expect(done.find((event) => event.type === 'tool_result')).toMatchObject({ content: '1 passing\n2 passing\n' })
  })

  test('very long output keeps its tail, where the result and the error are, and never splits a character', () => {
    const long = `${'a'.repeat(70_000)}\u{1F600}${'b'.repeat(65_535)}`
    const bounded = boundToolOutput(long)
    expect(bounded.startsWith('[Earlier output left out]')).toBe(true)
    expect(bounded.endsWith('b'.repeat(100))).toBe(true)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(bounded)).toBe(false)
    expect(boundToolOutput('short')).toBe('short')
  })
})

describe('Antigravity subagents and swarm', () => {
  // agy's subagent launches and swarm workers show as subagent cards; its other swarm calls get readable titles.
  const call = (title: string, rawInput?: object, extra: object = {}) => ({ toolCallId: 't', title, kind: 'other' as const, ...(rawInput ? { rawInput } : {}), ...extra })

  test('a subagent launch is a subagent card with its role and prompt, in agy 1.4 and 1.5 shapes', () => {
    expect(nameAntigravityTool(call('Run invoke_subagent', { TypeName: 'research', Role: 'Codebase Researcher', Prompt: 'Read README.md' }))).toEqual({
      toolName: 'Agent', isSubagent: true, subagentType: 'antigravity',
      toolInput: JSON.stringify({ description: 'Codebase Researcher', prompt: 'Read README.md', subagent_type: 'research' }),
    })
    const several = nameAntigravityTool(call('Run invoke_subagent?', { Subagents: [{ Role: 'Reader', Prompt: 'Read a' }, { Role: 'Writer', Prompt: 'Write b' }] }))
    expect(JSON.parse(several!.toolInput!)).toEqual({ description: 'Reader, Writer', prompt: 'Reader: Read a\n\nWriter: Write b' })
    // A later update names the call by id only: the card keeps its input.
    expect(nameAntigravityTool(call('Running start_subagent'))).toEqual({ toolName: 'Agent', isSubagent: true, subagentType: 'antigravity' })
  })

  test("an MCP server's tool or a command with the same title is not a subagent", () => {
    expect(nameAntigravityTool(call('Run invoke_subagent', { Prompt: 'x' }, { _meta: { is_mcp_tool_call: true } }))?.isSubagent).toBeUndefined()
    expect(nameAntigravityTool({ toolCallId: 't', title: 'Run invoke_subagent', kind: 'execute' })).toBeNull()
  })

  test('a swarm worker is a subagent card; the other swarm calls have readable titles', () => {
    expect(nameAntigravityTool(call('Run swarm', { action: 'add', name: 'parser', brief: 'Audit parser module' }))).toMatchObject({
      toolName: 'Agent', isSubagent: true, toolInput: JSON.stringify({ description: '@parser', prompt: 'Audit parser module' }),
    })
    expect(nameAntigravityTool(call('Run swarm', { action: 'kill', name: '@parser' }))).toEqual({ toolName: 'Stop swarm worker @parser' })
    expect(nameAntigravityTool(call('Run post_message', { channel: 'backend', text: 'done' }))).toEqual({ toolName: 'Post to #backend' })
    expect(nameAntigravityTool(call('Run read_board', { since: 1 }))).toEqual({ toolName: 'Read swarm board' })
    expect(nameAntigravityTool(call('Run swarm_wait'))).toEqual({ toolName: 'Wait for swarm board' })
    // agy names the swarm tool in `_meta` too.
    expect(nameAntigravityTool(call('Coordinate', { action: 'status' }, { _meta: { antigravity: { swarm: { tool: 'swarm', action: 'status' } } } }))).toEqual({ toolName: 'Check swarm status' })
  })

  test('the turn marks a subagent card as one, so the client groups its work under it', () => {
    const normalizer = new AcpTurnNormalizer(nameAntigravityTool)
    const [event] = normalizer.push({ sessionUpdate: 'tool_call', ...call('Run invoke_subagent', { Role: 'Reader', Prompt: 'Read a' }), status: 'pending' })
    expect(event).toMatchObject({ type: 'tool_call', toolName: 'Agent', isSubagent: true, subagentType: 'antigravity' })
  })
})

describe('Antigravity in personal settings', () => {
  test('Antigravity can be the worker model: a worker reports when its turn ends, with no Solus tool', () => {
    expect(PERSONAL_SETTING_SCHEMAS.workerModel.safeParse({ provider: 'antigravity', model: 'gemini-4-carbon' }).success).toBe(true)
  })

  test('Antigravity can write titles and commit text: it answers through the Solus tool it reaches over /mcp', () => {
    expect(PERSONAL_SETTING_SCHEMAS.textGenerationModel.safeParse({ provider: 'antigravity', model: 'gemini-3.8-flash' }).success).toBe(true)
    // A provider with no Solus tools still cannot.
    expect(PERSONAL_SETTING_SCHEMAS.textGenerationModel.safeParse({ provider: 'replay', model: 'showcase' }).success).toBe(false)
  })
})
