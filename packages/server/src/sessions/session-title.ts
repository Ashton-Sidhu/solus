import { z } from 'zod'
import { TextGenerator } from '../agents/text-generator'
import type { AgentDispatcher } from '../agents/agent-runner'
import type { AgentTool } from '../agents/tools/agent-tool'
import { findOnPath, getCliPath } from '../cli-env'
import { createLogger } from '../logger'
import {
  AGENT_BIN,
  type AgentId,
  type ReasoningEffort,
  type SessionGeneratedMetadata,
  type SessionMetadataAttachment,
  type SessionMetadataGenerationContext,
} from '@solus/contracts/types'
import { resolveTextGenerationModel } from '../server/settings'
import { resolvePromptImages } from '../agents/prompt-image-refs'

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

function attachmentPromptLines(attachments: SessionMetadataAttachment[] | undefined): string[] {
  if (!attachments?.length) return []
  return [
    '',
    'Attachment metadata:',
    ...attachments.slice(0, 8).map((attachment) => {
      const name = attachment.name.replace(/[\r\n]+/g, ' ').slice(0, 200)
      const details = [attachment.type, attachment.mimeType, attachment.size !== undefined ? `${attachment.size} bytes` : undefined]
        .filter(Boolean)
        .join(', ')
      return `- ${name} (${details})`
    }),
  ]
}

function buildSessionMetadataPrompt(
  promptText: string,
  attachments?: SessionMetadataAttachment[],
): string {
  return [
    'Generate a title that will help the user recognize this Solus session weeks later.',
    `Submit both by calling ${SESSION_METADATA_TOOL_NAME} exactly once — that call is your whole answer.`,
    '',
    'Before answering, silently reduce the request to:',
    '- Subject: What system, feature, or problem is this really about?',
    '- Outcome: What does the user ultimately want to understand or change?',
    '- Incidental instructions: What only describes how the agent should do the work?',
    '',
    'Title the subject and outcome. Discard incidental instructions.',
    '',
    'Title rules:',
    '- 3-8 words, fewer than 40 characters.',
    '- Use a compact noun phrase or clear action phrase.',
    '- Capture the umbrella goal when the request lists several symptoms or steps.',
    '- Name the product change, not the mock, plan, report, branch, or PR used to produce it.',
    '- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.',
    '- For reviews, name what is being reviewed and the relevant concern. Avoid generic titles such as "Review PR 123" when the input reveals the subject.',
    '- For research, name the question domain rather than the requested research process.',
    '- Do not claim the work is complete.',
    '- Do not copy and truncate the user\'s message.',
    '- Avoid project names already visible in the UI, quotes, labels, filler, and trailing punctuation.',
    '- Use attached images as primary context for UI issues.',
    '- When a URL or attachment is the only source of the subject, use available tools to inspect it directly.',
    '- Local git history is not evidence of what a linked PR or issue is about. Never title the session after branch names, commit messages, or merged commits found in the checkout.',
    '- If a linked PR or issue cannot be read, fall back to the user\'s stated action plus its number, such as "Take Over PR 8588". This is the one case where a PR or issue number belongs in the title.',
    '',
    'Description rules:',
    'The description is a concise Markdown paragraph stating the requested outcome and important context.',
    'Write the description as the ticket itself, not as commentary about the input or the user.',
    'Do not explain, reason, acknowledge, mention the task, or write any prose.',
    'Follow these instructions exactly, no exceptions.',
    '',
    'User message:',
    promptText,
    ...attachmentPromptLines(attachments),
  ].join('\n')
}

const SESSION_METADATA_TOOL_NAME = 'submit_session_metadata'

/** The name arrives as this tool's arguments, so a model that likes to answer in
 *  prose still hands back one clean field instead of a paragraph to scrape. */
function createSessionMetadataTool(capture: (metadata: SessionGeneratedMetadata) => void): AgentTool {
  return {
    name: SESSION_METADATA_TOOL_NAME,
    description: [
      'Submit the name and ticket description for this Solus session. Call this EXACTLY ONCE,',
      'as your only action — the arguments ARE the answer, so do not also write prose.',
    ].join('\n'),
    inputFields: {
      title: z.string().describe('3-8 words and fewer than 40 characters naming the durable subject and outcome.'),
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
  context?: SessionMetadataGenerationContext,
): Promise<SessionGeneratedMetadata | null> {
  const trimmed = promptText.trim()
  if (!trimmed) return null
  const selection = resolveTextGenerationModel()
  if (!isInstalled(selection.provider)) {
    log.warn('session_title_no_backend')
    return null
  }
  return generateMetadataWith(dispatcher, selection.provider, trimmed, cwd, selection.model, context)
}

/** The metadata run itself, against an already-chosen backend. */
export async function generateMetadataWith(
  dispatcher: AgentDispatcher,
  provider: MetadataBackend,
  trimmed: string,
  cwd: string,
  selectedModel?: string,
  context?: SessionMetadataGenerationContext,
): Promise<SessionGeneratedMetadata | null> {
  const { model: defaultModel, reasoningEffort } = METADATA_MODELS[provider]
  const model = selectedModel ?? defaultModel
  let submitted: SessionGeneratedMetadata | null = null
  let imageAttachments = context?.imageAttachments
  try {
    imageAttachments = await resolvePromptImages(context ?? {})
  } catch (err) {
    log.warn('session_title_attachment_failed', { error: String(err) })
  }
  try {
    await new TextGenerator(dispatcher).generate({
      provider,
      cwd,
      prompt: buildSessionMetadataPrompt(trimmed, context?.attachments),
      model,
      reasoningEffort,
      imageAttachments,
      tools: [createSessionMetadataTool((metadata) => { submitted = metadata })],
      unattended: true,
      // Linked context can require inspection before the structured submission.
      maxTurns: /https?:\/\//i.test(trimmed) || context?.attachments?.length ? 4 : 2,
      timeoutMs: 30_000,
    })
  } catch (err) {
    // Don't return here: a late stream error must not discard a name the model
    // already submitted through the tool.
    log.warn('session_title_failed', { provider, model, error: String(err) })
  }

  // The structured tool is the only naming path. Sanitize its fields because a
  // schema constrains their types, not the model's punctuation or length.
  const title = sanitizeTitle(submitted?.title ?? '')
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
