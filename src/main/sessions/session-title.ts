import { z } from 'zod'
import { TextGenerator } from '../agents/text-generator'
import type { AgentDispatcher } from '../agents/agent-runner'
import type { AgentTool } from '../agents/tools/agent-tool'
import { findOnPath, getCliPath } from '../cli-env'
import { createLogger } from '../logger'
import { AGENT_BIN, type AgentId, type ReasoningEffort, type SessionGeneratedMetadata } from '../../shared/types'
import { resolveTextGenerationModel } from '../server/settings'

const log = createLogger('main', 'session-title')

const MAX_TITLE_LENGTH = 48
const MAX_DESCRIPTION_LENGTH = 1_000

/** The cheapest model each backend has that still writes useful metadata, at
 * its lowest reasoning setting — scaffolding a thread must never cost a real turn. */
const METADATA_MODELS = {
  codex: { model: 'gpt-5.6-luna', reasoningEffort: 'low' },
  'claude-code': { model: 'claude-haiku-4-5-20251001', reasoningEffort: 'low' },
} satisfies { codex: { model: string; reasoningEffort: ReasoningEffort }; 'claude-code': { model: string; reasoningEffort: ReasoningEffort } }

const sessionMetadataSchema = z.object({
  title: z.string(),
  description: z.string(),
})

function buildSessionMetadataPrompt(promptText: string): string {
  return [
    'Summarize the input into a chat thread name and a ticket description.',
    `Submit both by calling ${SESSION_METADATA_TOOL_NAME} exactly once — that call is your whole answer.`,
    'The name is 4-7 words in Title Case naming the concrete task.',
    'The description is a concise Markdown paragraph stating the requested outcome and important context.',
    'Write the description as the ticket itself, not as commentary about the input or the user.',
    'Do not explain, reason, acknowledge, mention the task, or write any prose.',
    'Focus on the distinctive subject, not generic verbs like "implement", "help", or "fix".',
    'No quotes, no punctuation at the end, no markdown.',
    'Examples: Dark Mode Toggle, Auth Redirect Loop, Session Renaming',
    'Follow these instructions exactly, no exceptions.',
    promptText,
  ].join('\n')
}

const SESSION_METADATA_TOOL_NAME = 'submit_session_metadata'

/** The name arrives as this tool's arguments, so a model that likes to answer in
 *  prose still hands back one clean field instead of a paragraph to scrape. */
function createSessionMetadataTool(capture: (metadata: SessionGeneratedMetadata) => void): AgentTool {
  return {
    name: SESSION_METADATA_TOOL_NAME,
    description: [
      'Submit the name and ticket description for this chat thread. Call this EXACTLY ONCE,',
      'as your only action — the arguments ARE the answer, so do not also write prose.',
    ].join('\n'),
    inputFields: {
      title: z.string().describe('2-5 words in Title Case naming the task, e.g. "Auth Redirect Loop".'),
      description: z.string().describe('A concise Markdown ticket description of the requested outcome and context.'),
    },
    requiresApproval: false,
    execute: async (args) => {
      const parsed = sessionMetadataSchema.parse(args)
      const { title, description } = parsed
      if (!title.trim()) return { ok: false, text: 'title must be a non-empty string' }
      if (!description.trim()) return { ok: false, text: 'description must be a non-empty string' }
      capture({ title, description })
      return { ok: true, text: `Named the session "${title}" and described its ticket.` }
    },
  }
}

/** Strip the ways a chat model dresses up a one-line answer — fences, quotes,
 *  bullets, a "Title:" preamble — and keep the first line that survives. */
export function sanitizeTitle(raw: string): string | null {
  const line = raw
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*>]|\d+[.)])\s*/, '').replace(/[`*_#]/g, '').trim())
    .find((l) => l.length > 0)
  if (!line) return null
  const cleaned = line
    .replace(/^(?:title|name)\s*:\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.,;:!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  return cleaned.length > MAX_TITLE_LENGTH ? cleaned.slice(0, MAX_TITLE_LENGTH).trimEnd() : cleaned
}

function sanitizeDescription(raw: string): string | null {
  const cleaned = raw.trim()
  if (!cleaned) return null
  return cleaned.length > MAX_DESCRIPTION_LENGTH
    ? cleaned.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd()
    : cleaned
}

function isInstalled(agentId: AgentId): boolean {
  return !!findOnPath(AGENT_BIN[agentId], getCliPath())
}

export type MetadataBackend = keyof typeof METADATA_MODELS

/**
 * Name a session and describe its task from the opening prompt. Returns null
 * when no backend is available or the model omits either required field;
 * callers keep the prompt-derived title and empty task description.
 */
export async function generateSessionMetadata(
  dispatcher: AgentDispatcher,
  promptText: string,
  cwd: string,
): Promise<SessionGeneratedMetadata | null> {
  const trimmed = promptText.trim()
  if (!trimmed) return null
  const selection = resolveTextGenerationModel()
  if (!isInstalled(selection.provider)) {
    log.warn('session_title_no_backend')
    return null
  }
  return generateMetadataWith(dispatcher, selection.provider, trimmed, cwd, selection.model)
}

/** The metadata run itself, against an already-chosen backend. */
export async function generateMetadataWith(
  dispatcher: AgentDispatcher,
  provider: MetadataBackend,
  trimmed: string,
  cwd: string,
  selectedModel?: string,
): Promise<SessionGeneratedMetadata | null> {
  const { model: defaultModel, reasoningEffort } = METADATA_MODELS[provider]
  const model = selectedModel ?? defaultModel
  let submitted: SessionGeneratedMetadata | null = null
  let output = ''
  try {
    output = await new TextGenerator(dispatcher).generate({
      provider,
      cwd,
      prompt: buildSessionMetadataPrompt(trimmed),
      model,
      reasoningEffort,
      tools: [createSessionMetadataTool((metadata) => { submitted = metadata })],
      unattended: true,
      // One turn to call the tool, one to wrap up after its result.
      maxTurns: 2,
      timeoutMs: 30_000,
    })
  } catch (err) {
    // Don't return here: a late stream error must not discard a name the model
    // already submitted through the tool.
    log.warn('session_title_failed', { provider, model, error: String(err) })
  }

  // Sanitize either way — the tool constrains the shape of the answer, not the
  // model's taste for quotes, trailing periods, or an essay in one field.
  const title = sanitizeTitle(submitted?.title ?? output)
  const description = sanitizeDescription(submitted?.description ?? '')
  const metadata = title && description ? { title, description } : null
  log.info('session_metadata_generated', {
    provider,
    model,
    structured: !!submitted,
    titled: !!title,
    described: !!description,
  })
  return metadata
}
