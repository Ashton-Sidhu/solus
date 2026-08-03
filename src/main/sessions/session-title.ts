import { z } from 'zod'
import { TextGenerator } from '../agents/text-generator'
import type { AgentDispatcher } from '../agents/agent-runner'
import type { AgentTool } from '../agents/tools/agent-tool'
import { findOnPath, getCliPath } from '../cli-env'
import { createLogger } from '../logger'
import { AGENT_BIN, type AgentId, type ReasoningEffort } from '../../shared/types'

const log = createLogger('main', 'session-title')

const MAX_TITLE_LENGTH = 48

/** The cheapest model each backend has that still writes a readable phrase, at
 *  its lowest reasoning setting — naming a thread must never cost a real turn. */
const TITLE_MODELS: Record<'codex' | 'claude-code', { model: string; reasoningEffort: ReasoningEffort }> = {
  codex: { model: 'gpt-5.6-luna', reasoningEffort: 'low' },
  'claude-code': { model: 'claude-haiku-4-5-20251001', reasoningEffort: 'low' },
}

function buildSessionTitlePrompt(promptText: string): string {
  return [
    'Summarize the input into a chat thread name.',
    `Submit it by calling ${SESSION_TITLE_TOOL_NAME} exactly once — that call is your whole answer.`,
    'The name is 2-5 words in Title Case naming the concrete task.',
    'Do not explain, reason, acknowledge, mention the task, or write any prose.',
    'Focus on the distinctive subject, not generic verbs like "implement", "help", or "fix".',
    'No quotes, no punctuation at the end, no markdown.',
    'Examples: Dark Mode Toggle, Auth Redirect Loop, Session Renaming',
    'Follow these instructions exactly, no exceptions.',
    promptText,
  ].join('\n')
}

const SESSION_TITLE_TOOL_NAME = 'submit_session_title'

/** The name arrives as this tool's arguments, so a model that likes to answer in
 *  prose still hands back one clean field instead of a paragraph to scrape. */
function createSessionTitleTool(capture: (title: string) => void): AgentTool {
  return {
    name: SESSION_TITLE_TOOL_NAME,
    description: [
      'Submit the name for this chat thread. Call this EXACTLY ONCE, as your only action —',
      'the argument IS the answer, so do not also write it as prose.',
    ].join('\n'),
    inputShape: {
      title: z.string().describe('2-5 words in Title Case naming the task, e.g. "Auth Redirect Loop".'),
    },
    requiresApproval: false,
    execute: async (args) => {
      const title = typeof args.title === 'string' ? args.title : ''
      if (!title.trim()) return { ok: false, text: 'title must be a non-empty string' }
      capture(title)
      return { ok: true, text: `Named the session "${title}".` }
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

function isInstalled(agentId: AgentId): boolean {
  return !!findOnPath(AGENT_BIN[agentId], getCliPath())
}

export type TitleBackend = keyof typeof TITLE_MODELS

/** Codex wins when it's installed — its small model is the cheapest of the two
 *  — and Claude's Haiku is the fallback. Null when neither CLI is present. */
function titleBackend(): TitleBackend | null {
  if (isInstalled('codex')) return 'codex'
  if (isInstalled('claude-code')) return 'claude-code'
  return null
}

/**
 * Name a session from the prompt that started it. Returns null when there's
 * nothing to name, no backend to name it with, or the model answers with
 * something unusable; callers keep the prompt-derived title.
 */
export async function generateSessionTitle(
  dispatcher: AgentDispatcher,
  promptText: string,
  cwd: string,
): Promise<string | null> {
  const trimmed = promptText.trim()
  if (!trimmed) return null
  const provider = titleBackend()
  if (!provider) {
    log.warn('session_title_no_backend')
    return null
  }
  return generateTitleWith(dispatcher, provider, trimmed, cwd)
}

/** The naming run itself, against an already-chosen backend. */
export async function generateTitleWith(
  dispatcher: AgentDispatcher,
  provider: TitleBackend,
  trimmed: string,
  cwd: string,
): Promise<string | null> {
  const { model, reasoningEffort } = TITLE_MODELS[provider]
  let submitted: string | null = null
  let output = ''
  try {
    output = await new TextGenerator(dispatcher).generate({
      provider,
      cwd,
      prompt: buildSessionTitlePrompt(trimmed),
      model,
      reasoningEffort,
      tools: [createSessionTitleTool((title) => { submitted = title })],
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
  const title = sanitizeTitle(submitted ?? output)
  log.info('session_title_generated', { provider, model, structured: !!submitted, titled: !!title })
  return title
}
