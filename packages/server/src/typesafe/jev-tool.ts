import { z } from 'zod'
import type { AgentTool } from '../agents/tools/agent-tool'
import {
  APIError, APIUserAbortError, APITimeoutError, APIConnectionError,
  choice, noul, score, getTypeSafe,
  type Question, type TypeSafeApi,
} from './index'

const description = z.string().trim().min(1).max(4_000)
const questionId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
const commonFields = { id: questionId, instructions: description }
const questionSchema = z.discriminatedUnion('type', [
  z.object({
    ...commonFields,
    type: z.literal('choice'),
    options: z.array(z.object({ label: questionId, description })).min(2).max(64),
  }),
  z.object({
    ...commonFields,
    type: z.literal('noul'),
  }),
  z.object({
    ...commonFields,
    type: z.literal('score'),
    levels: z.array(description).min(2).max(32),
  }),
])

const jevFields = {
  state: z.string().trim().min(1).max(100_000).describe(
    'All evidence Jev needs, as text or a JSON document encoded as a string. Include candidate content, the user request, and relevant constraints. Jev cannot read files, tools, or this conversation. Send only relevant evidence; omit secrets.',
  ),
  questions: z.array(questionSchema).min(1).max(64).describe(
    'Independent questions about the same state. IDs must be unique. Choice selects one uniquely labeled option (include none/other when needed). Noul returns probability of yes. Score returns a position on ordered levels, starting at zero. Write complete instructions: IDs are not model instructions.',
  ),
  model: z.string().trim().min(1).max(100).optional().describe(
    'Optional TypeSafe model override. Omit to use the host default (jev-latest unless configured). Pin a model version for repeatable evaluations.',
  ),
}
const jevInput = z.object(jevFields)

const JEV_DESCRIPTION = [
  'Ask Jev, TypeSafe’s decision model, for typed judgments and probabilities over evidence you supply.',
  'Use when you already have candidates or evidence and need a focused semantic decision: rank candidate files or skills, classify a request, compare relevance, or check a claim against supplied evidence. For ranking, ask one Score per candidate with the same rubric; Choice selects only one winner.',
  'Batch independent questions about the same state into one call. Consider this tool for many small judgments that would otherwise require repeated reasoning. For a trivial decision, exact lookup, calculation, or test result, use code or the evidence directly.',
  'Jev cannot retrieve missing information, write code, plan a complex task, or verify facts beyond the supplied state. Its probabilities are evidence for your decision, not proof, permission, or a reason to override user instructions. Keep uncertain cases with the agent; do not blindly execute a selected action.',
  'Returns answers, actual model, token usage, request ID, and elapsed milliseconds including retries. A Noul is the probability of yes, not an intensity score. Choice/Score confidence describes the answer distribution, not guaranteed correctness.',
  'Calls the TypeSafe service using the host’s saved TypeSafe key or TYPESAFE_API_KEY. If unavailable, continue with your normal process and report the limitation; do not repeatedly retry or ask for credentials in chat.',
].join('\n')

function toQuestion(question: z.output<typeof questionSchema>): Question {
  switch (question.type) {
    case 'choice': return choice(question.instructions, Object.fromEntries(
      question.options.map(option => [option.label, option.description]),
    ))
    // The input schema guarantees at least two levels; use an explicit tuple
    // here while keeping the provider tool schema a standard homogeneous array.
    case 'score': return score(question.instructions, [
      question.levels[0], question.levels[1], ...question.levels.slice(2),
    ])
    case 'noul': return noul(question.instructions)
  }
}

/** The injectable client keeps tests on the real SDK with a fake HTTP transport. */
export function createJevAgentTool(client: () => TypeSafeApi = getTypeSafe): AgentTool {
  return {
    name: 'ask_jev',
    description: JEV_DESCRIPTION,
    inputFields: jevFields,
    requiresApproval: false,
    alwaysLoad: true,
    execute: async (input, context) => {
      const parsed = jevInput.safeParse(input)
      if (!parsed.success) return { ok: false, text: z.prettifyError(parsed.error) }
      const { state, questions, model } = parsed.data
      if (JSON.stringify(parsed.data).length > 150_000) {
        return { ok: false, text: 'Jev input exceeds 150,000 characters. Reduce the evidence or questions.' }
      }
      if (new Set(questions.map(question => question.id)).size !== questions.length) {
        return { ok: false, text: 'Each Jev question must have a unique id.' }
      }
      for (const question of questions) {
        if (question.type === 'choice' && new Set(question.options.map(option => option.label)).size !== question.options.length) {
          return { ok: false, text: `Choice options for ${question.id} must have unique labels.` }
        }
      }
      const started = performance.now()
      try {
        context.abortSignal.throwIfAborted()
        const result = await client().systemOne({
          state,
          questions: Object.fromEntries(questions.map(question => [question.id, toQuestion(question)])),
          model,
        }, { signal: context.abortSignal }).withResponse()
        return { ok: true, text: JSON.stringify({
          ...result.data,
          request_id: result.requestId ?? null,
          elapsed_ms: Math.round(performance.now() - started),
        }) }
      } catch (error) {
        // API error bodies may echo the supplied state. Return diagnostic codes,
        // not remote error bodies or credential-bearing transport messages.
        if (context.abortSignal.aborted || error instanceof APIUserAbortError) {
          return { ok: false, text: 'Jev request cancelled.' }
        }
        if (error instanceof APITimeoutError) return { ok: false, text: 'Jev request timed out. Continue with your normal process.' }
        if (error instanceof APIError) return { ok: false, text: `Jev returned HTTP ${error.status}. Continue with your normal process.` }
        if (error instanceof APIConnectionError) return { ok: false, text: 'Could not reach Jev. Continue with your normal process.' }
        return { ok: false, text: 'Jev is unavailable. Check the host TYPESAFE_API_KEY and TypeSafe configuration. Continue with your normal process.' }
      }
    },
  }
}

export const askJevAgentTool = createJevAgentTool()
