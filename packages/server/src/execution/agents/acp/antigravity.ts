/**
 * Google Antigravity as an ACP agent (docs/plans/antigravity-provider.md).
 *
 * The launch environment, the sign-in errors, the login arguments, and the
 * tool titles port T3 Code (`pingdotgg/t3code` commit b8ef0600,
 * `apps/server/src/provider/antigravityAuthSupport.ts` and
 * `apps/server/src/provider/acp/AntigravityAcpSupport.ts`):
 *
 *   MIT License. Copyright (c) 2026 T3 Tools Inc.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions: The above copyright
 *   notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 *   WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { launchedProcess, launchOptions } from '../../../cli-env'
import type { TodoItem } from '@solus/contracts/types'
import type { AgentRunRequest } from '../agent-runner'
import type { AcpAgent } from './acp-backend'
import { ANTIGRAVITY_APP_DATA_DIR, antigravityAuthOf, antigravityEnvironment, hostAntigravityProfile, prepareAntigravityProfile } from './antigravity-auth'
import { linkHostGeminiConfig, listAntigravitySkills } from './antigravity-skills'
import { presentAntigravitySubagentTool } from './antigravity-subagents'
import { watchAntigravityTurnOutcome } from './antigravity-turn-outcome'
import { AcpRequestError } from './acp-connection'
import type { AcpInitializeResult, AcpToolCall } from './acp-protocol'
import type { AcpStepsTool, AcpToolPresentation } from './acp-turn-normalizer'

/** The Antigravity CLI's command. A managed install is found under this name too (`cli-env.ts`). */
export const ANTIGRAVITY_COMMAND = 'agy'

/** `agy acp` for one profile. `--login` runs the sign-in that prints a Google link and reads a code (§7). */
export function antigravityArgs(profile: string, options: { login?: boolean } = {}): string[] {
  const args = ['acp', '--gemini-dir', profile, '--app-data-dir', ANTIGRAVITY_APP_DATA_DIR]
  if (options.login) args.push('--login')
  return args
}

// agy 1.5 answers `authenticate` with this internal error when it has no sign-in and no display.
const NO_BROWSER_PREFIX = 'No browser is available here'

/** Whether an error means the profile has no usable sign-in. */
export function isAntigravitySignInRequired(error: Error): boolean {
  return error instanceof AcpRequestError
    && (error.code === -32000 || (error.code === -32603 && error.message.startsWith(NO_BROWSER_PREFIX)))
}

const sessionMetaCapabilitySchema = z.looseObject({
  agentCapabilities: z.looseObject({
    _meta: z.looseObject({
      antigravity: z.looseObject({ systemPrompt: z.looseObject({ append: z.boolean().optional() }).optional() }).optional(),
    }).optional(),
  }).optional(),
})

/** The `session/new` `_meta` that appends Solus's instructions, when this `agy` takes them. */
export function antigravitySessionMeta(initializeResult: z.core.util.JSONType | undefined, systemPrompt: string | undefined): { antigravity: { systemPrompt: { append: string } } } | undefined {
  if (!systemPrompt) return undefined
  const parsed = sessionMetaCapabilitySchema.safeParse(initializeResult)
  const appends = parsed.success && parsed.data.agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true
  return appends ? { antigravity: { systemPrompt: { append: systemPrompt } } } : undefined
}

/** The name the Solus MCP server has in `session/new`; agy titles its tools after it. */
export const SOLUS_MCP_SERVER_NAME = 'solus'

// agy 1.5.8 and later title a call "Run mcp_<server>_<tool>"; earlier releases name no server.
const MCP_TITLE = new RegExp(`^Run mcp_${SOLUS_MCP_SERVER_NAME}_(?<tool>[A-Za-z0-9_]+)\\??$`)
// call_mcp_tool is the one call whose input names a server and a tool.
const PROXIED_MCP_TITLE = /^MCP Tool (?<tool>[A-Za-z0-9_]+)\??$/

const proxiedInputSchema = z.looseObject({ ServerName: z.string(), ToolName: z.string(), Arguments: z.json().optional() })

/** A Solus tool called through agy shows as the same card a Claude session shows (`mcp__solus__<tool>`). */
export function nameAntigravityTool(toolCall: AcpToolCall): AcpToolPresentation | null {
  const subagent = presentAntigravitySubagentTool(toolCall)
  if (subagent) return subagent
  const title = toolCall.title?.trim() ?? ''
  const proxied = PROXIED_MCP_TITLE.exec(title)?.groups?.tool
  if (proxied) {
    const input = proxiedInputSchema.safeParse(toolCall.rawInput)
    if (!input.success || input.data.ServerName !== SOLUS_MCP_SERVER_NAME || input.data.ToolName !== proxied) return null
    const presentation: AcpToolPresentation = { toolName: `mcp__solus__${proxied}` }
    if (input.data.Arguments !== undefined) presentation.toolInput = JSON.stringify(input.data.Arguments)
    return presentation
  }
  const tool = MCP_TITLE.exec(title)?.groups?.tool
  if (!tool) return null
  const presentation: AcpToolPresentation = { toolName: `mcp__solus__${tool}` }
  if (toolCall.rawInput !== undefined) presentation.toolInput = JSON.stringify(toolCall.rawInput)
  return presentation
}

// agy 1.5.0 steers a running turn with the next `session/prompt`; 1.4 queued it as a new turn.
const PROMPT_STEERING_RELEASE = [1, 5, 0] as const

/** Whether this agy joins a prompt sent during a turn to that turn. */
export function antigravitySteersWithPrompt(initialize: AcpInitializeResult): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(initialize.agentInfo?.version?.trim() ?? '')
  if (!match) return false
  const version = [Number(match[1]), Number(match[2]), Number(match[3])]
  for (const [index, part] of PROMPT_STEERING_RELEASE.entries()) {
    if (version[index]! !== part) return version[index]! > part
  }
  return true
}

/** A permission request whose tool call id starts with this is a question from the agent (§5.3). */
export function isAntigravityQuestion(toolCallId: string): boolean {
  return toolCallId.startsWith('interaction_')
}

/** What a person reads when a turn has no usable Antigravity sign-in. */
export const ANTIGRAVITY_SIGN_IN_MESSAGE = 'Sign in to Google Antigravity on this host to continue. Type /login to sign in.'

/** The host login's turns have no seat yet; a member's seat names their own profile (§7). */
function antigravityProfileOf(request: AgentRunRequest): string {
  return request.seat?.home ?? hostAntigravityProfile()
}

const updateStepsInputSchema = z.object({ steps: z.array(z.json()) })
const updateStepSchema = z.object({ title: z.string(), status: z.string().optional().catch(undefined) })

/** A step's status in Solus's task list; a status agy may add later reads as not started. */
function todoStatusOf(status: string | undefined): TodoItem['status'] {
  if (status === 'done' || status === 'completed') return 'completed'
  return status === 'in_progress' ? 'in_progress' : 'pending'
}

/**
 * agy reports its checklist only as `update_steps` tool calls, never as an ACP
 * `plan` (T3 Code, `makeAntigravityUpdateStepsPlans` in `AntigravityProtocol.ts`).
 */
export const antigravityStepsTool: AcpStepsTool = {
  isStepsCall: (toolCall) => toolCall.title === 'Run update_steps' && (toolCall.kind === undefined || toolCall.kind === 'other'),
  stepsOf(rawInput) {
    const input = updateStepsInputSchema.safeParse(rawInput)
    if (!input.success) return null
    return input.data.steps.flatMap((value) => {
      const step = updateStepSchema.safeParse(value)
      return step.success ? [{ content: step.data.title, status: todoStatusOf(step.data.status) }] : []
    })
  },
}

/** Antigravity for the ACP backend (`acp-backend.ts`). */
export const antigravityAgent: AcpAgent = {
  id: 'antigravity',
  label: 'Google Antigravity',
  signInMessage: ANTIGRAVITY_SIGN_IN_MESSAGE,
  mcpServerName: SOLUS_MCP_SERVER_NAME,
  nameTool: nameAntigravityTool,
  stepsTool: antigravityStepsTool,
  isClientRead: (title) => title === 'Running client_view_file' || title === 'Run client_view_file?',
  isSignInRequired: isAntigravitySignInRequired,
  isQuestion: isAntigravityQuestion,
  sessionMeta: antigravitySessionMeta,
  steersWithPrompt: antigravitySteersWithPrompt,
  listCommands(workingDirectory, seat) {
    const profile = seat?.home ?? hostAntigravityProfile()
    if (profile === hostAntigravityProfile()) linkHostGeminiConfig(profile)
    return listAntigravitySkills(workingDirectory, profile)
  },
  watchTurnOutcome(request, threadId) {
    return watchAntigravityTurnOutcome(antigravityProfileOf(request), threadId)
  },
  launch(request) {
    const profile = antigravityProfileOf(request)
    const auth = antigravityAuthOf(profile)
    prepareAntigravityProfile(profile, auth)
    if (profile === hostAntigravityProfile()) linkHostGeminiConfig(profile)
    const base = request.seat?.launch ?? launchOptions()
    const env = antigravityEnvironment(base.env, profile, auth)
    const run = launchedProcess({ ...base, env }, ANTIGRAVITY_COMMAND, antigravityArgs(profile))
    const connectionKey = createHash('sha256').update(JSON.stringify({ profile, file: run.file, args: run.args, auth: auth.method, key: auth.apiKey ?? null, gcp: [auth.gcpProject, auth.gcpLocation] })).digest('hex')
    // Each launch unpacks about 1 GB into its temp folder. A process that runs as another user keeps the host's.
    const tempRoot = base.user ? null : join(profile, ANTIGRAVITY_APP_DATA_DIR, 'tmp')
    return { file: run.file, args: run.args, env: run.env, connectionKey, authMethod: auth.method, tempRoot }
  },
}

/**
 * The Google link `agy acp --login` prints on a line of its own; null until the
 * whole line has arrived. Only Google's own sign-in address is taken.
 */
export function antigravitySignInUrl(output: string): string | null {
  for (const line of output.split('\n').slice(0, -1)) {
    const url = line.trim()
    if (/^https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s]+$/.test(url) && url.length <= 16_384) return url
  }
  return null
}
